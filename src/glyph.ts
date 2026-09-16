// The demographic glyph: an equilateral triangle of value axes around the
// country, with one age-structure arm growing outward from each side.
//   left side   population share by age and sex   (0-12% at the vertex)
//   right side  share of deaths by age and sex    (0-42% at the vertex)
//   bottom      share of births by mother's age   (0-48%, split across both sides)
// Geometry is defined in units of the inscribed circle radius and scaled to pixels.

import { AGE_GROUPS, FERT_GROUPS, type Profile } from "./data";

const SVG = "http://www.w3.org/2000/svg";
const SQ3 = Math.sqrt(3);

type Key = "pop" | "deaths" | "fert";

interface ArmSpec {
  key: Key;
  title: string;
  rotate: number; // degrees; local -y points outward
  groups: number;
  step: number;
  thickness: number;
  max: number; // value at the triangle vertex
  ticks: number[];
  symmetric: boolean;
}

// step/thickness of the two age arms are recomputed on resize to fit narrow screens
const ARMS: ArmSpec[] = [
  { key: "pop", title: "Population", rotate: -60, groups: AGE_GROUPS, step: 0.2, thickness: 0.15, max: 12, ticks: [4, 8], symmetric: false },
  { key: "deaths", title: "Deaths", rotate: 60, groups: AGE_GROUPS, step: 0.2, thickness: 0.15, max: 42, ticks: [14, 28], symmetric: false },
  { key: "fert", title: "Births by mother's age", rotate: 180, groups: FERT_GROUPS, step: 0.34, thickness: 0.26, max: 48, ticks: [16, 32], symmetric: true },
];
const GAP = 0.1;

export interface ReadoutRow {
  arm: string;
  age: string;
  left: number;
  right: number;
  cLeft: number;
  cRight: number;
  symmetric: boolean;
}

const el = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}, parent?: Element) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
};

interface ArmNodes {
  spec: ArmSpec;
  g: SVGGElement;
  left: SVGRectElement[];
  right: SVGRectElement[];
  cLeft: SVGRectElement[];
  cRight: SVGRectElement[];
}

export class Glyph {
  readonly svg: SVGSVGElement;
  private root: SVGGElement;
  private arms: ArmNodes[] = [];
  private labels: SVGGElement;
  private frame: SVGGElement;
  private unit = 40;
  private top = 0;
  cx = 0;
  cy = 0;
  private data: Record<Key, [Float64Array, Float64Array]> | null = null;
  private cmp: Record<Key, [Float64Array, Float64Array]> | null = null;

