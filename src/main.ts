import "./styles.css";
import { Dataset, emptyProfile, oldAgeDependency, type Place, type Profile } from "./data";
import { Glyph, type ReadoutRow } from "./glyph";
import { WorldMap, type WorldData } from "./map";
import { formatPopulation, fmt, pct, compact } from "./format";
import { PopulationChart, ChangeChart, type ChangeMode } from "./charts";
import { SITE } from "./site";
import { Details } from "./details";

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
  private year: number; // target year
  private yearShown: number; // eased year that is drawn
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
  private popChart: PopulationChart;
  private changeChart: ChangeChart;
  private changeMode: ChangeMode = "people";
  private seriesCache = new Map<number, Float64Array>();
  private details: Details;
  // chart position: follows the map, gliding when it jumps to a new place
  private anchorTarget = { x: 0, y: 0 };
  private anchorShown = { x: 0, y: 0 };
  private glideUntil = 0;

  constructor(private data: Dataset, world: WorldData) {
    const hash = new URLSearchParams(location.hash.slice(1));
    this.primary = data.byCode(Number(hash.get("place"))) ?? data.byCode(156)!;
    this.compare = data.byCode(Number(hash.get("vs"))) ?? null;
    const y = Number(hash.get("year"));
    this.year = y >= data.yearStart && y <= data.yearEnd ? Math.round(y) : data.lastEstimate;
    this.yearShown = this.year;

    this.glyph = new Glyph($<HTMLElement>("glyph") as unknown as SVGSVGElement, data.ages, data.fertAges, (row, x, y) => this.tooltip(row, x, y));
    this.map = new WorldMap($<HTMLCanvasElement>("map"), world, (x, y, offHome) => {
      this.anchorTarget = { x, y };
      if (performance.now() < this.glideUntil) this.kick();
      else {
        this.anchorShown = { x, y };
        this.glyph.setAnchor(x, y);
      }
      $("recenter").hidden = !offHome;
    });

    this.popChart = new PopulationChart($("pop-chart"), data.yearStart, data.lastEstimate);
    this.changeChart = new ChangeChart($("change-chart"), data.lastEstimate);
    this.renderSiteInfo();
    this.details = new Details(
      data,
      () => ({ primary: this.primary, compare: this.compare, year: Math.round(this.year) }),
      (y) => {
        this.setPlaying(false);
        this.setYear(y);
        const slider = $<HTMLInputElement>("slider");
        slider.value = String(y);
        this.statsKey = "";
      },
    );
    if (this.compare) {
      this.changeMode = "rate";
      for (const btn of document.querySelectorAll<HTMLButtonElement>(".toggle button")) btn.setAttribute("aria-pressed", String(btn.dataset.mode === "rate"));
    }
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
  private setPrimary(place: Place, stay = false) {
    if (this.compare?.code === place.code) this.compare = null;
    this.primary = place;
    if (stay) this.glideUntil = performance.now() + 700;
    this.updatePlace(true, stay);
  }

  private setCompare(place: Place | null) {
    this.compare = place && place.code !== this.primary.code ? place : null;
    // growth rates compare fairly between places of very different size
    const mode: ChangeMode = this.compare ? "rate" : "people";
    if (mode !== this.changeMode) document.querySelector<HTMLButtonElement>(`.toggle button[data-mode="${mode}"]`)?.click();
    if (this.compare) this.cmpShown = this.copy(this.shown);
    this.updatePlace(true);
  }

  private setYear(y: number) {
    this.year = Math.min(Math.max(y, this.data.yearStart), this.data.yearEnd);
    this.kick();
  }

  private updatePlace(animate: boolean, stay = false) {
    const p = this.primary;
    $("place-name").textContent = p.name;
    $("place-region").textContent = p.area === "Aggregate" ? (p.code === 900 ? "All countries and areas" : "Region") : p.region;
    $("recenter-name").textContent = p.name;
    $("compare-btn").textContent = this.compare ? `vs ${this.compare.name}` : "Compare";
    $("compare-btn").classList.toggle("is-on", !!this.compare);
    $("compare-clear").hidden = !this.compare;
    $("legend-cmp").hidden = !this.compare;
    $("legend-cmp-name").textContent = this.compare?.name ?? "";
    document.title = `${p.name}, demographic profile | Demography Atlas`;
    this.map.select(p.code, this.compare?.code ?? null, (code) => this.members(code), animate && !reducedMotion.matches, stay);
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
    const reduce = reducedMotion.matches;
    if (this.playing) {
      this.year += (dt / 1000) * PLAY_SPEED;
      if (this.year >= this.data.yearEnd) {
        this.year = this.data.yearEnd;
        this.setPlaying(false);
      }
      this.yearShown = this.year;
    } else {
      // glide through the in-between years instead of jumping
      const d = this.year - this.yearShown;
      this.yearShown = reduce || Math.abs(d) < 0.002 ? this.year : this.yearShown + d * (1 - Math.exp(-dt / 110));
    }
    this.data.profile(this.primary.index, this.yearShown, this.target);
    if (this.compare) this.data.profile(this.compare.index, this.yearShown, this.cmpTarget);

    const k = reduce ? 1 : 1 - Math.exp(-dt / 120);
    let moving = this.yearShown !== this.year;
    moving = this.approach(this.shown, this.target, k) || moving;
    if (this.compare) moving = this.approach(this.cmpShown, this.cmpTarget, k) || moving;

    if (this.anchorShown.x !== this.anchorTarget.x || this.anchorShown.y !== this.anchorTarget.y) {
      const kk = reducedMotion.matches || now > this.glideUntil ? 1 : 1 - Math.exp(-dt / 90);
      const dx = this.anchorTarget.x - this.anchorShown.x, dy = this.anchorTarget.y - this.anchorShown.y;
      if (Math.hypot(dx, dy) < 0.5) this.anchorShown = { ...this.anchorTarget };
      else (this.anchorShown.x += dx * kk), (this.anchorShown.y += dy * kk), (moving = true);
      this.glyph.setAnchor(this.anchorShown.x, this.anchorShown.y);
    }
    this.glyph.set(this.shown, this.compare ? this.cmpShown : null);
    this.glyph.setProjection(this.yearShown > this.data.lastEstimate + 0.5);
    this.glyph.setYear(Math.round(this.yearShown), Math.round(this.yearShown) > this.data.lastEstimate);
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
          if (Math.abs(d) > 0.002) (s[i] += d * k), (moving = true);
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
    const y = Math.round(this.yearShown);
    const slider = $<HTMLInputElement>("slider");
    if (Number(slider.value) !== y && (this.playing || document.activeElement !== slider)) slider.value = String(y);
    const bubble = $("year");
    bubble.textContent = String(y);
    bubble.style.setProperty("--pos", String((this.yearShown - this.data.yearStart) / (this.data.yearEnd - this.data.yearStart)));
    bubble.classList.toggle("is-proj", y > this.data.lastEstimate);
    const key = `${this.primary.code}/${this.compare?.code ?? ""}/${y}`;
    if (key !== this.statsKey) {
      this.statsKey = key;
      this.updateStats(y);
      this.updateTrends(y);
      this.details.refresh();
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

  private series(place: Place) {
    let s = this.seriesCache.get(place.index);
    if (!s) this.seriesCache.set(place.index, (s = this.data.populationSeries(place.index)));
    return s;
  }

  /** Trend chart, 5-year change chart, summary sentence and verification link. */
  private updateTrends(y: number) {
    const a = this.primary, b = this.compare;
    this.popChart.update(this.series(a), b ? this.series(b) : null, y, a.name, b?.name ?? null);

    const end = Math.max(y, this.data.yearStart + 4);
    const years = [end - 4, end - 3, end - 2, end - 1, end];
    const rows = (p: Place) => years.map((yr) => this.data.annualFigures(p.index, yr)!);
    const ra = rows(a);
    this.changeChart.update(ra, b ? rows(b) : null, a.name, b?.name ?? null, this.changeMode);
    $("change-title").textContent = `Population change, ${years[0]}–${end}`;
    $("change-legend").hidden = !b;
    if (b) $("change-legend").textContent = `Filled bars: ${a.name}. Outlined bars: ${b.name}. Green is growth, red is decline.`;

    // 1 July population five years apart
    const from = Math.max(end - 5, this.data.yearStart);
    const sentence = (p: Place) => {
      const p0 = this.data.annualFigures(p.index, from)!.population;
      const p1 = this.data.annualFigures(p.index, end)!.population;
      const diff = p1 - p0;
      const pctChange = (diff / p0) * 100;
      const verb = diff > 0 ? "grew" : diff < 0 ? "shrank" : "did not change";
      const tense = end > this.data.lastEstimate ? (diff >= 0 ? "is projected to grow" : "is projected to shrink") : verb;
      return `${p.name} ${tense} from ${compact(p0, true)} to ${compact(p1, true)} (${diff >= 0 ? "+" : "−"}${fmt(Math.abs(pctChange), 1)}%) between 1 July ${from} and 1 July ${end}.`;
    };
    $("change-summary").textContent = [sentence(a), b ? sentence(b) : ""].filter(Boolean).join(" ");

    const codes = [a.code, b?.code].filter((c) => c !== undefined).join(",");
    // UN Data Portal indicators: 49 total population, 50 population change, 57 births, 60 deaths, 65 net migration
    ($("verify-link") as HTMLAnchorElement).href =
      `https://population.un.org/dataportal/data/indicators/49,50,57,60,65/locations/${codes}/start/${from}/end/${end}/table/pivotbylocation`;
  }

  private renderSiteInfo() {
    const { lab, author, contact, repository } = SITE;
    const setText = (id: string, text: string) => {
      const el = $(id);
      el.textContent = text;
      el.hidden = !text;
    };
    if (lab.name || lab.intro) {
      $("lab").hidden = false;
      $("lab-name").textContent = lab.name ? `About ${lab.name}` : "About the lab";
      setText("lab-affiliation", lab.affiliation);
      setText("lab-intro", lab.intro);
      if (lab.website) {
        const link = $("lab-website");
        link.hidden = false;
        link.replaceChildren(Object.assign(document.createElement("a"), { href: lab.website, textContent: "Visit the lab website", target: "_blank", rel: "noopener" }));
      }
    }
    const items: [string, string, string][] = [];
    if (contact.email) items.push(["Email", `mailto:${contact.email}`, contact.email]);
    if (contact.linkedin) items.push(["LinkedIn", contact.linkedin, contact.linkedin.replace(/^https?:\/\/(www\.)?/, "")]);
    if (contact.github) items.push(["GitHub", contact.github, contact.github.replace(/^https?:\/\//, "")]);
    if (repository) items.push(["Source code and issues", `${repository}/issues`, repository.replace(/^https?:\/\//, "")]);
    $("contact-list").replaceChildren(
      ...items.map(([label, href, text]) => {
        const li = document.createElement("li");
        li.append(`${label}: `, Object.assign(document.createElement("a"), { href, textContent: text, target: href.startsWith("mailto:") ? "" : "_blank", rel: "noopener" }));
        return li;
      }),
    );
    if (contact.location) $("contact-list").append(Object.assign(document.createElement("li"), { textContent: `Based in ${contact.location}` }));
    const who = [author.name, author.role].filter(Boolean).join(", ");
    $("site-foot").textContent = `Built by ${who}${lab.name ? `, ${lab.name}` : ""}. Code under the MIT License. Data © United Nations, CC BY 3.0 IGO.`;
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
      if (!this.playing && this.year >= this.data.yearEnd) this.year = this.yearShown = this.data.yearStart;
      else this.year = this.yearShown;
      this.setPlaying(!this.playing);
    });
    $("place-btn").addEventListener("click", () => this.openPicker("place"));
    $("compare-btn").addEventListener("click", () => this.openPicker("compare"));
    $("compare-clear").addEventListener("click", () => this.setCompare(null));
    $("details-btn").addEventListener("click", () => this.details.open());
    $("details-link").addEventListener("click", () => this.details.open());
    for (const btn of document.querySelectorAll<HTMLButtonElement>(".toggle button")) {
      btn.addEventListener("click", () => {
        this.changeMode = btn.dataset.mode as ChangeMode;
        for (const other of document.querySelectorAll<HTMLButtonElement>(".toggle button")) other.setAttribute("aria-pressed", String(other === btn));
        this.statsKey = "";
        this.kick();
      });
    }
    $("recenter").addEventListener("click", () => this.map.recenter(!reducedMotion.matches));
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || $<HTMLDialogElement>("picker").open || this.details.isOpen) return;
      if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        $("play").click();
      }
    });
  }

  private bindStage() {
    const stage = $("stage");
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { startX: number; startY: number; moved: boolean; t: number; vx: number; vy: number } | null = null;
    let pinch: { dist: number; mx: number; my: number } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    let hideTimer = 0;
    const local = (e: { clientX: number; clientY: number }) => {
      const box = stage.getBoundingClientRect();
      return { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const pinchState = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const openAt = (x: number, y: number) => {
      const code = this.map.pickAt(x, y);
      const place = code === null ? undefined : this.data.byCode(code);
      if (place) {
        this.tooltip(null, 0, 0);
        this.setPrimary(place, true); // keep the map still; the chart moves to the place
      }
    };

    stage.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest("button, .legend, .tooltip, .timeline")) return;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      pointers.set(e.pointerId, local(e));
      this.map.stop();
      if (pointers.size === 2) {
        pinch = pinchState();
        drag = null;
        this.tooltip(null, 0, 0);
        return;
      }
      const p = local(e);
      drag = { startX: p.x, startY: p.y, moved: false, t: performance.now(), vx: 0, vy: 0 };
    });

    stage.addEventListener("pointermove", (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        // plain mouse hover: readout for the bars
        if (e.pointerType === "mouse") stage.classList.toggle("is-over-bars", this.glyph.hit(e));
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
        // smoothed velocity for the fling
        drag.vx = drag.vx * 0.6 + (dx / dtm) * 0.4;
        drag.vy = drag.vy * 0.6 + (dy / dtm) * 0.4;
        drag.t = now;
      }
    });

    const end = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      stage.classList.remove("is-dragging");
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
        if (isDouble) openAt(p.x, p.y);
        else if (this.glyph.hit(e)) {
          if (e.pointerType !== "mouse") {
            clearTimeout(hideTimer);
            hideTimer = window.setTimeout(() => this.tooltip(null, 0, 0), 3000);
          }
        } else this.tooltip(null, 0, 0);
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
        if ((e.target as Element).closest(".timeline")) return;
        e.preventDefault();
        const p = local(e);
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.map.zoomAt(Math.exp(-delta * 0.0016), p.x, p.y);
      },
      { passive: false },
    );
    stage.addEventListener("dblclick", (e) => e.preventDefault());
  }

  private resize() {
    const stage = $("stage");
    const { width, height } = stage.getBoundingClientRect();
    if (!width || !height) return;
    const headH = ($("stage").querySelector(".head") as HTMLElement).offsetHeight;
    const legend = stage.querySelector(".legend") as HTMLElement;
    const bottomH = height - legend.offsetTop + 6; // timeline and legend sit at the bottom
    this.glyph.resize(width, height, headH, bottomH);
    this.map.resize(width, height, this.glyph.homeX, this.glyph.homeY, this.glyph.lensRadius);
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
