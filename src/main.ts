import "./styles.css";
import { Dataset, emptyProfile, oldAgeDependency, type Place, type Profile } from "./data";
import { Glyph, type ReadoutRow } from "./glyph";
import { WorldMap, type WorldData } from "./map";
import { formatPopulation, fmt, pct } from "./format";

declare global {
  interface Window {
    __WORLD__?: WorldData; // used by the single-file build
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const PLAY_SPEED = 9; // years per second

async function loadWorld(): Promise<WorldData> {
  if (window.__WORLD__) return window.__WORLD__;
  const res = await fetch(`${import.meta.env.BASE_URL}data/world.json`);
  if (!res.ok) throw new Error(`The map could not be loaded (HTTP ${res.status}).`);
  return res.json();
}

class App {
  private primary: Place;
  private compare: Place | null = null;
  private year: number;
  private playing = false;
  private target = emptyProfile();
  private shown = emptyProfile();
  private cmpTarget = emptyProfile();
  private cmpShown = emptyProfile();
  private glyph: Glyph;
  private map: WorldMap;
  private raf = 0;
  private last = 0;
  private statsKey = "";
  private pickerMode: "place" | "compare" = "place";

  constructor(private data: Dataset, world: WorldData) {
    const hash = new URLSearchParams(location.hash.slice(1));
    this.primary = data.byCode(Number(hash.get("place"))) ?? data.byCode(156)!;
    this.compare = data.byCode(Number(hash.get("vs"))) ?? null;
    const y = Number(hash.get("year"));
    this.year = y >= data.yearStart && y <= data.yearEnd ? Math.round(y) : data.lastEstimate;

    this.glyph = new Glyph($<HTMLElement>("glyph") as unknown as SVGSVGElement, data.ages, data.fertAges, (row, x, y) => this.tooltip(row, x, y));
    this.map = new WorldMap($<HTMLCanvasElement>("map"), world, (code) => {
      const place = data.byCode(code);
      if (place) this.setPrimary(place);
    });

    this.bindStage();
    this.bindControls();
    this.buildPicker();
    new ResizeObserver(() => this.resize()).observe($("stage"));
    this.resize();

    // start with bars growing from zero
    this.data.profile(this.primary.index, this.year, this.target);
    this.updatePlace(false);
    $("status").hidden = true;
    document.body.classList.add("is-ready");
  }

  // ---------- state ---------------------------------------------------------
  private setPrimary(place: Place) {
    if (this.compare?.code === place.code) this.compare = null;
    this.primary = place;
    this.updatePlace(true);
  }

  private setCompare(place: Place | null) {
    this.compare = place && place.code !== this.primary.code ? place : null;
    if (this.compare) this.cmpShown = this.copy(this.shown);
    this.updatePlace(true);
  }

  private setYear(y: number) {
    this.year = Math.min(Math.max(y, this.data.yearStart), this.data.yearEnd);
    this.kick();
  }

  private updatePlace(animate: boolean) {
    const p = this.primary;
    $("place-name").textContent = p.name;
    $("place-region").textContent = p.area === "Aggregate" ? (p.code === 900 ? "All countries and areas" : "Region") : p.region;
    $("compare-btn").textContent = this.compare ? `vs ${this.compare.name}` : "Compare";
    $("compare-btn").classList.toggle("is-on", !!this.compare);
    $("compare-clear").hidden = !this.compare;
    $("legend-cmp").hidden = !this.compare;
    $("legend-cmp-name").textContent = this.compare?.name ?? "";
    document.title = `${p.name}, demographic profile | Demography Atlas`;
    this.map.select(p.code, this.compare?.code ?? null, (code) => this.members(code), animate && !reducedMotion.matches);
    this.statsKey = "";
    this.kick();
  }

  private members(code: number): number[] {
    if (code === 900) return [];
    const place = this.data.byCode(code);
    if (place?.area === "Aggregate") return this.data.places.filter((p) => p.area === place.name).map((p) => p.code);
    return [code];
  }

  // ---------- animation loop -------------------------------------------------
  private kick() {
    if (!this.raf) {
      this.last = performance.now();
      this.raf = requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number) {
    const dt = Math.min(now - this.last, 64);
    this.last = now;
    if (this.playing) {
      this.year += (dt / 1000) * PLAY_SPEED;
      if (this.year >= this.data.yearEnd) {
        this.year = this.data.yearEnd;
        this.setPlaying(false);
      }
    }
    this.data.profile(this.primary.index, this.year, this.target);
    if (this.compare) this.data.profile(this.compare.index, this.year, this.cmpTarget);

    const k = reducedMotion.matches ? 1 : 1 - Math.exp(-dt / 70);
    let moving = this.approach(this.shown, this.target, k);
    if (this.compare) moving = this.approach(this.cmpShown, this.cmpTarget, k) || moving;

    this.glyph.set(this.shown, this.compare ? this.cmpShown : null);
    this.glyph.setProjection(this.year > this.data.lastEstimate + 0.5);
    this.updateTime();

    if (moving || this.playing) this.raf = requestAnimationFrame((t) => this.frame(t));
    else this.raf = 0;
  }

  /** Ease shown values towards target; returns true while still moving. */
  private approach(shown: Profile, target: Profile, k: number) {
    let moving = false;
    for (const key of ["popM", "popF", "deathsM", "deathsF", "fert"] as const) {
      const s = shown[key], t = target[key];
      for (let i = 0; i < s.length; i++) {
        if (!Number.isFinite(t[i])) s[i] = NaN;
        else if (!Number.isFinite(s[i])) (s[i] = 0), (moving = true);
        else {
          const d = t[i] - s[i];
          if (Math.abs(d) > 0.004) (s[i] += d * k), (moving = true);
          else s[i] = t[i];
        }
      }
    }
    return moving;
  }

  private copy(p: Profile): Profile {
    const out = emptyProfile();
    for (const key of ["popM", "popF", "deathsM", "deathsF", "fert"] as const) out[key].set(p[key]);
    return out;
  }

  // ---------- controls ------------------------------------------------------
  private updateTime() {
    const y = Math.round(this.year);
    const slider = $<HTMLInputElement>("slider");
    if (Number(slider.value) !== y) slider.value = String(y);
    $("year").textContent = String(y);
    $("phase").textContent = y > this.data.lastEstimate ? "Projection" : "Estimate";
    const key = `${this.primary.code}/${this.compare?.code ?? ""}/${y}`;
    if (key !== this.statsKey) {
      this.statsKey = key;
      this.updateStats(y);
      this.writeHash(y);
    }
  }

  private updateStats(y: number) {
    const a = this.data.profile(this.primary.index, y);
    const b = this.compare ? this.data.profile(this.compare.index, y) : null;
    const rows: Record<string, (p: Profile) => string> = {
      population: (p) => formatPopulation(p.population),
      medianAge: (p) => `${fmt(p.medianAge, 1)} years`,
      tfr: (p) => fmt(p.tfr, 2),
      e0: (p) => `${fmt(p.e0, 1)} years`,
      oldAge: (p) => fmt(oldAgeDependency(p), 0),
    };
    for (const dd of document.querySelectorAll<HTMLElement>("#stats dd")) {
      const f = rows[dd.dataset.k!];
      dd.replaceChildren();
      const main = document.createElement("span");
      main.className = "v";
      main.textContent = f(a);
      dd.append(main);
      if (b && this.compare) {
        const c = document.createElement("span");
        c.className = "c";
        c.textContent = `${this.compare.name}: ${f(b)}`;
        dd.append(c);
      }
    }
  }

  private writeHash(y: number) {
    const params = new URLSearchParams({ place: String(this.primary.code), year: String(y) });
    if (this.compare) params.set("vs", String(this.compare.code));
    try {
      history.replaceState(null, "", `#${params}`);
    } catch {
      /* sandboxed frames may block history updates */
    }
  }

  private setPlaying(on: boolean) {
    this.playing = on;
    $("play").setAttribute("aria-label", on ? "Pause" : "Play from this year");
    $("play-icon").setAttribute("d", on ? "M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" : "M7 4.5v15l12.5-7.5z");
    if (on) this.kick();
  }

  private bindControls() {
    const slider = $<HTMLInputElement>("slider");
    slider.min = String(this.data.yearStart);
    slider.max = String(this.data.yearEnd);
    const split = ((this.data.lastEstimate + 0.5 - this.data.yearStart) / (this.data.yearEnd - this.data.yearStart)) * 100;
    slider.style.setProperty("--split", `${split}%`);
    slider.addEventListener("input", () => {
      this.setPlaying(false);
      this.setYear(Number(slider.value));
    });
    $("play").addEventListener("click", () => {
      if (!this.playing && this.year >= this.data.yearEnd) this.year = this.data.yearStart;
      this.setPlaying(!this.playing);
    });
    $("place-btn").addEventListener("click", () => this.openPicker("place"));
    $("compare-btn").addEventListener("click", () => this.openPicker("compare"));
    $("compare-clear").addEventListener("click", () => this.setCompare(null));
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || $<HTMLDialogElement>("picker").open) return;
      if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        $("play").click();
      }
    });
  }

  private bindStage() {
    const stage = $("stage");
    let down: { x: number; y: number; hit: boolean } | null = null;
    let hideTimer = 0;
    stage.addEventListener("pointermove", (e) => {
      if (e.pointerType === "mouse") stage.classList.toggle("is-over-bars", this.glyph.hit(e));
    });
    stage.addEventListener("pointerleave", () => this.tooltip(null, 0, 0));
    stage.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest("button, .legend")) return;
      const hit = this.glyph.hit(e);
      down = { x: e.clientX, y: e.clientY, hit };
      if (hit && e.pointerType !== "mouse") {
        clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => this.tooltip(null, 0, 0), 3000);
      }
    });
    stage.addEventListener("pointerup", (e) => {
      if (down && !down.hit && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) this.map.pick(e);
      down = null;
    });
  }

  private resize() {
    const stage = $("stage");
    const { width, height } = stage.getBoundingClientRect();
    if (!width || !height) return;
    const headH = ($("stage").querySelector(".head") as HTMLElement).offsetHeight;
    this.glyph.resize(width, height, headH);
    this.map.resize(width, height, this.glyph.cx, this.glyph.cy, this.glyph.lensRadius);
    this.kick();
  }

  private tooltip(row: ReadoutRow | null, x: number, y: number) {
    const tip = $("tooltip");
    if (!row) {
      tip.hidden = true;
      return;
    }
    const lines = [`<strong>${row.arm}</strong>`, `Aged ${row.age}`];
    const cmpName = this.compare?.name;
    if (row.symmetric) {
      lines.push(`${pct(row.left)} of births`);
      if (cmpName) lines.push(`${cmpName}: ${pct(row.cLeft)}`);
    } else {
      lines.push(`Male ${pct(row.left)}, female ${pct(row.right)}`);
      if (cmpName) lines.push(`${cmpName}: male ${pct(row.cLeft)}, female ${pct(row.cRight)}`);
    }
    tip.innerHTML = lines.map((l) => `<span>${l}</span>`).join("");
    tip.hidden = false;
    const stage = $("stage").getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const left = Math.min(Math.max(x - tw / 2, 8), stage.width - tw - 8);
    const top = y - th - 16 < 8 ? y + 20 : y - th - 16;
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }

  // ---------- picker ----------------------------------------------------------
  private buildPicker() {
    const list = $("picker-list");
    const input = $<HTMLInputElement>("picker-input");
    const aggregates = this.data.places.filter((p) => p.area === "Aggregate");
    const countries = this.data.places.filter((p) => p.area !== "Aggregate").sort((a, b) => a.name.localeCompare(b.name));
    const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const items: { li: HTMLLIElement; text: string }[] = [];
    const group = (title: string, places: Place[]) => {
      const h = document.createElement("li");
      h.className = "picker-group";
      h.textContent = title;
      list.append(h);
      for (const p of places) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `<span>${p.name}</span><small>${p.area === "Aggregate" ? "" : p.region}</small>`;
        b.addEventListener("click", () => this.choose(p));
        li.append(b);
        list.append(li);
        items.push({ li, text: norm(`${p.name} ${p.region} ${p.area}`) });
      }
    };
    group("World and regions", aggregates);
    group("Countries and areas", countries);
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
    $("picker-title").textContent = mode === "place" ? "Choose a place" : `Compare ${this.primary.name} with`;
    const input = $<HTMLInputElement>("picker-input");
    input.value = "";
    input.dispatchEvent(new Event("input"));
    $<HTMLDialogElement>("picker").showModal();
    if (matchMedia("(pointer: fine)").matches) input.focus();
  }

  private choose(p: Place) {
    $<HTMLDialogElement>("picker").close();
    if (this.pickerMode === "place") this.setPrimary(p);
    else this.setCompare(p);
  }
}

Promise.all([Dataset.load(), loadWorld()])
  .then(([data, world]) => new App(data, world))
  .catch((err: Error) => {
    $("status").textContent = `${err.message} Reload the page to try again.`;
    console.error(err);
  });