  constructor(svg: SVGSVGElement, private ages: string[], private fertAges: string[], private onHover: (row: ReadoutRow | null, x: number, y: number) => void) {
    this.svg = svg;
    const defs = el("defs", {}, svg);
    for (const [id, color] of [["hatch-m", "var(--male)"], ["hatch-f", "var(--female)"]]) {
      const p = el("pattern", { id, width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
      el("rect", { width: 4, height: 4, style: `fill:${color};fill-opacity:.32` }, p);
      el("rect", { width: 1.8, height: 4, style: `fill:${color}` }, p);
    }
    this.root = el("g", {}, svg);
    this.frame = el("g", { class: "g-frame" }, this.root);
    for (const spec of ARMS) {
      const g = el("g", { class: `g-arm g-${spec.key}` }, this.root);
      const mk = (cls: string) => Array.from({ length: spec.groups }, () => el("rect", { class: cls }, g));
      const arm: ArmNodes = { spec, g, left: mk("bar bar-m"), right: mk("bar bar-f"), cLeft: [], cRight: [] };
      arm.cLeft = mk("bar-cmp");
      arm.cRight = mk("bar-cmp");
      if (spec.symmetric) arm.left.forEach((r) => r.setAttribute("class", "bar bar-f"));
      this.arms.push(arm);
    }
    this.labels = el("g", { class: "g-labels" }, this.root);
  }

  /** Lay out for a stage of w x h CSS pixels, keeping clear of a header of height `top`. */
  resize(w: number, h: number, top = 0) {
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const bottom = 34; // legend
    const avail = Math.max(h - top - bottom, h * 0.55);
    // vertical budget: 3.6 units above the centre, 4.1 below (births arm and its title)
    const u = Math.max(22, Math.min(avail / 7.7, w / 7.4, 130));
    // shorten the age arms on narrow screens so their tips stay on screen
    const reach = ((w / 2 - 10) / u - 0.45) / 0.866; // centre-to-tip distance that fits
    const step = Math.min(0.2, Math.max(0.11, (reach - 1 - GAP) / AGE_GROUPS));
    for (const arm of this.arms.slice(0, 2)) {
      arm.spec.step = step;
      arm.spec.thickness = step * 0.76;
    }
    this.unit = u;
    this.top = top;
    this.cx = w / 2;
    this.cy = top + 3.6 * u + Math.max(0, avail - 7.7 * u) / 2;
    this.root.setAttribute("transform", `translate(${this.cx},${this.cy})`);
    this.buildStatic();
    this.draw();
  }

  get lensRadius() {
    return this.unit;
  }

  private buildStatic() {
    const u = this.unit;
    this.frame.replaceChildren();
    this.labels.replaceChildren();
    const V = [[0, -2 * u], [-SQ3 * u, u], [SQ3 * u, u]];
    el("circle", { class: "g-lens", r: u }, this.frame);
    el("path", { class: "g-axis", d: `M${V[0]}L${V[1]}L${V[2]}Z` }, this.frame);

    const fs = Math.max(8.5, Math.min(12.5, u * 0.19));
    for (const arm of this.arms) {
      const { spec, g } = arm;
      const r = spec.rotate;
      const flip = Math.abs(r) === 180;
      g.setAttribute("transform", `rotate(${r})`);
      // ticks and numbers along the side (local x axis at y = -u); inside the triangle is +y
      const tg = el("g", { transform: `rotate(${r})` }, this.frame);
      const text = (cls: string, x: number, y: number, size: number, content: string, anchor = "middle", parent: Element = tg) => {
        const t = el("text", { class: cls, x, y, "font-size": size, "text-anchor": anchor, "dominant-baseline": "central" }, parent);
        if (flip) t.setAttribute("transform", `rotate(180 ${x} ${y})`);
        t.textContent = content;
        return t;
      };
      for (const side of [-1, 1]) {
        for (const t of spec.ticks) {
          const x = side * (t / spec.max) * SQ3 * u;
          el("line", { class: "g-tick", x1: x, x2: x, y1: -u, y2: -u + 0.12 * u }, tg);
          text("g-num", x, -u + 0.3 * u, fs * 0.85, spec.symmetric ? String(t / 2) : String(t));
        }
      }
      // arm title beyond the arm tip, horizontal
      const tip = (1 + GAP + spec.groups * spec.step) * u;
      const rr = (r * Math.PI) / 180;
      const title = el("text", { class: "g-title", "font-size": fs * 1.3, "dominant-baseline": "central" }, this.labels);
      title.textContent = spec.title;
      if (spec.symmetric) {
        Object.entries({ x: 0, y: tip + 0.42 * u, "text-anchor": "middle" }).forEach(([k, v]) => title.setAttribute(k, String(v)));
      } else {
        const side = Math.sign(r); // -1 left arm, 1 right arm
        const tx = side * Math.min(Math.abs(tip * Math.sin(rr)) - 0.2 * u, this.cx - 8);
        Object.entries({ x: tx, y: Math.max(-tip * Math.cos(rr) - 0.62 * u, this.top - this.cy + fs), "text-anchor": side < 0 ? "start" : "end" }).forEach(([k, v]) => title.setAttribute(k, String(v)));
      }
      if (!spec.symmetric) {
        text("g-sex g-sex-m", -SQ3 * u - 0.12 * u, -u, fs * 0.9, "male", "end");
        text("g-sex g-sex-f", SQ3 * u + 0.12 * u, -u, fs * 0.9, "female", "start");
      }
      // age labels along the arm centre line, kept upright
      const every = [2, 4, 6].find((n) => n * spec.step * u >= 44) ?? 6;
      const names = spec.symmetric ? this.fertAges : this.ages;
      const rad = (r * Math.PI) / 180;
      let rot = spec.symmetric ? 0 : r - 90;
      if (rot < -90) rot += 180;
      for (let k = 0; k < spec.groups; k++) {
        if (!spec.symmetric && k % every !== 1) continue;
        const d = (1 + GAP + (k + 0.5) * spec.step) * u;
        const px = d * Math.sin(rad), py = -d * Math.cos(rad);
        const lab = el("text", { class: "g-age", "text-anchor": "middle", "dominant-baseline": "central", "font-size": fs * 0.85, transform: `translate(${px},${py}) rotate(${rot})` }, this.labels);
        lab.textContent = names[k];
      }
    }
  }

  set(primary: Profile, compare: Profile | null) {
    this.data = { pop: [primary.popM, primary.popF], deaths: [primary.deathsM, primary.deathsF], fert: [primary.fert, primary.fert] };
    this.cmp = compare ? { pop: [compare.popM, compare.popF], deaths: [compare.deathsM, compare.deathsF], fert: [compare.fert, compare.fert] } : null;
    this.draw();
  }

  setProjection(on: boolean) {
    this.svg.classList.toggle("is-projection", on);
  }

  private draw() {
    if (!this.data) return;
    const u = this.unit;
    for (const arm of this.arms) {
      const { spec } = arm;
      const [L, R] = this.data[spec.key];
      const cmp = this.cmp?.[spec.key];
      const k = (SQ3 * u) / spec.max;
      const h = spec.thickness * u;
      for (let i = 0; i < spec.groups; i++) {
        const y = -(1 + GAP + (i + 1) * spec.step) * u + (spec.step * u - h) / 2;
        const lv = spec.symmetric ? L[i] / 2 : L[i];
        const rv = spec.symmetric ? R[i] / 2 : R[i];
        this.bar(arm.left[i], -1, lv * k, y, h);
        this.bar(arm.right[i], 1, rv * k, y, h);
        if (cmp) {
          const cl = spec.symmetric ? cmp[0][i] / 2 : cmp[0][i];
          const cr = spec.symmetric ? cmp[1][i] / 2 : cmp[1][i];
          this.bar(arm.cLeft[i], -1, cl * k, y, h);
          this.bar(arm.cRight[i], 1, cr * k, y, h);
        } else {
          arm.cLeft[i].setAttribute("width", "0");
          arm.cRight[i].setAttribute("width", "0");
        }
      }
    }
  }

  private bar(r: SVGRectElement, side: number, len: number, y: number, h: number) {
    const w = Number.isFinite(len) ? Math.max(len, 0) : 0;
    r.setAttribute("x", String(side < 0 ? -w : 0));
    r.setAttribute("y", String(y));
    r.setAttribute("width", String(w));
    r.setAttribute("height", String(h));
    r.setAttribute("rx", String(Math.min(h / 2, w / 2)));
  }

  /** Map a pointer position to an arm and age group. */
  hit(e: PointerEvent): boolean {
    if (!this.data) return false;
    const box = this.svg.getBoundingClientRect();
    const x = e.clientX - box.left - this.cx;
    const y = e.clientY - box.top - this.cy;
    const u = this.unit;
    for (const arm of this.arms) {
      const { spec } = arm;
      const a = (-spec.rotate * Math.PI) / 180; // inverse rotation
      const lx = x * Math.cos(a) - y * Math.sin(a);
      const ly = x * Math.sin(a) + y * Math.cos(a);
      const d = -ly / u - 1 - GAP;
      const i = Math.floor(d / spec.step);
      if (i < 0 || i >= spec.groups || Math.abs(lx) > SQ3 * u * 1.05) continue;
      const [L, R] = this.data[spec.key];
      const cmp = this.cmp?.[spec.key];
      this.onHover(
        {
          arm: spec.title,
          age: spec.symmetric ? this.fertAges[i] : this.ages[i],
          left: L[i],
          right: R[i],
          cLeft: cmp ? cmp[0][i] : NaN,
          cRight: cmp ? cmp[1][i] : NaN,
          symmetric: spec.symmetric,
        },
        e.clientX - box.left,
        e.clientY - box.top,
      );
      return true;
    }
    this.onHover(null, 0, 0);
    return false;
  }
}
