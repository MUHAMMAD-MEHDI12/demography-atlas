// Small SVG charts for the side panel, drawn from official WPP 2024 series.

import type { Annual } from "./data";
import { compact, signedCompact, fmt } from "./format";

const NS = "http://www.w3.org/2000/svg";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.6, 2, 2.4, 3.2, 4, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// ---------------------------------------------------------------------------
// Total population, 1950-2100
// ---------------------------------------------------------------------------
export class PopulationChart {
  private svg: SVGSVGElement;
  private readout: HTMLElement;
  private args: { a: Float64Array; b: Float64Array | null; year: number; aName: string; bName: string | null } | null = null;
  private hoverYear: number | null = null;

  constructor(private host: HTMLElement, private yearStart: number, private lastEstimate: number) {
    this.readout = host.querySelector(".chart-readout")!;
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "chart-svg");
    this.svg.setAttribute("role", "img");
    host.querySelector(".chart-body")!.append(this.svg);
    new ResizeObserver(() => this.draw()).observe(host);
    const move = (e: PointerEvent) => {
      const box = this.svg.getBoundingClientRect();
      const { x0, x1, n } = this.geom(box.width);
      const t = Math.min(Math.max((e.clientX - box.left - x0) / (x1 - x0), 0), 1);
      this.hoverYear = this.yearStart + Math.round(t * (n - 1));
      this.draw();
    };
    this.svg.addEventListener("pointermove", move);
    this.svg.addEventListener("pointerdown", move);
    this.svg.addEventListener("pointerleave", () => {
      this.hoverYear = null;
      this.draw();
    });
  }

  update(a: Float64Array, b: Float64Array | null, year: number, aName: string, bName: string | null) {
    this.args = { a, b, year, aName, bName };
    this.draw();
  }

  private geom(w: number) {
    const n = this.args?.a.length ?? 151;
    return { x0: 44, x1: Math.max(w - 10, 60), y0: 12, y1: 150, n };
  }

  private draw() {
    if (!this.args) return;
    const { a, b, year, aName, bName } = this.args;
    const w = this.host.querySelector(".chart-body")!.clientWidth || 320;
    const h = 176;
    const { x0, x1, y0, y1, n } = this.geom(w);
    let max = 0;
    for (const s of [a, b]) if (s) for (const v of s) if (v > max) max = v;
    const top = niceMax(max);
    const X = (i: number) => x0 + (i / (n - 1)) * (x1 - x0);
    const Y = (v: number) => y1 - (v / top) * (y1 - y0);
    const split = this.lastEstimate - this.yearStart;
    const line = (s: Float64Array, from: number, to: number) => {
      let d = "";
      for (let i = from; i <= to; i++) if (Number.isFinite(s[i])) d += `${d ? "L" : "M"}${X(i).toFixed(1)},${Y(s[i]).toFixed(1)}`;
      return d;
    };
    const area = (s: Float64Array) => `${line(s, 0, n - 1)}L${X(n - 1)},${y1}L${X(0)},${y1}Z`;

    let g = `<defs><linearGradient id="pop-grad" x1="0" x2="0" y1="0" y2="1"><stop offset="0" /><stop offset="1" /></linearGradient></defs>`;
    for (let k = 0; k <= 4; k++) {
      const v = (top * k) / 4;
      g += `<line class="c-grid" x1="${x0}" x2="${x1}" y1="${Y(v)}" y2="${Y(v)}"/>`;
      g += `<text class="c-axis" x="${x0 - 6}" y="${Y(v)}" text-anchor="end" dominant-baseline="central">${compact(v)}</text>`;
    }
    for (const yr of [1950, 2000, 2050, 2100]) {
      const i = yr - this.yearStart;
      g += `<text class="c-axis" x="${X(i)}" y="${h - 8}" text-anchor="${yr === 1950 ? "start" : yr === 2100 ? "end" : "middle"}">${yr}</text>`;
    }
    g += `<rect class="c-proj" x="${X(split)}" y="${y0}" width="${X(n - 1) - X(split)}" height="${y1 - y0}"/>`;
    g += `<text class="c-axis c-proj-label" x="${x1 - 4}" y="${y0 + 10}" text-anchor="end">Projection</text>`;
    g += `<path class="c-area" d="${area(a)}"/>`;
    if (b) {
      g += `<path class="c-line c-line-b" d="${line(b, 0, split)}"/>`;
      g += `<path class="c-line c-line-b c-dash" d="${line(b, split, n - 1)}"/>`;
    }
    g += `<path class="c-line" d="${line(a, 0, split)}"/>`;
    g += `<path class="c-line c-dash" d="${line(a, split, n - 1)}"/>`;

    const shown = this.hoverYear ?? Math.round(year);
    const i = shown - this.yearStart;
    g += `<line class="c-marker" x1="${X(i)}" x2="${X(i)}" y1="${y0}" y2="${y1}"/>`;
    g += `<circle class="c-dot" cx="${X(i)}" cy="${Y(a[i])}" r="4"/>`;
    if (b && Number.isFinite(b[i])) g += `<circle class="c-dot c-dot-b" cx="${X(i)}" cy="${Y(b[i])}" r="3.5"/>`;

    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.setAttribute("height", String(h));
    this.svg.setAttribute("aria-label", `Total population of ${aName} from 1950 to 2100`);
    this.svg.innerHTML = g;

    const phase = shown > this.lastEstimate ? "projection" : "estimate";
    let text = `<strong>${shown}</strong> <span class="muted">${phase}</span><br>${esc(aName)}: ${compact(a[i], true)}`;
    if (b && bName) text += `<br><span class="muted">${esc(bName)}: ${compact(b[i], true)}</span>`;
    this.readout.innerHTML = text;
  }
}

