// Canvas basemap. The selected place is always drawn under the centre of the
// glyph; changing place flies the projection there.

import { geoContains, geoNaturalEarth1, geoPath, geoGraticule10, type GeoProjection } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";

export interface WorldData {
  topology: Topology<{ countries: GeometryCollection }>;
  places: Record<string, { c: [number, number]; b: [number, number, number, number]; dot: 0 | 1 }>;
}

interface View {
  lon: number;
  lat: number;
  span: number; // degrees that should fit across the lens
}

const REGION_VIEWS: Record<number, View> = {
  900: { lon: 12, lat: 8, span: 0 },
  903: { lon: 18, lat: 2, span: 72 },
  935: { lon: 88, lat: 28, span: 95 },
  908: { lon: 18, lat: 53, span: 50 },
  904: { lon: -72, lat: -12, span: 75 },
  905: { lon: -100, lat: 50, span: 80 },
  909: { lon: 150, lat: -20, span: 70 },
};

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class WorldMap {
  private ctx: CanvasRenderingContext2D;
  private features: Feature<Geometry, null>[];
  private projection: GeoProjection = geoNaturalEarth1();
  private w = 0;
  private h = 0;
  private cx = 0;
  private cy = 0;
  private lens = 40;
  private view: View = { lon: 0, lat: 0, span: 0 };
  private anim = 0;
  private selected = new Set<number>();
  private compared = new Set<number>();
  private colors: Record<string, string> = {};
  private graticule = geoGraticule10();

  constructor(private canvas: HTMLCanvasElement, private world: WorldData, private onPick: (code: number) => void) {
    this.ctx = canvas.getContext("2d")!;
    const fc = feature(world.topology, world.topology.objects.countries) as unknown as { features: Feature<Geometry, null>[] };
    this.features = fc.features.filter((f) => f.id !== undefined);
    this.readColors();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.readColors();
      this.draw();
    });
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["ocean", "land", "border", "ink", "highlight", "rule", "female"]) this.colors[k] = cs.getPropertyValue(`--${k}`).trim();
  }

  resize(w: number, h: number, cx: number, cy: number, lens: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    Object.assign(this, { w, h, cx, cy, lens });
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  viewFor(code: number): View {
    if (REGION_VIEWS[code]) return REGION_VIEWS[code];
    const p = this.world.places[code];
    if (!p) return REGION_VIEWS[900];
    const [w, s, e, n] = p.b;
    let dLon = e - w;
    if (dLon < 0) dLon += 360;
    const span = Math.max(dLon * Math.cos((((s + n) / 2) * Math.PI) / 180), n - s);
    return { lon: p.c[0], lat: p.c[1], span: Math.min(Math.max(span, 7), 140) };
  }

  select(primary: number, compare: number | null, members: (code: number) => number[], animate: boolean) {
    this.selected = new Set(members(primary));
    this.compared = new Set(compare === null ? [] : members(compare));
    const target = this.viewFor(primary);
    cancelAnimationFrame(this.anim);
    if (!animate || this.w === 0) {
      this.view = target;
      this.draw();
      return;
    }
    const from = { ...this.view };
    let dLon = target.lon - from.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const fromScale = this.scaleFor(from), toScale = this.scaleFor(target);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - t0) / 950, 1);
      const k = ease(t);
      // zoom out a little mid-flight so long jumps read as travel
      const hop = Math.sin(Math.PI * k) * Math.min(Math.abs(dLon) / 180, 1) * 0.6;
      this.view = { lon: from.lon + dLon * k, lat: from.lat + (target.lat - from.lat) * k, span: 0 };
      this.draw(Math.exp(Math.log(fromScale) + (Math.log(toScale) - Math.log(fromScale)) * k - hop));
      if (t < 1) this.anim = requestAnimationFrame(step);
      else this.view = target;
    };
    this.anim = requestAnimationFrame(step);
  }

  private scaleFor(v: View) {
    const world = Math.min(this.w / 5.2, this.h / 2.6);
    if (!v.span) return world;
    return Math.max((this.lens * 2.1 * 180) / Math.PI / v.span, world * 0.9);
  }

  private project(scale: number) {
    const p = this.projection.rotate([-this.view.lon, 0]).scale(scale).translate([0, 0]);
    const [x, y] = p([this.view.lon, this.view.lat]) ?? [0, 0];
    p.translate([this.cx - x, this.cy - y]);
    return p;
  }

  draw(scale = this.scaleFor(this.view)) {
    const { ctx, colors: c } = this;
    const p = this.project(scale);
    const path = geoPath(p, ctx);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.beginPath();
    path({ type: "Sphere" });
    ctx.fillStyle = c.ocean;
    ctx.fill();
    ctx.beginPath();
    path(this.graticule);
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.beginPath();
    for (const f of this.features) path(f);
    ctx.fillStyle = c.land;
    ctx.fill();
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 0.6;
    ctx.stroke();

    const sel = this.features.filter((f) => this.selected.has(Number(f.id)));
    if (sel.length && this.selected.size < 60) {
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
    if (cmp.length && this.compared.size < 60) {
      ctx.beginPath();
      for (const f of cmp) path(f);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // small states not in the 1:110m shapes are drawn as dots
    for (const [code, place] of Object.entries(this.world.places)) {
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
  }

  pick(e: PointerEvent) {
    const box = this.canvas.getBoundingClientRect();
    const x = e.clientX - box.left, y = e.clientY - box.top;
    const p = this.project(this.scaleFor(this.view));
    let best: number | null = null, bestD = 14;
    for (const [code, place] of Object.entries(this.world.places)) {
      if (!place.dot) continue;
      const xy = p(place.c);
      if (!xy) continue;
      const d = Math.hypot(xy[0] - x, xy[1] - y);
      if (d < bestD) (bestD = d), (best = Number(code));
    }
    if (best === null) {
      const lonlat = p.invert?.([x, y]);
      if (lonlat) best = Number(this.features.find((f) => geoContains(f, lonlat))?.id ?? NaN);
    }
    if (best !== null && Number.isFinite(best)) this.onPick(best);
  }
}
