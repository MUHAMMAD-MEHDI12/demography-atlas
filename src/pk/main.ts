import "../styles.css";
import "./pk.css";
import { Glyph, type ArmSpec, type ArmValues, type ReadoutRow } from "../glyph";
import { WorldMap, type WorldData } from "../map";
import { ChartMotion } from "../motion";
import { fmt, compact } from "../format";
import { SITE } from "../site";
import { loadPakistan, shapes, breaks, classOf, ramp, value, INDICATORS, type District, type Indicator, type PakistanData } from "./data";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const int = (v: number | null) => (v === null || !Number.isFinite(v) ? "no data" : Math.round(v).toLocaleString("en"));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const GROUPS = 16;

async function loadWorld(): Promise<WorldData> {
  if (window.__WORLD__) return window.__WORLD__;
  const res = await fetch(`${import.meta.env.BASE_URL}data/world.json`);
  if (!res.ok) throw new Error(`The map could not be loaded (HTTP ${res.status}).`);
  return res.json();
}

declare global {
  interface Window {
    __WORLD__?: WorldData;
  }
}

function arms(labels: string[]): ArmSpec[] {
  return [
    { key: "overall", title: "All residents", labels, rotate: -60, groups: GROUPS, step: 0.25, thickness: 0.19, max: 15, ticks: [5, 10], symmetric: false, adaptive: true },
    { key: "urban", title: "Urban", emptyText: "No urban population", labels, rotate: 60, groups: GROUPS, step: 0.25, thickness: 0.19, max: 15, ticks: [5, 10], symmetric: false, adaptive: true },
    { key: "rural", title: "Rural", emptyText: "No rural population", labels, rotate: 180, groups: GROUPS, step: 0.15, thickness: 0.115, max: 15, ticks: [5, 10], symmetric: false },
  ];
}

const emptyValues = (): ArmValues => ({
  overall: [new Float64Array(GROUPS), new Float64Array(GROUPS)],
  urban: [new Float64Array(GROUPS), new Float64Array(GROUPS)],
  rural: [new Float64Array(GROUPS), new Float64Array(GROUPS)],
});

function valuesOf(d: District, out: ArmValues) {
  for (const k of ["overall", "urban", "rural"] as const) {
    out[k][0].set(d.age[k].m);
    out[k][1].set(d.age[k].f);
  }
}

class PakistanApp {
  private units: District[];
  private byId = new Map<number, District>();
  private primary: District;
  private compare: District | null = null;
  private indicator: Indicator = "population";
  private colours: string[] = [];
  private cuts: number[] = [];
  private glyph: Glyph;
  private map: WorldMap;
  private motion = new ChartMotion(() => reducedMotion.matches);
  private target = emptyValues();
  private shown = emptyValues();
  private cmpTarget = emptyValues();
  private cmpShown = emptyValues();
  private anchorTarget = { x: 0, y: 0 };
  private chartDrag: { dx: number; dy: number; id: number } | null = null;
  private chartMoved = false;
  private raf = 0;
  private last = 0;
  private pickerMode: "place" | "compare" = "place";
  private detailsTab: "district" | "all" = "district";
  private sort: { key: string; dir: number } = { key: "population", dir: -1 };
  private csv: { name: string; rows: (string | number)[][] } = { name: "", rows: [] };
  private rankByPop = new Map<number, number>();