// ---------------------------------------------------------------------------
// Population change over the last five calendar years
// ---------------------------------------------------------------------------
export type ChangeMode = "people" | "rate";

export class ChangeChart {
  private svg: SVGSVGElement;
  private args: { a: Annual[]; b: Annual[] | null; aName: string; bName: string | null; mode: ChangeMode } | null = null;

  constructor(private host: HTMLElement, private lastEstimate: number) {
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "chart-svg");
    this.svg.setAttribute("role", "img");
    host.querySelector(".chart-body")!.append(this.svg);
    new ResizeObserver(() => this.draw()).observe(host);
  }

  update(a: Annual[], b: Annual[] | null, aName: string, bName: string | null, mode: ChangeMode) {
    this.args = { a, b, aName, bName, mode };
    this.draw();
    this.table();
  }

  private value(r: Annual, mode: ChangeMode) {
    return mode === "people" ? r.change : r.growthRate;
  }

  private label(v: number, mode: ChangeMode) {
    if (!Number.isFinite(v)) return "no data";
    return mode === "people" ? signedCompact(v) : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), 2)}%`;
  }

  private draw() {
    if (!this.args) return;
    const { a, b, mode, aName } = this.args;
    const w = this.host.querySelector(".chart-body")!.clientWidth || 320;
    const h = 170;
    const x0 = 6, x1 = w - 6, top = 22, bottom = h - 46; // room for value labels above and below
    const vals = [...a, ...(b ?? [])].map((r) => this.value(r, mode)).filter(Number.isFinite);
    const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
    const span = hi - lo || 1;
    const Y = (v: number) => top + ((hi - v) / span) * (bottom - top);
    const slot = (x1 - x0) / a.length;
    const bw = Math.min(b ? slot * 0.34 : slot * 0.56, 46);

    let g = `<line class="c-zero" x1="${x0}" x2="${x1}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    a.forEach((r, i) => {
      const cx = x0 + slot * (i + 0.5);
      const proj = r.year > this.lastEstimate ? " is-proj" : "";
      const bar = (row: Annual, x: number, cls: string) => {
        const v = this.value(row, mode);
        if (!Number.isFinite(v)) return "";
        const y = Math.min(Y(v), Y(0));
        const hgt = Math.max(Math.abs(Y(v) - Y(0)), 1);
        return `<rect class="c-bar ${v < 0 ? "is-loss" : "is-gain"}${cls}${proj}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" rx="3"/>`;
      };
      const va = this.value(r, mode);
      if (b) {
        g += bar(r, cx - bw - 1, "");
        g += bar(b[i], cx + 1, " is-b");
      } else {
        g += bar(r, cx - bw / 2, "");
        const ly = va < 0 ? Y(va) + 13 : Y(va) - 6;
        g += `<text class="c-val" x="${cx}" y="${ly}" text-anchor="middle">${this.label(va, mode)}</text>`;
      }
      g += `<text class="c-axis" x="${cx}" y="${h - 10}" text-anchor="middle">${r.year}</text>`;
    });
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.setAttribute("height", String(h));
    this.svg.setAttribute("aria-label", `Annual population change of ${aName}, ${a[0].year} to ${a[a.length - 1].year}`);
    this.svg.innerHTML = g;
  }

  private table() {
    if (!this.args) return;
    const { a, b, aName, bName, mode } = this.args;
    const rows = a
      .map((r, i) => {
        const cmp = b ? `<td class="num">${this.label(this.value(b[i], mode), mode)}</td>` : "";
        return `<tr${r.year > this.lastEstimate ? ' class="is-proj"' : ""}><th scope="row">${r.year}</th><td class="num">${compact(r.births)}</td><td class="num">${compact(r.deaths)}</td><td class="num">${signedCompact(r.netMigration)}</td><td class="num strong">${signedCompact(r.change)}</td><td class="num">${this.label(r.growthRate, "rate")}</td>${cmp}</tr>`;
      })
      .join("");
    const cmpHead = b && bName ? `<th scope="col" class="num">${esc(bName)}</th>` : "";
    this.host.querySelector(".change-table")!.innerHTML = `
      <caption>${esc(aName)}: births − deaths + net migration = change</caption>
      <thead><tr><th scope="col">Year</th><th scope="col" class="num">Births</th><th scope="col" class="num">Deaths</th><th scope="col" class="num">Net migration</th><th scope="col" class="num">Change</th><th scope="col" class="num">Growth</th>${cmpHead}</tr></thead>
      <tbody>${rows}</tbody>`;
  }
}
