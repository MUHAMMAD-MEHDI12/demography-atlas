// Canvas basemap with free navigation.
//   drag            move / rotate the world (with inertia)
//   wheel / pinch   smooth zoom around the pointer
//   double-tap      handled by the app: picks the country under the pointer
// The view is described by the point at the glyph's home position (lon, lat)
// and a projection scale. A single animation loop drives flights, inertia and
// zoom easing, and redraws at most once per frame.

import { geoContains, geoNaturalEarth1, geoPath, geoGraticule10, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";

export interface WorldData {
  topology: Topology<{ countries: GeometryCollection }>;
  places: Record<string, { c: [number, number]; b: [number, number, number, number]; dot: 0 | 1; area?: number }>;
}

/** A custom set of selectable areas drawn over the world (used by the Pakistan districts page). */
export interface MapLayer {
  features: Feature<Geometry, null>[];
  places: WorldData["places"];
  /** fill colour for an area, e.g. a choropleth; null uses the land colour */
  fill?: (id: number) => string | null;
  /** smallest span in degrees when framing an area */
  minSpan?: number;
  /** areas drawn for context in grey (not selectable) */
  inactive?: Feature<Geometry, null>[];
}

/** Extra lines drawn over the basemap: the supplied national outline and disputed areas. */
export interface MapExtras {
  outline?: Feature<Geometry, null>[];
  disputed?: { feature: Feature<Geometry, null>; label: string; note?: string }[];
}

interface View {
  lon: number;
  lat: number;
  scale: number;
}

const REGION_VIEWS: Record<number, { lon: number; lat: number; span: number }> = {
  900: { lon: 12, lat: 8, span: 0 },
  903: { lon: 18, lat: 2, span: 72 },
  935: { lon: 88, lat: 28, span: 95 },
  908: { lon: 18, lat: 53, span: 50 },
  904: { lon: -72, lat: -12, span: 75 },
  905: { lon: -100, lat: 50, span: 80 },
  909: { lon: 150, lat: -20, span: 70 },
};

const DEG = 180 / Math.PI;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const wrapLon = (l: number) => ((((l + 180) % 360) + 360) % 360) - 180;
const clampLat = (l: number) => Math.max(-72, Math.min(80, l));

export class WorldMap {
  private ctx: CanvasRenderingContext2D;
  private features: Feature<Geometry, null>[];
  private context: Feature<Geometry, null>[] = [];
  private places: WorldData["places"];
  private projection: GeoProjection = geoNaturalEarth1();
  private graticule = geoGraticule10();
  private colors: Record<string, string> = {};
  private w = 0;
  private h = 0;
  private hx = 0; // glyph home position
  private hy = 0;
  private lens = 40;

  private view: View = { lon: 12, lat: 8, scale: 100 };
  private anchor: [number, number] = [12, 8]; // lon/lat the glyph is pinned to
  private home: View = { lon: 12, lat: 8, scale: 100 }; // view that centres the selection
  private selectedCode = 900;
  private selected = new Set<number>();
  private compared = new Set<number>();

  // animation state
  private raf = 0;
  private last = 0;
  private flight: { from: View; to: View; dLon: number; t0: number; ms: number } | null = null;
  /** duration of the most recent fly-to, so a tour can wait for it */
  lastFlightMs = 0;
  private velocity = { x: 0, y: 0 };
  private zoomTarget: { scale: number; x: number; y: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    world: WorldData,
    private onView: (x: number, y: number, offHome: boolean) => void,
    private layer?: MapLayer,
    private extras?: MapExtras,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    const fc = feature(world.topology, world.topology.objects.countries) as unknown as { features: Feature<Geometry, null>[] };
    const countries = fc.features.filter((f) => f.id !== undefined);
    this.features = layer ? layer.features : countries;
    this.context = layer ? fc.features : [];
    this.places = layer ? layer.places : world.places;
    this.readColors();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.readColors();
      this.requestFrame();
    });
  }

  private hatch(color: string): CanvasPattern | string {
    const size = 7;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const x = c.getContext("2d")!;
    x.strokeStyle = color;
    x.lineWidth = 1.1;
    x.beginPath();
    x.moveTo(0, size);
    x.lineTo(size, 0);
    x.moveTo(-1, 1);
    x.lineTo(1, -1);
    x.moveTo(size - 1, size + 1);
    x.lineTo(size + 1, size - 1);
    x.stroke();
    return this.ctx.createPattern(c, "repeat") ?? color;
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["ocean", "land", "border", "ink", "highlight", "rule", "panel"]) this.colors[k] = cs.getPropertyValue(`--${k}`).trim();
  }

  resize(w: number, h: number, hx: number, hy: number, lens: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const offset = this.w ? { x: this.hx, y: this.hy } : null;
    Object.assign(this, { w, h, hx, hy, lens });
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.home = this.viewFor(this.selectedCode);
    if (!offset) this.view = { ...this.home };
    this.view.scale = Math.max(this.view.scale, this.minScale());
    this.requestFrame();
  }

  // ---------- views -------------------------------------------------------
  private worldScale() {
    return Math.min(this.w / 5.2, this.h / 2.6);
  }
  private minScale() {
    return this.worldScale() * 0.75;
  }
  private maxScale() {
    return this.worldScale() * (this.layer ? 400 : 60);
  }

  private viewFor(code: number): View {
    const region = this.layer ? undefined : REGION_VIEWS[code];
    let lon: number, lat: number, span: number;
    if (region) ({ lon, lat, span } = region);
    else {
      const p = this.places[code];
      if (!p) return { lon: 12, lat: 8, scale: this.worldScale() };
      const [w, s, e, n] = p.b;
      const dLon = (e - w + 360) % 360 || 1;
      [lon, lat] = p.c;
      span = Math.min(Math.max(Math.max(dLon * Math.cos(((s + n) / 2) / DEG), n - s), this.layer?.minSpan ?? 7), 140);
    }
    const scale = span ? Math.max((this.lens * 2.1 * DEG) / span, this.worldScale() * 0.9) : this.worldScale();
    return { lon, lat, scale };
  }

  private anchorFor(code: number): [number, number] {
    const region = this.layer ? undefined : REGION_VIEWS[code];
    if (region) return [region.lon, region.lat];
    return this.places[code]?.c ?? [12, 8];
  }

  // ---------- public navigation ------------------------------------------------
  /**
   * Select a place. With `stay`, the map keeps its position and only the chart
   * moves to the place (used for double-click); the map still flies if the place
   * is off screen.
   */
  select(primary: number, compare: number | null, members: (code: number) => number[], animate: boolean, stay = false, durationMs?: number) {
    const moved = primary !== this.selectedCode;
    this.lastFlightMs = 0;
    this.selectedCode = primary;
    this.selected = new Set(members(primary));
    this.compared = new Set(compare === null ? [] : members(compare));
    this.anchor = this.anchorFor(primary);
    this.home = this.viewFor(primary);
    if (stay && this.w && this.onScreen(this.anchor)) {
      this.stop();
      this.requestFrame();
    } else if (moved || !this.w) this.flyTo(this.home, animate, durationMs);
    else this.requestFrame();
  }

  private onScreen(lonlat: [number, number]) {
    const xy = this.project()(lonlat);
    const m = 30;
    return !!xy && xy[0] > m && xy[0] < this.w - m && xy[1] > m && xy[1] < this.h - m;
  }

  /** Colours changed (e.g. a new choropleth): redraw. */
  repaint() {
    this.readColors();
    this.requestFrame();
  }

  /** Redraw and report the chart position again. */
  refresh() {
    this.requestFrame();
  }

  /** Fly back so the selected place sits under the glyph again. */
  recenter(animate = true) {
    this.home = this.viewFor(this.selectedCode);
    this.flyTo(this.home, animate);
  }

  flyTo(target: View, animate: boolean, durationMs?: number) {
    this.stop();
    if (!animate || !this.w) {
      this.lastFlightMs = 0;
      this.view = { ...target };
      this.requestFrame();
      return;
    }
    let dLon = target.lon - this.view.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    // every flight takes 1.5 seconds
    const ms = durationMs ?? 1500;
    this.lastFlightMs = ms;
    this.flight = { from: { ...this.view }, to: target, dLon, t0: performance.now(), ms };
    this.requestFrame();
  }

  /** Stop flights, inertia and zoom easing (e.g. when the user grabs the map). */
  stop() {
    this.flight = null;
    this.velocity = { x: 0, y: 0 };
    this.zoomTarget = null;
  }

  /** Move the map by a pixel offset, as when dragging. */
  panBy(dx: number, dy: number) {
    if (!dx && !dy) return;
    const p = this.project();
    const ll = p.invert?.([this.hx - dx, this.hy - dy]);
    if (ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1]) && Math.abs(ll[1]) < 89) {
      this.view.lon = wrapLon(ll[0]);
      this.view.lat = clampLat(ll[1]);
    } else {
      this.view.lon = wrapLon(this.view.lon - (dx / (this.view.scale * 0.8707)) * DEG);
      this.view.lat = clampLat(this.view.lat + (dy / this.view.scale) * DEG);
    }
    this.requestFrame();
  }

  /** Release a drag with a velocity in px per ms. */
  fling(vx: number, vy: number) {
    const speed = Math.hypot(vx, vy);
    if (speed < 0.05 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const max = 3;
    const k = speed > max ? max / speed : 1;
    this.velocity = { x: vx * k, y: vy * k };
    this.requestFrame();
  }

  /** Zoom by a factor around a screen point; eased unless immediate. */
  zoomAt(factor: number, x: number, y: number, immediate = false) {
    this.flight = null;
    const base = this.zoomTarget?.scale ?? this.view.scale;
    const scale = Math.min(Math.max(base * factor, this.minScale()), this.maxScale());
    if (immediate) {
      this.zoomTarget = null;
      this.applyZoom(scale, x, y);
      this.requestFrame();
    } else {
      this.zoomTarget = { scale, x, y };
      this.requestFrame();
    }
  }

  private applyZoom(scale: number, x: number, y: number) {
    const before = this.project().invert?.([x, y]);
    this.view.scale = scale;
    if (!before) return;
    const after = this.project()(before);
    if (after) this.panBy(x - after[0], y - after[1]);
  }

  /** The place under a screen point: small-state dots first, then shapes. */
  pickAt(x: number, y: number): number | null {
    const p = this.project();
    let best: number | null = null;
    let bestD = 14;
    for (const [code, place] of Object.entries(this.places)) {
      if (!place.dot) continue;
      const xy = p(place.c);
      if (!xy) continue;
      const d = Math.hypot(xy[0] - x, xy[1] - y);
      if (d < bestD) (bestD = d), (best = Number(code));
    }
    if (best !== null) return best;
    const ll = p.invert?.([x, y]);
    if (!ll) return null;
    const hit = this.features.find((f) => geoContains(f, ll));
    return hit ? Number(hit.id) : null;
  }

  // ---------- frame loop -----------------------------------------------------------
  private requestFrame() {
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number) {
    const dt = Math.min(now - this.last, 48);
    this.last = now;
    let active = false;

    if (this.flight) {
      const f = this.flight;
      const t = Math.min((now - f.t0) / f.ms, 1);
      const k = easeInOut(t);
      // lift out a little mid-flight on long journeys, like a camera hop
      const hop = Math.sin(Math.PI * k) * Math.min(Math.hypot(f.dLon, f.to.lat - f.from.lat) / 120, 1) * 0.7;
      const ls = Math.log(f.from.scale) + (Math.log(f.to.scale) - Math.log(f.from.scale)) * k - hop;
      this.view = {
        lon: wrapLon(f.from.lon + f.dLon * k),
        lat: f.from.lat + (f.to.lat - f.from.lat) * k,
        scale: Math.max(Math.exp(ls), this.minScale()),
      };
      if (t >= 1) this.flight = null;
      else active = true;
    }

    if (this.velocity.x || this.velocity.y) {
      this.panBy(this.velocity.x * dt, this.velocity.y * dt);
      const decay = Math.exp(-dt / 325); // friction
      this.velocity.x *= decay;
      this.velocity.y *= decay;
      if (Math.hypot(this.velocity.x, this.velocity.y) < 0.01) this.velocity = { x: 0, y: 0 };
      else active = true;
    }

    if (this.zoomTarget) {
      const z = this.zoomTarget;
      const k = 1 - Math.exp(-dt / 90);
      const ls = Math.log(this.view.scale) + (Math.log(z.scale) - Math.log(this.view.scale)) * k;
      this.applyZoom(Math.exp(ls), z.x, z.y);
      if (Math.abs(Math.log(z.scale / this.view.scale)) < 0.002) {
        this.applyZoom(z.scale, z.x, z.y);
        this.zoomTarget = null;
      } else active = true;
    }

    this.draw();
    this.raf = active ? requestAnimationFrame((t) => this.frame(t)) : 0;
  }

  private project(scale = this.view.scale) {
    const p = this.projection.rotate([-this.view.lon, 0]).scale(scale).translate([0, 0]);
    const [x, y] = p([this.view.lon, this.view.lat]) ?? [0, 0];
    p.translate([this.hx - x, this.hy - y]);
    return p;
  }

  private draw() {
    if (!this.w) return;
    const { ctx, colors: c } = this;
    const p = this.project();
    const path = geoPath(p, ctx);
    ctx.fillStyle = c.ocean;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = c.ocean;
    ctx.fill();
    ctx.beginPath();
    path(this.graticule);
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 0.5;
    ctx.stroke();

    if (this.context.length) {
      ctx.beginPath();
      for (const f of this.context) path(f);
      ctx.fillStyle = c.land;
      ctx.fill();
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
    if (this.layer?.inactive?.length) {
      ctx.beginPath();
      for (const f of this.layer.inactive) path(f);
      ctx.fillStyle = c.rule;
      ctx.fill();
    }
    const fill = this.layer?.fill;
    if (fill) {
      for (const f of this.features) {
        ctx.beginPath();
        path(f);
        ctx.fillStyle = fill(Number(f.id)) ?? c.land;
        ctx.fill();
      }
      ctx.beginPath();
      for (const f of this.features) path(f);
    } else {
      ctx.beginPath();
      for (const f of this.features) path(f);
      ctx.fillStyle = c.land;
      ctx.fill();
    }
    ctx.strokeStyle = c.border;
    ctx.lineWidth = fill ? 0.5 : 0.6;
    ctx.stroke();

    const sel = this.features.filter((f) => this.selected.has(Number(f.id)));
    if (sel.length) {
      ctx.beginPath();
      for (const f of sel) path(f);
      ctx.fillStyle = c.highlight;
      ctx.globalAlpha = 0.5;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
    const cmp = this.features.filter((f) => this.compared.has(Number(f.id)));
    if (cmp.length) {
      ctx.beginPath();
      for (const f of cmp) path(f);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // disputed areas supplied with the boundary files: hatched, with a label
    for (const d of this.extras?.disputed ?? []) {
      ctx.beginPath();
      path(d.feature);
      ctx.fillStyle = this.hatch(c.border);
      ctx.fill();
      ctx.strokeStyle = c.ink;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([5, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const box = path.bounds(d.feature);
      const w = box[1][0] - box[0][0];
      if (w > 70) {
        const cx = (box[0][0] + box[1][0]) / 2, cy = (box[0][1] + box[1][1]) / 2;
        ctx.textAlign = "center";
        ctx.fillStyle = c.ink;
        ctx.font = `600 ${Math.min(15, Math.max(10, w / 14)).toFixed(0)}px "IBM Plex Sans Condensed", sans-serif`;
        ctx.fillText(d.label, cx, cy);
        if (d.note && w > 150) {
          ctx.globalAlpha = 0.75;
          ctx.font = `${Math.min(12, Math.max(9, w / 20)).toFixed(0)}px "IBM Plex Sans Condensed", sans-serif`;
          ctx.fillText(d.note, cx, cy + 15);
          ctx.globalAlpha = 1;
        }
      }
    }
    // national outline from the supplied boundary file
    if (this.extras?.outline?.length) {
      ctx.beginPath();
      for (const f of this.extras.outline) path(f);
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    for (const [code, place] of Object.entries(this.places)) {
      if (!place.dot) continue;
      const xy = p(place.c);
      if (!xy || xy[0] < -10 || xy[0] > this.w + 10 || xy[1] < -10 || xy[1] > this.h + 10) continue;
      const isSel = this.selected.has(Number(code));
      ctx.beginPath();
      ctx.arc(xy[0], xy[1], isSel ? 4 : 2, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? c.highlight : c.border;
      ctx.fill();
      if (isSel || this.compared.has(Number(code))) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    const a = p(this.anchor) ?? [this.hx, this.hy];
    const scaleDrift = Math.abs(Math.log(this.view.scale / this.home.scale));
    this.onView(a[0], a[1], Math.hypot(a[0] - this.hx, a[1] - this.hy) > 40 || scaleDrift > 0.35);
  }
}