  constructor(private data: PakistanData, world: WorldData) {
    this.units = data.units;
    for (const u of this.units) this.byId.set(u.id, u);
    [...this.units].sort((a, b) => b.population - a.population).forEach((u, i) => this.rankByPop.set(u.id, i + 1));

    const hash = new URLSearchParams(location.hash.slice(1));
    const find = (s: string | null) => (s ? this.units.find((u) => slug(u.name) === s) : undefined);
    this.primary = find(hash.get("d")) ?? this.units.find((u) => u.name === "Lahore")!;
    this.compare = find(hash.get("vs")) ?? null;

    const { districts, inactive } = shapes(data);
    const places: WorldData["places"] = {};
    for (const u of this.units) places[u.id] = { c: u.center, b: u.bounds, dot: 0 };
    this.recolour();

    this.glyph = new Glyph($<HTMLElement>("glyph") as unknown as SVGSVGElement, arms(data.ageLabels), (row, x, y) => this.tooltip(row, x, y));
    this.map = new WorldMap(
      $<HTMLCanvasElement>("map"),
      world,
      (x, y, offHome) => {
        this.anchorTarget = { x, y };
        $("recenter").hidden = !offHome;
        if (this.chartDrag) return;
        if (this.motion.active) {
          this.motion.follow(x, y);
          this.kick();
        } else {
          this.motion.snap(x, y);
          this.glyph.setAnchor(x, y);
          this.placeBadge();
        }
      },
      {
        features: districts,
        inactive,
        places,
        minSpan: 1.4,
        fill: (id) => {
          const u = this.byId.get(id);
          if (!u) return null;
          const v = value(u, this.indicator);
          return Number.isFinite(v) ? this.colours[classOf(v, this.cuts)] : null;
        },
      },
    );

    this.bindStage();
    this.bindControls();
    this.buildPicker();
    this.renderSiteInfo();
    new ResizeObserver(() => this.resize()).observe($("stage"));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.recolour();
      this.map.repaint();
      this.renderLegend();
    });
    this.resize();
    this.update(false);
    $("status").hidden = true;
  }

  // ---------- state -------------------------------------------------------------------
  private setPrimary(u: District, mode: "fly" | "stay" | "drag" = "fly") {
    if (this.compare?.id === u.id) this.compare = null;
    this.primary = u;
    if (mode === "stay") this.motion.active = true;
    this.update(true, mode !== "fly");
  }

  private setCompare(u: District | null) {
    this.compare = u && u.id !== this.primary.id ? u : null;
    if (this.compare) for (const k of ["overall", "urban", "rural"]) for (const i of [0, 1] as const) this.cmpShown[k][i].set(this.shown[k][i]);
    this.update(true, true);
  }

  private update(animate: boolean, stay = false) {
    const p = this.primary, c = this.compare;
    $("place-name").textContent = p.name;
    $("place-region").textContent = `${p.division} division, ${p.province}`;
    $("recenter-name").textContent = p.name;
    $("compare-btn").textContent = c ? `vs ${c.name}` : "Compare";
    $("compare-btn").classList.toggle("is-on", !!c);
    $("compare-clear").hidden = !c;
    $("legend-cmp").hidden = !c;
    $("legend-cmp-name").textContent = c?.name ?? "";
    $("census-sub").textContent = p.age.detail === "broad" ? "Broad age groups from tehsil tables" : "Pakistan Bureau of Statistics";
    valuesOf(p, this.target);
    if (c) valuesOf(c, this.cmpTarget);
    this.map.select(p.id, c?.id ?? null, (id) => [id], animate && !reducedMotion.matches, stay);
    this.renderStats();
    this.renderRanking();
    if ($<HTMLDialogElement>("details").open) this.renderDetails();
    const params = new URLSearchParams({ d: slug(p.name) });
    if (c) params.set("vs", slug(c.name));
    try {
      history.replaceState(null, "", `#${params}`);
    } catch {
      /* ignore */
    }
    this.kick();
  }

  // ---------- animation --------------------------------------------------------------------
  private kick() {
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number) {
    const dt = Math.min(now - this.last, 64);
    this.last = now;
    const k = reducedMotion.matches ? 1 : 1 - Math.exp(-dt / 120);
    let moving = this.approach(this.shown, this.target, k);
    if (this.compare) moving = this.approach(this.cmpShown, this.cmpTarget, k) || moving;
    if (this.motion.active) {
      moving = this.motion.step(dt) || moving;
      this.glyph.setAnchor(this.motion.x, this.motion.y);
      this.glyph.setMotion(this.motion.tilt, this.motion.lift);
    }
    this.glyph.set(this.shown, this.compare ? this.cmpShown : null);
    this.placeBadge();
    this.raf = moving ? requestAnimationFrame((t) => this.frame(t)) : 0;
  }

  private approach(shown: ArmValues, target: ArmValues, k: number) {
    let moving = false;
    for (const key of Object.keys(target)) {
      for (const side of [0, 1] as const) {
        const s = shown[key][side], t = target[key][side];
        for (let i = 0; i < s.length; i++) {
          const d = t[i] - s[i];
          if (Math.abs(d) > 0.002) (s[i] += d * k), (moving = true);
          else s[i] = t[i];
        }
      }
    }
    return moving;
  }

  private placeBadge() {
    const b = $("census-badge");
    b.style.transform = `translate(${(this.glyph.cx - b.offsetWidth / 2).toFixed(1)}px, ${(this.glyph.cy + this.glyph.pickerOffset).toFixed(1)}px)`;
  }

  private resize() {
    const stage = $("stage");
    const { width, height } = stage.getBoundingClientRect();
    if (!width || !height) return;
    const headH = (stage.querySelector(".head") as HTMLElement).offsetHeight;
    const legend = stage.querySelector(".legend") as HTMLElement;
    this.glyph.resize(width, height, headH, height - legend.offsetTop + 6, $("census-badge").offsetHeight);
    this.map.resize(width, height, this.glyph.homeX, this.glyph.homeY, this.glyph.lensRadius);
    this.kick();
  }

  // ---------- map colours --------------------------------------------------------------------
  private recolour() {
    const cs = getComputedStyle(document.documentElement);
    this.colours = ramp(cs.getPropertyValue("--choro-0").trim() || "#eef3f0", cs.getPropertyValue("--choro-1").trim() || "#1d5b73");
    this.cuts = breaks(this.units, this.indicator);
  }

  private renderLegend() {
    const info = INDICATORS[this.indicator];
    const f = (v: number) => (this.indicator === "population" ? compact(v) : fmt(v, info.digits === 0 ? 0 : Math.min(info.digits, 1)));
    const vals = this.units.map((u) => value(u, this.indicator)).filter(Number.isFinite);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const edges = [lo, ...this.cuts, hi];
    $("choro-legend").innerHTML = this.colours
      .map((col, i) => `<li><i style="background:${col}"></i><span>${f(edges[i])}–${f(edges[i + 1])}${info.unit === "%" ? "%" : ""}</span></li>`)
      .join("");
  }

  // ---------- side panel -------------------------------------------------------------------------
  private renderStats() {
    const a = this.primary, b = this.compare;
    const rows: Record<string, (u: District) => string> = {
      population: (u) => compact(u.population, true),
      growth: (u) => (u.growth === null ? "no data" : `${u.growth > 0 ? "+" : ""}${fmt(u.growth, 2)}%`),
      area: (u) => `${int(u.area)} km²`,
      density: (u) => int(u.density),
      urbanPct: (u) => `${fmt(u.urbanPct, 1)}%`,
      sexRatio: (u) => fmt(u.sexRatio, 1),
      pop2017: (u) => compact(u.pop2017, true),
      rank: (u) => `${this.rankByPop.get(u.id)} of ${this.units.length}`,
    };
    for (const dd of document.querySelectorAll<HTMLElement>("#stats dd")) {
      const f = rows[dd.dataset.k!];
      dd.innerHTML = `<span class="v">${f(a)}</span>${b ? `<span class="c">${esc(b.name)}: ${f(b)}</span>` : ""}`;
    }
    const note = $("kind-note");
    note.hidden = !a.note;
    note.textContent = a.note ?? "";
    $("tehsils").textContent = a.tehsils.join(", ");
    $("tehsil-title").textContent = `Tehsils of ${a.name}`;
  }

  private renderRanking() {
    const info = INDICATORS[this.indicator];
    const list = this.units.filter((u) => u.province === this.primary.province).sort((x, y) => value(y, this.indicator) - value(x, this.indicator));
    const max = Math.max(...list.map((u) => Math.abs(value(u, this.indicator))));
    $("rank-title").textContent = `${this.primary.province}: ${info.label.toLowerCase()}`;
    $("rank-sub").textContent = `${list.length} districts, highest first. Tap one to open it.`;
    const f = (u: District) => {
      const v = value(u, this.indicator);
      if (this.indicator === "population") return compact(v);
      return `${fmt(v, info.digits === 0 ? 0 : Math.min(info.digits, 2))}${info.unit === "%" ? "%" : ""}`;
    };
    $("rank-list").innerHTML = list
      .map((u) => {
        const w = Math.max((Math.abs(value(u, this.indicator)) / max) * 100, 0.5);
        const cls = [u.id === this.primary.id ? "is-sel" : "", u.id === this.compare?.id ? "is-cmp" : "", value(u, this.indicator) < 0 ? "is-neg" : ""].join(" ");
        return `<li class="${cls}"><button type="button" data-id="${u.id}"><span class="rk-name">${esc(u.name)}${u.kind === "new" ? ' <small>new</small>' : ""}</span><span class="rk-bar"><i style="width:${w.toFixed(1)}%"></i></span><span class="rk-val">${f(u)}</span></button></li>`;
      })
      .join("");
    // scroll only the list, not the whole panel
    const listEl = $("rank-list");
    const sel = listEl.querySelector<HTMLElement>(".is-sel");
    if (sel) listEl.scrollTop = sel.offsetTop - listEl.offsetTop - listEl.clientHeight / 2 + sel.offsetHeight / 2;
  }

  // ---------- details dialog ------------------------------------------------------------------
  private renderDetails() {
    const u = this.primary;
    for (const btn of document.querySelectorAll<HTMLButtonElement>("#details [role=tab]")) btn.setAttribute("aria-selected", String(btn.dataset.tab === this.detailsTab));
    const body = $("details-body");
    if (this.detailsTab === "district") {
      $("details-sub").textContent = `${u.name}, ${u.province}, Census 2023`;
      const broad = u.age.detail === "broad";
      const labels = broad ? this.data.broadLabels : this.data.ageLabels;
      const pick = (reg: "overall" | "urban" | "rural", sex: "m" | "f", i: number) => (broad ? u.age[reg].bands![sex][i] : u.age[reg][sex][i]);
      const rows = labels
        .map((lab, i) => `<tr><th scope="row">${lab}</th>${(["overall", "urban", "rural"] as const).map((r) => `<td class="num">${fmt(pick(r, "m", i), 2)}</td><td class="num">${fmt(pick(r, "f", i), 2)}</td>`).join("")}</tr>`)
        .reverse()
        .join("");
      const facts: [string, string][] = [
        ["Population", int(u.population)], ["Male", int(u.male)], ["Female", int(u.female)], ["Transgender", int(u.transgender)],
        ["Urban", int(u.urban)], ["Rural", int(u.rural)], ["Area (km²)", int(u.area)], ["People per km²", u.density === null ? "no data" : fmt(u.density, 1)],
        ["Males per 100 females", fmt(u.sexRatio, 2)], ["Population in 2017", int(u.pop2017)], ["Growth per year, 2017–2023 (%)", u.growth === null ? "no data" : fmt(u.growth, 2)],
      ];
      body.innerHTML = `<h3 class="d-title">${esc(u.name)}</h3>${u.note ? `<p class="muted d-sub">${esc(u.note)}</p>` : ""}
        <div class="table-wrap"><table class="d-table"><tbody>${facts.map(([k, v]) => `<tr><th scope="row">${k}</th><td class="num">${v}</td></tr>`).join("")}</tbody></table></div>
        <h3 class="d-title" style="margin-top:18px">Population by age and sex${broad ? " (broad age groups)" : ""}</h3>
        <p class="muted d-sub">Share of each area's population, in per cent (males and females together add up to 100)</p>
        <div class="table-wrap"><table class="d-table"><thead><tr><th scope="col" rowspan="2">Age</th><th scope="col" colspan="2" class="num">All residents</th><th scope="col" colspan="2" class="num">Urban</th><th scope="col" colspan="2" class="num">Rural</th></tr>
        <tr><th scope="col" class="num">Male</th><th scope="col" class="num">Female</th><th scope="col" class="num">Male</th><th scope="col" class="num">Female</th><th scope="col" class="num">Male</th><th scope="col" class="num">Female</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      this.csv = {
        name: `${slug(u.name)}-census-2023.csv`,
        rows: [
          ["Indicator", "Value"], ...facts.map(([k, v]) => [k, v.replace(/,/g, "")]), [],
          ["Age", "All male %", "All female %", "Urban male %", "Urban female %", "Rural male %", "Rural female %"],
          ...labels.map((lab, i) => [lab, ...(["overall", "urban", "rural"] as const).flatMap((r) => [pick(r, "m", i), pick(r, "f", i)])]),
        ],
      };
      $("details-note").textContent = `Source: PBS Census 2023. Totals from Table 1; age shares from Table ${broad ? "5 (broad groups by tehsil)" : "4 (single years of age, grouped)"}.`;
    } else {
      $("details-sub").textContent = `All ${this.units.length} districts, Census 2023. Click a column to sort, a row to open the district.`;
      const cols: [string, string, (u: District) => number | string][] = [
        ["name", "District", (u) => u.name], ["province", "Province", (u) => u.province], ["population", "Population", (u) => u.population],
        ["growth", "Growth %", (u) => u.growth ?? NaN], ["area", "Area km²", (u) => u.area], ["density", "Per km²", (u) => u.density ?? NaN],
        ["urbanPct", "Urban %", (u) => u.urbanPct], ["sexRatio", "Sex ratio", (u) => u.sexRatio], ["pop2017", "2017", (u) => u.pop2017],
      ];
      const col = cols.find((c) => c[0] === this.sort.key) ?? cols[2];
      const list = [...this.units].sort((x, y) => {
        const a = col[2](x), b = col[2](y);
        return (typeof a === "string" ? a.localeCompare(b as string) : (a as number) - (b as number)) * this.sort.dir;
      });
      const cell = (key: string, v: number | string) => (typeof v === "string" ? esc(v) : key === "growth" ? fmt(v, 2) : key === "urbanPct" || key === "sexRatio" ? fmt(v, 1) : key === "density" ? fmt(v, 0) : int(v));
      body.innerHTML = `<div class="table-wrap d-years-wrap" style="max-height:100%"><table class="d-table d-years"><thead><tr>${cols
        .map(([k, lab]) => `<th scope="col" class="${k === "name" || k === "province" ? "" : "num"} sortable" data-sort="${k}" aria-sort="${k === this.sort.key ? (this.sort.dir < 0 ? "descending" : "ascending") : "none"}">${lab}${k === this.sort.key ? (this.sort.dir < 0 ? " ↓" : " ↑") : ""}</th>`)
        .join("")}</tr></thead><tbody>${list
        .map((u) => `<tr data-id="${u.id}" class="${u.id === this.primary.id ? "is-current" : ""}">${cols.map(([k, , f], i) => (i === 0 ? `<th scope="row">${cell(k, f(u))}</th>` : `<td class="${k === "province" ? "" : "num"}">${cell(k, f(u))}</td>`)).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
      this.csv = { name: "pakistan-districts-census-2023.csv", rows: [["District", "Province", "Division", "Type", "Population", "Male", "Female", "Transgender", "Urban", "Rural", "Area km2", "Per km2", "Urban %", "Males per 100 females", "Population 2017", "Growth % per year", "Tehsils"], ...list.map((u) => [u.name, u.province, u.division, u.kind, u.population, u.male, u.female, u.transgender, u.urban, u.rural, u.area, u.density ?? "", u.urbanPct, u.sexRatio, u.pop2017, u.growth ?? "", u.tehsils.join("; ")])] };
      $("details-note").textContent = "Source: PBS Census 2023, Table 1. Districts created after the census add up their census tehsils.";
    }
  }

  private download() {
    const cell = (v: string | number) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = ["# Source: Pakistan Bureau of Statistics, 7th Population and Housing Census 2023", ...this.csv.rows.map((r) => r.map(cell).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: this.csv.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- controls -------------------------------------------------------------------------
  private bindControls() {
    $("place-btn").addEventListener("click", () => this.openPicker("place"));
    $("compare-btn").addEventListener("click", () => this.openPicker("compare"));
    $("compare-clear").addEventListener("click", () => this.setCompare(null));
    $("recenter").addEventListener("click", () => this.map.recenter(!reducedMotion.matches));
    const sel = $<HTMLSelectElement>("indicator");
    sel.addEventListener("change", () => {
      this.indicator = sel.value as Indicator;
      this.recolour();
      this.renderLegend();
      this.renderRanking();
      this.map.repaint();
    });
    this.renderLegend();
    $("rank-list").addEventListener("click", (e) => {
      const id = (e.target as Element).closest<HTMLElement>("[data-id]")?.dataset.id;
      const u = id ? this.byId.get(Number(id)) : undefined;
      if (u) this.setPrimary(u, "fly");
    });
    const dlg = $<HTMLDialogElement>("details");
    const open = () => {
      this.renderDetails();
      dlg.showModal();
    };
    $("details-btn").addEventListener("click", open);
    $("details-link").addEventListener("click", open);
    $("details-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) return dlg.close();
      const th = (e.target as Element).closest<HTMLElement>("[data-sort]");
      if (th) {
        const key = th.dataset.sort!;
        this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : key === "name" || key === "province" ? 1 : -1 };
        return this.renderDetails();
      }
      const row = (e.target as Element).closest<HTMLElement>("tr[data-id]");
      if (row) {
        dlg.close();
        this.setPrimary(this.byId.get(Number(row.dataset.id))!, "fly");
      }
    });
    for (const btn of document.querySelectorAll<HTMLButtonElement>("#details [role=tab]")) {
      btn.addEventListener("click", () => {
        this.detailsTab = btn.dataset.tab as "district" | "all";
        this.renderDetails();
      });
    }
    $("details-csv").addEventListener("click", () => this.download());
  }

  private bindStage() {
    const stage = $("stage");
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { startX: number; startY: number; moved: boolean; t: number; vx: number; vy: number } | null = null;
    let pinch: { dist: number; mx: number; my: number } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    const local = (e: { clientX: number; clientY: number }) => {
      const box = stage.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const pinchState = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const at = (x: number, y: number) => {
      const id = this.map.pickAt(x, y);
      return id === null ? undefined : this.byId.get(id);
    };

    stage.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest("button, a, .legend, .tooltip")) return;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      pointers.set(e.pointerId, local(e));
      this.map.stop();
      if (pointers.size === 2) {
        pinch = pinchState();
        drag = null;
        this.chartDrag = null;
        return;
      }
      const p = local(e);
      if (this.glyph.hitCore(e.clientX, e.clientY)) {
        this.chartDrag = { dx: this.glyph.cx - p.x, dy: this.glyph.cy - p.y, id: e.pointerId };
        this.chartMoved = false;
        this.tooltip(null, 0, 0);
      }
      drag = { startX: p.x, startY: p.y, moved: false, t: performance.now(), vx: 0, vy: 0 };
    });

    stage.addEventListener("pointermove", (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === "mouse") {
          const core = this.glyph.hitCore(e.clientX, e.clientY);
          stage.classList.toggle("is-over-chart", core);
          stage.classList.toggle("is-over-bars", !core && this.glyph.hit(e));
        }
        return;
      }
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const now = pinchState();
        this.map.panBy(pinch.mx - now.mx, pinch.my - now.my);
        this.map.zoomAt(now.dist / pinch.dist, now.mx, now.my, true);
        pinch = now;
        return;
      }
      if (!drag) return;
      if (this.chartDrag && this.chartDrag.id === e.pointerId) {
        if (!this.chartMoved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4) {
          this.chartMoved = true;
          stage.classList.add("is-dragging-chart");
        }
        if (!this.chartMoved) return;
        const x = p.x + this.chartDrag.dx, y = p.y + this.chartDrag.dy;
        this.motion.dragging = true;
        this.motion.follow(x, y);
        this.kick();
        const u = at(x, y);
        if (u && u.id !== this.primary.id) this.setPrimary(u, "drag");
        return;
      }
      if (!drag.moved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4) {
        drag.moved = true;
        stage.classList.add("is-dragging");
        this.tooltip(null, 0, 0);
      }
      if (drag.moved) {
        const now = performance.now();
        const dtm = Math.max(now - drag.t, 1);
        const dx = p.x - prev.x, dy = p.y - prev.y;
        this.map.panBy(-dx, -dy);
        drag.vx = drag.vx * 0.6 + (dx / dtm) * 0.4;
        drag.vy = drag.vy * 0.6 + (dy / dtm) * 0.4;
        drag.t = now;
      }
    });

    const end = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      stage.classList.remove("is-dragging");
      if (this.chartDrag && this.chartDrag.id === e.pointerId) {
        const moved = this.chartMoved;
        this.chartDrag = null;
        stage.classList.remove("is-dragging-chart");
        if (moved) {
          this.motion.dragging = false;
          this.motion.follow(this.anchorTarget.x, this.anchorTarget.y);
          this.kick();
          this.map.refresh();
          drag = null;
          return;
        }
      }
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        drag = null;
        return;
      }
      if (!drag) return;
      const p = local(e);
      if (drag.moved) {
        if (performance.now() - drag.t < 80) this.map.fling(drag.vx, drag.vy);
      } else if (e.type === "pointerup") {
        const now = performance.now();
        const isDouble = now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30;
        lastTap = isDouble ? { t: 0, x: 0, y: 0 } : { t: now, x: p.x, y: p.y };
        if (isDouble) {
          const u = at(p.x, p.y);
          if (u) this.setPrimary(u, "stay");
        } else if (!this.glyph.hit(e)) { this.tooltip(null, 0, 0); const u = at(p.x, p.y); if (u && u.id !== this.primary.id) this.setPrimary(u, "stay"); }
      }
      drag = null;
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("pointerleave", (e) => {
      if (!pointers.size && e.pointerType === "mouse") this.tooltip(null, 0, 0);
    });
    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const p = local(e);
        this.map.zoomAt(Math.exp(-(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0016), p.x, p.y);
      },
      { passive: false },
    );
    stage.addEventListener("dblclick", (e) => e.preventDefault());
  }

  private tooltip(row: ReadoutRow | null, x: number, y: number) {
    const tip = $("tooltip");
    if (!row) return void (tip.hidden = true);
    const u = this.primary;
    const reg = row.arm === "Urban" ? "urban" : row.arm === "Rural" ? "rural" : "overall";
    let age = row.age;
    let m = row.left, f = row.right;
    if (u.age.detail === "broad") {
      const slot = this.data.ageLabels.indexOf(row.age);
      const band = slot < 1 ? 0 : slot < 3 ? 1 : slot < 13 ? 2 : 3;
      age = `${this.data.broadLabels[band]} (broad group)`;
      m = u.age[reg].bands!.m[band];
      f = u.age[reg].bands!.f[band];
    }
    const pct = (v: number) => `${fmt(v, 2)}%`;
    const lines = [`<strong>${row.arm}</strong>`, `Aged ${age}`, `Male ${pct(m)}, female ${pct(f)}`];
    if (this.compare && this.compare.age.detail === "5-year" && u.age.detail === "5-year") lines.push(`${esc(this.compare.name)}: male ${pct(row.cLeft)}, female ${pct(row.cRight)}`);
    if (u.age[reg].total === 0) lines.push("No population in this area");
    tip.innerHTML = lines.map((l) => `<span>${l}</span>`).join("");
    tip.hidden = false;
    const stage = $("stage").getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.transform = `translate(${Math.min(Math.max(x - tw / 2, 8), stage.width - tw - 8)}px, ${y - th - 16 < 8 ? y + 20 : y - th - 16}px)`;
  }

  private buildPicker() {
    const list = $("picker-list");
    const input = $<HTMLInputElement>("picker-input");
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const items: { li: HTMLLIElement; text: string }[] = [];
    const provinces = [...new Set(this.units.map((u) => u.province))].sort();
    for (const prov of provinces) {
      const h = document.createElement("li");
      h.className = "picker-group";
      h.textContent = prov;
      list.append(h);
      for (const u of this.units.filter((x) => x.province === prov).sort((a, b) => a.name.localeCompare(b.name))) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `<span>${esc(u.name)}${u.kind === "new" ? " <small>new district</small>" : ""}</span><small>${esc(u.division)}</small>`;
        b.addEventListener("click", () => {
          $<HTMLDialogElement>("picker").close();
          if (this.pickerMode === "place") this.setPrimary(u, "fly");
          else this.setCompare(u);
        });
        li.append(b);
        list.append(li);
        items.push({ li, text: norm(`${u.name} ${u.division} ${u.province} ${u.tehsils.join(" ")}`) });
      }
    }
    input.addEventListener("input", () => {
      const q = norm(input.value.trim());
      for (const it of items) it.li.hidden = !!q && !it.text.includes(q);
      for (const h of list.querySelectorAll<HTMLElement>(".picker-group")) h.hidden = !!q;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") list.querySelector<HTMLButtonElement>("li:not([hidden]) button")?.click();
    });
    const dlg = $<HTMLDialogElement>("picker");
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
  }

  private openPicker(mode: "place" | "compare") {
    this.pickerMode = mode;
    $("picker-title").textContent = mode === "place" ? "Choose a district" : `Compare ${this.primary.name} with`;
    const input = $<HTMLInputElement>("picker-input");
    input.value = "";
    input.dispatchEvent(new Event("input"));
    $<HTMLDialogElement>("picker").showModal();
    if (matchMedia("(pointer: fine)").matches) input.focus();
  }

  private renderSiteInfo() {
    const { lab, contact } = SITE;
    const link = (href: string, text: string) => Object.assign(document.createElement("a"), { href, textContent: text, target: href.startsWith("mailto:") ? "" : "_blank", rel: "noopener" });
    $("lab").hidden = false;
    $("lab-name").textContent = `About ${lab.name}`;
    Object.assign($("lab-intro"), { textContent: lab.intro, hidden: false });
    const w = $("lab-website");
    w.hidden = false;
    w.replaceChildren(link(lab.website, "Visit the GSAL website"));
    const rows: [string, Node | string][] = [
      ["Address", contact.address],
      ["Location", link(contact.mapsUrl, `${contact.coordinates}, open in Google Maps`)],
      ["Email", link(`mailto:${contact.email}`, contact.email)],
      ["Office hours", contact.officeHours],
      ["Send a message", link(contact.contactPage, "Contact form on the GSAL website")],
    ];
    $("contact-list").replaceChildren(...rows.map(([label, v]) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("strong"), { textContent: label }), document.createElement("br"), v);
      return li;
    }));
    $("site-foot").textContent = `HumanScape by ${lab.name}. Code under the MIT License. Census data © Pakistan Bureau of Statistics.`;
    const created = this.units.filter((u) => u.kind === "new");
    $("new-districts").textContent =
      `Punjab notified new districts on 18 December 2024, after the census. HumanScape builds them from their census tehsils: ` +
      created.map((u) => `${u.name} (${u.tehsils.join(" and ")}, from ${u.parent})`).join("; ") +
      `. Because age tables for tehsils are only published in broad groups, these districts and the remaining parts of their parent districts show broad age groups. Karachi West and Keamari are shown together because the boundary data does not separate them.`;
    $("fixes").replaceChildren(...this.data.source.fixes.map((f) => Object.assign(document.createElement("li"), { textContent: f })));
  }
}

Promise.all([loadPakistan(), loadWorld()])
  .then(([data, world]) => new PakistanApp(data, world))
  .catch((err: Error) => {
    $("status").textContent = `${err.message} Reload the page to try again.`;
    console.error(err);
  });
