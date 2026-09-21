import "./styles.css";
import { Dataset, emptyProfile, oldAgeDependency, type Place, type Profile } from "./data";
import { Glyph, worldArms, profileArms, type ReadoutRow } from "./glyph";
import { ChartMotion } from "./motion";
import { WorldMap, type WorldData, type MapExtras } from "./map";
import { loadPkGeo } from "./pkgeo";
import { formatPopulation, fmt, pct, compact } from "./format";
import { PopulationChart, ChangeChart, type ChangeMode } from "./charts";
import { SITE } from "./site";
import { Details } from "./details";
import { YearPicker } from "./yearpicker";
import { SearchBox, searchMarkup } from "./search";
import { Tour, tourMarkup } from "./tour";
import { initTheme } from "./theme";

declare global {
  interface Window {
    __WORLD__?: WorldData; // used by the single-file build
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const PLAY_SPEED = 4; // years per second
const CURRENT_YEAR = 2023; // last UN WPP 2024 estimate year (2024+ are projections)

/** GDP per capita (USD, 2025, World Bank API: NY.GDP.PCAP.CD). Key = ISO 3166-1 numeric code. */
const GDP_PER_CAPITA: Record<number, number> = {
  8: 12998, 12: 6051, 20: 54292, 24: 3129, 28: 24819, 31: 7411, 32: 14898, 36: 65130,
  40: 62930, 48: 30597, 50: 2597, 51: 9474, 52: 28365, 56: 60750, 64: 4493, 68: 5148,
  70: 10382, 72: 7778, 76: 10713, 84: 7865, 90: 2086, 96: 32235, 100: 20328, 104: 1489,
  108: 234, 112: 10279, 116: 2872, 120: 1972, 124: 55698, 132: 5796, 140: 556,
  144: 5002, 148: 1022, 152: 17995, 156: 13862, 170: 8562, 174: 2056, 178: 2515,
  188: 19970, 191: 27104, 196: 41783, 203: 35917, 204: 1658, 208: 76970, 212: 10989,
  214: 11059, 218: 7125, 222: 5767, 226: 6615, 231: 933, 233: 34418, 242: 6642,
  246: 56149, 250: 48986, 262: 3906, 266: 8263, 270: 919, 275: 3171, 276: 60496,
  288: 3257, 296: 2559, 300: 26948, 308: 12107, 320: 6598, 324: 1877, 328: 32414,
  332: 2694, 340: 3598, 344: 56983, 348: 25907, 352: 98323, 356: 2702, 360: 5060,
  364: 3924, 368: 5410, 372: 131592, 376: 60337, 380: 43309, 384: 3050, 388: 8003,
  392: 35951, 398: 14692, 400: 5348, 404: 2363, 414: 32312, 417: 3081, 418: 2325,
  426: 1089, 428: 26312, 430: 915, 434: 6449, 440: 32959, 442: 147252, 446: 75902,
  450: 599, 454: 672, 458: 13125, 462: 14615, 466: 1193, 470: 47907, 478: 2198,
  480: 12991, 484: 13889, 496: 7108, 499: 14817, 504: 4672, 508: 627, 512: 19947,
  516: 4876, 520: 14640, 524: 1536, 528: 73684, 534: 42978, 548: 4039, 554: 49591,
  558: 3173, 562: 775, 566: 1224, 578: 94594, 583: 4414, 584: 8489, 585: 19532,
  586: 1596, 591: 19790, 598: 3020, 600: 7027, 604: 9684, 608: 4171, 616: 28420,
  620: 32082, 626: 1341, 630: 40620, 634: 72525, 642: 22538, 643: 17547, 646: 1124,
  662: 14746, 670: 12562, 678: 4084, 682: 34537, 686: 1955, 688: 15262, 690: 19449,
  694: 846, 702: 98814, 703: 28544, 704: 5066, 705: 37376, 706: 661, 710: 6598,
  716: 3021, 724: 38627, 729: 1165, 740: 7070, 748: 4108, 752: 63133, 756: 114769,
  762: 1637, 764: 8057, 768: 1384, 776: 6547, 780: 18967,   788: 4657,
  792: 18599, 795: 6540, 798: 6041, 800: 1206, 804: 5866, 818: 3086, 826: 57602,
  834: 1319, 840: 90027, 854: 1148, 858: 25216, 860: 3968, 862: 3495, 882: 5873,
  894: 1318,
};

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
  private motion = new ChartMotion(() => reducedMotion.matches);
  private yearPicker!: YearPicker;
  private tour!: Tour;
  private flightMs: number | undefined; // shorter flights during the tour
  private chartDrag: { dx: number; dy: number; id: number } | null = null;
  private chartMoved = false;
  private places: WorldData["places"];

  constructor(private data: Dataset, world: WorldData, extras: MapExtras) {
    this.places = world.places;
    const hash = new URLSearchParams(location.hash.slice(1));
    this.primary = data.byCode(Number(hash.get("place"))) ?? data.byCode(586)!; // Pakistan by default
    this.compare = data.byCode(Number(hash.get("vs"))) ?? null;
    const y = Number(hash.get("year"));
    this.year = y >= data.yearStart && y <= data.yearEnd ? Math.round(y) : Math.min(Math.max(CURRENT_YEAR, data.yearStart), data.yearEnd); // current year by default
    this.yearShown = this.year;

    this.glyph = new Glyph($<HTMLElement>("glyph") as unknown as SVGSVGElement, worldArms(data.ages, data.fertAges), (row, x, y) => this.tooltip(row, x, y));
    this.map = new WorldMap($<HTMLCanvasElement>("map"), world, (x, y, offHome) => {
      this.anchorTarget = { x, y };
      if (this.chartDrag) return; // the chart follows the pointer while it is being dragged
      if (this.motion.active) {
        this.motion.follow(x, y);
        this.kick();
      } else {
        this.motion.snap(x, y);
        this.glyph.setAnchor(x, y);
        this.yearPicker?.place(x, y + this.glyph.pickerOffset);
      }
      $("recenter").hidden = !offHome;
    }, undefined, extras);

    this.popChart = new PopulationChart($("pop-chart"), data.yearStart, data.lastEstimate);
    this.changeChart = new ChangeChart($("change-chart"), data.lastEstimate);
    this.renderSiteInfo();
    this.details = new Details(
      data,
      () => ({ primary: this.primary, compare: this.compare, year: Math.round(this.year) }),
      (y) => {
        this.setPlaying(false);
        this.setYear(y);
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
    initTheme(() => this.map.repaint());
    $("search").innerHTML = searchMarkup;
    new SearchBox($("search"), (item) => {
      this.tour.stop();
      if (item.d) location.href = `./pakistan.html#d=${item.d}`; // district or tehsil: open the Pakistan section
      else {
        const place = item.c === undefined ? undefined : this.data.byCode(item.c);
        if (place) this.setPrimary(place);
      }
    });
    const tm = tourMarkup("Top 10 countries");
    $("tour-btn").innerHTML = tm.button;
    $("tour-caption").innerHTML = tm.caption;
    this.tour = new Tour(
      $<HTMLButtonElement>("tour-btn"),
      $("tour-caption"),
      () => {
        const y = Math.min(CURRENT_YEAR, this.data.yearEnd); // current year
        this.setYear(y);
        return this.data.places
          .filter((p) => p.area !== "Aggregate")
          .map((p) => ({ p, pop: this.data.annualFigures(p.index, y)?.population ?? NaN }))
          .filter((r) => Number.isFinite(r.pop))
          .sort((a, b) => b.pop - a.pop)
          .slice(0, 10)
          .map(({ p, pop }) => ({
            title: p.name,
            detail: `${compact(pop, true)} people in ${y}${y > this.data.lastEstimate ? ", UN projection" : ""}`,
            go: () => {
              this.setPlaying(false);
              this.compare = null;
              this.flightMs = 2200; // a slower, smoother flight during the tour
              this.setPrimary(p);
              this.flightMs = undefined;
              return this.map.lastFlightMs;
            },
          }));
      },
      "Top 10 countries",
    );
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
    if (stay && !this.chartDrag) this.motion.active = true; // glide to the place instead of jumping
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
    document.title = "HumanScape";
    this.map.select(p.code, this.compare?.code ?? null, (code) => this.members(code), animate && !reducedMotion.matches, stay, this.flightMs);
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
      this.yearShown = reduce || Math.abs(d) < 0.002 ? this.year : this.yearShown + d * (1 - Math.exp(-dt / 180));
    }
    this.data.profile(this.primary.index, this.yearShown, this.target);
    if (this.compare) this.data.profile(this.compare.index, this.yearShown, this.cmpTarget);

    const k = reduce ? 1 : 1 - Math.exp(-dt / 220);
    let moving = this.yearShown !== this.year;
    moving = this.approach(this.shown, this.target, k) || moving;
    if (this.compare) moving = this.approach(this.cmpShown, this.cmpTarget, k) || moving;

    if (this.motion.active) {
      moving = this.motion.step(dt) || moving;
      this.glyph.setAnchor(this.motion.x, this.motion.y);
      this.glyph.setMotion(this.motion.tilt, this.motion.lift);
    }
    this.glyph.set(profileArms(this.shown), this.compare ? profileArms(this.cmpShown) : null);
    this.yearPicker.place(this.glyph.cx, this.glyph.cy + this.glyph.pickerOffset);
    this.glyph.setProjection(this.yearShown > this.data.lastEstimate + 0.5);
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
    this.yearPicker.render(this.yearShown, this.playing);
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
    const getArea = (code: number) => {
      const place = this.places?.[String(code)];
      return place?.area ?? NaN;
    };
    const fmtArea = (km2: number) => Number.isFinite(km2) ? `${Math.round(km2).toLocaleString("en")} km²` : "not available";
    const world = this.data.places.find((p) => p.name === "World") ?? this.data.places[0];
    const worldPop = this.data.profile(world.index, y)?.population ?? 1;
    const rows: Record<string, (p: Profile, place?: Place) => string> = {
      population: (p) => formatPopulation(p.population),
      medianAge: (p) => `${fmt(p.medianAge, 1)} years`,
      tfr: (p) => fmt(p.tfr, 2),
      e0: (p) => `${fmt(p.e0, 1)} years`,
      oldAge: (p) => fmt(oldAgeDependency(p), 0),
      area: (_, place) => fmtArea(getArea(place?.code ?? this.primary.code)),
      worldShare: (p) => `${fmt(p.population / worldPop * 100, 2)}%`,
      gdp: (_, place) => GDP_PER_CAPITA[(place ?? this.primary).code] ? `$${GDP_PER_CAPITA[(place ?? this.primary).code]!.toLocaleString("en")}` : "not available",
    };
    for (const dd of document.querySelectorAll<HTMLElement>("#stats dd")) {
      const f = rows[dd.dataset.k!];
      if (!f) continue;
      dd.replaceChildren();
      const main = document.createElement("span");
      main.className = "v";
      main.textContent = f(a, this.primary);
      dd.append(main);
      if (b && this.compare) {
        const c = document.createElement("span");
        c.className = "c";
        c.textContent = `${this.compare.name}: ${dd.dataset.k === "area" ? fmtArea(getArea(this.compare.code)) : dd.dataset.k === "worldShare" ? `${fmt(b.population / worldPop * 100, 2)}%` : dd.dataset.k === "gdp" ? (GDP_PER_CAPITA[this.compare.code] ? `$${GDP_PER_CAPITA[this.compare.code]!.toLocaleString("en")}` : "not available") : f(b, this.compare)}`;
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
    const { lab, contact } = SITE;
    const link = (href: string, text: string) => Object.assign(document.createElement("a"), { href, textContent: text, target: href.startsWith("mailto:") ? "" : "_blank", rel: "noopener" });
    if (lab.name || lab.intro) {
      $("lab").hidden = false;
      $("lab-name").textContent = lab.name ? `About ${lab.name}` : "About the lab";
      const intro = $("lab-intro");
      intro.textContent = lab.intro;
      intro.hidden = !lab.intro;
      if (lab.website) {
        const p = $("lab-website");
        p.hidden = false;
        p.replaceChildren(link(lab.website, "Visit the GSAL website"));
      }
    }
    const rows: [string, Node | string][] = [];
    if (contact.address) rows.push(["Address", contact.address]);
    if (contact.coordinates && contact.mapsUrl) rows.push(["Location", link(contact.mapsUrl, `${contact.coordinates}, open in Google Maps`)]);
    if (contact.email) rows.push(["Email", link(`mailto:${contact.email}`, contact.email)]);
    if (contact.officeHours) rows.push(["Office hours", contact.officeHours]);
    if (contact.contactPage) rows.push(["Send a message", link(contact.contactPage, "Contact form on the GSAL website")]);
    $("contact-list").replaceChildren(
      ...rows.map(([label, value]) => {
        const li = document.createElement("li");
        const dt = document.createElement("strong");
        dt.textContent = label;
        li.append(dt, document.createElement("br"), value);
        return li;
      }),
    );
    $("site-foot").textContent = `HumanScape by ${lab.name}. Data © United Nations, CC BY 3.0 IGO.`;
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
    this.kick();
  }

  private togglePlay() {
    if (!this.playing && this.year >= this.data.yearEnd) this.year = this.yearShown = this.data.yearStart;
    else this.year = this.yearShown;
    this.setPlaying(!this.playing);
  }

  private bindControls() {
    this.yearPicker = new YearPicker(
      $("year-picker"),
      this.data.yearStart,
      this.data.yearEnd,
      this.data.lastEstimate,
      (year, done) => {
        this.setPlaying(false);
        if (done) this.setYear(year);
        else {
          // follow the finger exactly while sliding
          this.year = this.yearShown = year;
          this.kick();
        }
      },
      () => this.togglePlay(),
    );
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
    for (const btn of document.querySelectorAll<HTMLButtonElement>(".dock-tabs [role=tab]")) {
      btn.addEventListener("click", () => {
        for (const b of document.querySelectorAll<HTMLButtonElement>(".dock-tabs [role=tab]")) b.setAttribute("aria-selected", "false");
        btn.setAttribute("aria-selected", "true");
        for (const p of document.querySelectorAll<HTMLElement>(".dock-panel")) p.hidden = p.dataset.panel !== btn.dataset.tab;
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || $<HTMLDialogElement>("picker").open || this.details.isOpen) return;
      if (e.key === " " && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.togglePlay();
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
        this.setPrimary(place); // fly smoothly to the country
      }
    };

    stage.addEventListener("pointerdown", (e) => {
      if ((e.target as Element).closest("button, a, input, .search, .legend, .tooltip, .year-picker, .tour-caption")) return;
      this.tour.stop(); // the user takes over
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
      if (this.glyph.hitCore(e.clientX, e.clientY)) {
        // grab the triangle: it follows the pointer and opens the country beneath it
        this.chartDrag = { dx: this.glyph.cx - p.x, dy: this.glyph.cy - p.y, id: e.pointerId };
        this.chartMoved = false;
        this.tooltip(null, 0, 0);
      }
      drag = { startX: p.x, startY: p.y, moved: false, t: performance.now(), vx: 0, vy: 0 };
    });

    stage.addEventListener("pointermove", (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        // plain mouse hover: readout for the bars, grab cursor over the triangle
        if (e.pointerType === "mouse") {
          const core = this.glyph.hitCore(e.clientX, e.clientY);
          stage.classList.toggle("is-over-chart", core);
          stage.classList.toggle("is-over-bars", !core && this.glyph.hit(e));
        }
        return;
      }
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (this.chartDrag && this.chartDrag.id === e.pointerId && drag) {
        if (!this.chartMoved && Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4) {
          this.chartMoved = true;
          stage.classList.add("is-dragging-chart");
        }
        if (!this.chartMoved) return;
        const x = p.x + this.chartDrag.dx, y = p.y + this.chartDrag.dy;
        this.motion.dragging = true;
        this.motion.follow(x, y);
        this.kick();
        const code = this.map.pickAt(x, y);
        const place = code === null ? undefined : this.data.byCode(code);
        if (place && place.code !== this.primary.code) this.setPrimary(place, true);
        return;
      }
      if (pinch && pointers.size === 2) {
        const now = pinchState();
        this.map.panBy(now.mx - pinch.mx, now.my - pinch.my);
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
        this.map.panBy(dx, dy);
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
      if (this.chartDrag && this.chartDrag.id === e.pointerId) {
        const moved = this.chartMoved;
        this.chartDrag = null;
        stage.classList.remove("is-dragging-chart");
        if (moved) {
          // settle onto the country that was chosen with a soft bounce
          this.motion.dragging = false;
          this.motion.follow(this.anchorTarget.x, this.anchorTarget.y);
          this.kick();
          this.map.recenter(!reducedMotion.matches); // fly the map to the dropped country
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
        if (isDouble) openAt(p.x, p.y);
        else if (this.glyph.hit(e)) {
          if (e.pointerType !== "mouse") {
            clearTimeout(hideTimer);
            hideTimer = window.setTimeout(() => this.tooltip(null, 0, 0), 3000);
          }
        } else {
          this.tooltip(null, 0, 0);
          openAt(p.x, p.y); // a single click opens the country
        }
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
        if ((e.target as Element).closest(".year-picker")) return;
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
    stage.style.setProperty("--head-h", `${headH}px`);
    const legend = stage.querySelector(".legend") as HTMLElement;
    const bottomH = height - legend.offsetTop + 6;
    this.glyph.resize(width, height, headH, bottomH, $("year-picker").offsetHeight);
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
    this.tour.stop();
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

Promise.all([Dataset.load(), loadWorld(), loadPkGeo()])
  .then(([data, world, extras]) => new App(data, world, extras))
  .catch((err: Error) => {
    $("status").textContent = `${err.message} Reload the page to try again.`;
    console.error(err);
  });
