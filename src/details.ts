// "Detailed statistics" dialog. Every value comes from UN World Population
// Prospects 2024; rows that are calculated from UN data say so.

import { AGE_GROUPS, FERT_GROUPS, oldAgeDependency, type Dataset, type Place, type Profile } from "./data";
import { fmt } from "./format";

type Tab = "overview" | "age" | "deaths" | "births" | "years";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const int = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en") : "no data");
const signedInt = (v: number) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString("en")}` : "no data");
const num = (v: number, d: number) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}${fmt(Math.abs(v), d)}` : "no data");

interface State {
  primary: Place;
  compare: Place | null;
  year: number;
}

export class Details {
  private tab: Tab = "overview";
  private csv: { name: string; rows: (string | number)[][] } = { name: "", rows: [] };
  private dialog = $<HTMLDialogElement>("details");

  constructor(private data: Dataset, private state: () => State, private setYear: (y: number) => void) {
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>("[role=tab]")) {
      btn.addEventListener("click", () => {
        this.tab = btn.dataset.tab as Tab;
        this.render();
      });
    }
    $("details-close").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    const input = $<HTMLInputElement>("details-year");
    input.min = String(data.yearStart);
    input.max = String(data.yearEnd);
    const go = (y: number) => this.setYear(Math.min(Math.max(Math.round(y), data.yearStart), data.yearEnd));
    input.addEventListener("change", () => go(Number(input.value)));
    $("details-prev").addEventListener("click", () => go(this.state().year - 1));
    $("details-next").addEventListener("click", () => go(this.state().year + 1));
    $("details-csv").addEventListener("click", () => this.download());
    $("details-body").addEventListener("click", (e) => {
      const tr = (e.target as Element).closest<HTMLElement>("tr[data-year]");
      if (tr) go(Number(tr.dataset.year));
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  open(tab?: Tab) {
    if (tab) this.tab = tab;
    this.render();
    this.dialog.showModal();
    if (this.tab === "years") this.scrollToYear();
  }

  /** Re-render if open (called when place, comparison or year changes). */
  refresh() {
    if (this.dialog.open) this.render();
  }

  private render() {
    const { primary, compare, year } = this.state();
    for (const btn of this.dialog.querySelectorAll<HTMLButtonElement>("[role=tab]")) btn.setAttribute("aria-selected", String(btn.dataset.tab === this.tab));
    $<HTMLInputElement>("details-year").value = String(year);
    const phase = year > this.data.lastEstimate ? "UN projection (median)" : "UN estimate";
    $("details-sub").textContent = `${primary.name}${compare ? ` compared with ${compare.name}` : ""}, ${year}, ${phase}`;

    const body = $("details-body");
    const places = [primary, ...(compare ? [compare] : [])];
    const profiles = places.map((p) => this.data.profile(p.index, year));
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const baseName = `${slug(primary.name)}${compare ? `-vs-${slug(compare.name)}` : ""}`;

    if (this.tab === "overview") body.innerHTML = this.overview(places, profiles, year, baseName);
    if (this.tab === "age") body.innerHTML = this.ageTable("Population by age and sex", "Share of the total population on 1 July", places, profiles, "popM", "popF", year, baseName, "population-by-age");
    if (this.tab === "deaths") body.innerHTML = this.ageTable("Deaths by age and sex", "Share of all deaths in the year", places, profiles, "deathsM", "deathsF", year, baseName, "deaths-by-age");
    if (this.tab === "births") body.innerHTML = this.birthsTable(places, profiles, year, baseName);
    if (this.tab === "years") body.innerHTML = this.yearsTable(primary, year, slug(primary.name));

    const notes: Record<Tab, string> = {
      overview: "Counts are people, rounded to the nearest person. Population change, births, deaths and net migration refer to the calendar year. Rows marked * are calculated from UN age data.",
      age: "Shares by 5-year age group, from UN population by single age and sex. Ages 95 and over are combined.",
      deaths: "Calculated from UN age-specific death rates multiplied by mid-year population; totals match official UN deaths within a median of 0.2%.",
      births: "UN percentage age-specific fertility. Births to mothers aged 10–14 are counted in 15–19, and 50–54 in 45–49.",
      years: "Official UN annual series for every year. 1950–2023 are estimates; 2024–2100 are the median projection (shown in italics).",
    };
    $("details-note").textContent = `Source: United Nations, World Population Prospects 2024. ${notes[this.tab]}`;

    const codes = places.map((p) => p.code).join(",");
    const ind: Record<Tab, string> = { overview: "49,50,57,60,65,19,61,67", age: "46", deaths: "64", births: "73", years: "49,50,57,60,65,51,19,61,67" };
    const [from, to] = this.tab === "years" ? [this.data.yearStart, this.data.yearEnd] : [year, year];
    ($("details-verify") as HTMLAnchorElement).href = `https://population.un.org/dataportal/data/indicators/${ind[this.tab]}/locations/${codes}/start/${from}/end/${to}/table/pivotbylocation`;
  }

  private overview(places: Place[], profiles: Profile[], year: number, baseName: string) {
    const annual = places.map((p) => this.data.annualFigures(p.index, year)!);
    const broad = (p: Profile, lo: number, hi: number) => {
      let s = 0;
      for (let i = lo; i < hi; i++) s += p.popM[i] + p.popF[i];
      return s;
    };
    const rows: [string, (i: number) => string, (i: number) => string | number][] = [
      ["Population on 1 July", (i) => int(annual[i].population), (i) => Math.round(annual[i].population)],
      ["Population change in the year", (i) => signedInt(annual[i].change), (i) => Math.round(annual[i].change)],
      ["Growth rate (%)", (i) => num(annual[i].growthRate, 2), (i) => annual[i].growthRate],
      ["Births", (i) => int(annual[i].births), (i) => Math.round(annual[i].births)],
      ["Deaths", (i) => int(annual[i].deaths), (i) => Math.round(annual[i].deaths)],
      ["Net migration", (i) => signedInt(annual[i].netMigration), (i) => Math.round(annual[i].netMigration)],
      ["Births per woman", (i) => num(profiles[i].tfr, 2), (i) => profiles[i].tfr],
      ["Life expectancy at birth (years)", (i) => num(profiles[i].e0, 1), (i) => profiles[i].e0],
      ["Median age (years)*", (i) => num(profiles[i].medianAge, 1), (i) => profiles[i].medianAge],
      ["Aged 0–14 (%)*", (i) => num(broad(profiles[i], 0, 3), 1), (i) => +broad(profiles[i], 0, 3).toFixed(2)],
      ["Aged 15–64 (%)*", (i) => num(broad(profiles[i], 3, 13), 1), (i) => +broad(profiles[i], 3, 13).toFixed(2)],
      ["Aged 65 and over (%)*", (i) => num(broad(profiles[i], 13, AGE_GROUPS), 1), (i) => +broad(profiles[i], 13, AGE_GROUPS).toFixed(2)],
      ["People 65+ per 100 aged 15–64*", (i) => num(oldAgeDependency(profiles[i]), 1), (i) => +oldAgeDependency(profiles[i]).toFixed(2)],
      ["Male share of population (%)*", (i) => num(profiles[i].popM.reduce((a, b) => a + b, 0), 1), (i) => +profiles[i].popM.reduce((a, b) => a + b, 0).toFixed(2)],
    ];
    this.csv = {
      name: `${baseName}-${year}-key-indicators.csv`,
      rows: [["Indicator", ...places.map((p) => p.name)], ...rows.map(([label, , raw]) => [label.replace("*", ""), ...places.map((_, i) => raw(i))])],
    };
    const head = places.map((p) => `<th scope="col" class="num">${esc(p.name)}</th>`).join("");
    const body = rows.map(([label, show]) => `<tr><th scope="row">${label}</th>${places.map((_, i) => `<td class="num">${show(i)}</td>`).join("")}</tr>`).join("");
    return `<div class="table-wrap"><table class="d-table"><thead><tr><th scope="col">Indicator, ${year}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  private ageTable(title: string, sub: string, places: Place[], profiles: Profile[], mKey: "popM" | "deathsM", fKey: "popF" | "deathsF", year: number, baseName: string, file: string) {
    const ages = this.data.ages;
    const cmp = profiles[1];
    const cmpName = places[1]?.name;
    let maxV = 0;
    for (const p of profiles) for (let i = 0; i < AGE_GROUPS; i++) maxV = Math.max(maxV, p[mKey][i], p[fKey][i]);
    const bar = (v: number, cls: string) => `<span class="d-bar ${cls}" style="width:${Number.isFinite(v) ? (v / maxV) * 100 : 0}%"></span>`;
    let tM = 0, tF = 0;
    const rows = ages
      .map((age, i) => {
        const m = profiles[0][mKey][i], f = profiles[0][fKey][i];
        tM += m;
        tF += f;
        const c = cmp ? `<td class="num">${num(cmp[mKey][i] + cmp[fKey][i], 2)}</td>` : "";
        return `<tr><th scope="row">${age}</th><td class="d-bar-cell d-left">${bar(m, "is-m")}</td><td class="num">${num(m, 2)}</td><td class="num">${num(f, 2)}</td><td class="d-bar-cell">${bar(f, "is-f")}</td><td class="num strong">${num(m + f, 2)}</td>${c}</tr>`;
      })
      .reverse()
      .join("");
    this.csv = {
      name: `${baseName}-${year}-${file}.csv`,
      rows: [
        ["Age group", `${places[0].name} male %`, `${places[0].name} female %`, `${places[0].name} total %`, ...(cmp ? [`${cmpName} male %`, `${cmpName} female %`] : [])],
        ...ages.map((age, i) => [age, profiles[0][mKey][i], profiles[0][fKey][i], +(profiles[0][mKey][i] + profiles[0][fKey][i]).toFixed(2), ...(cmp ? [cmp[mKey][i], cmp[fKey][i]] : [])]),
      ],
    };
    const cHead = cmp ? `<th scope="col" class="num">${esc(cmpName!)} total</th>` : "";
    return `<h3 class="d-title">${title}, ${places[0].name}, ${year}</h3><p class="muted d-sub">${sub}, in per cent</p>
      <div class="table-wrap"><table class="d-table d-age"><thead><tr><th scope="col">Age</th><th scope="col" colspan="2" class="num">Male</th><th scope="col" colspan="2">Female</th><th scope="col" class="num">Total</th>${cHead}</tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><th scope="row">All ages</th><td></td><td class="num">${num(tM, 1)}</td><td class="num">${num(tF, 1)}</td><td></td><td class="num strong">${num(tM + tF, 1)}</td>${cmp ? "<td></td>" : ""}</tr></tfoot></table></div>`;
  }

  private birthsTable(places: Place[], profiles: Profile[], year: number, baseName: string) {
    const ages = this.data.fertAges;
    const annual = places.map((p) => this.data.annualFigures(p.index, year)!);
    let maxV = 0;
    for (const p of profiles) for (let i = 0; i < FERT_GROUPS; i++) maxV = Math.max(maxV, p.fert[i]);
    const rows = ages
      .map((age, i) => {
        const cells = profiles.map((p) => `<td class="d-bar-cell"><span class="d-bar is-f" style="width:${Number.isFinite(p.fert[i]) ? (p.fert[i] / maxV) * 100 : 0}%"></span></td><td class="num">${num(p.fert[i], 2)}</td>`).join("");
        return `<tr><th scope="row">${age}</th>${cells}</tr>`;
      })
      .join("");
    this.csv = {
      name: `${baseName}-${year}-births-by-mothers-age.csv`,
      rows: [["Mother's age", ...places.map((p) => `${p.name} % of births`)], ...ages.map((age, i) => [age, ...profiles.map((p) => p.fert[i])])],
    };
    const head = places.map((p) => `<th scope="col" colspan="2" class="num">${esc(p.name)}</th>`).join("");
    const totals = places.map((_, i) => `<td></td><td class="num strong">${int(annual[i].births)}</td>`).join("");
    return `<h3 class="d-title">Births by mother's age, ${year}</h3><p class="muted d-sub">Share of all births in the year, in per cent</p>
      <div class="table-wrap"><table class="d-table d-age"><thead><tr><th scope="col">Mother's age</th>${head}</tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">Total births</th>${totals}</tr></tfoot></table></div>`;
  }

  private yearsTable(place: Place, year: number, slug: string) {
    const out: (string | number)[][] = [["Year", "Phase", "Population (1 July)", "Population change", "Growth rate %", "Births", "Deaths", "Net migration", "Births per woman", "Life expectancy", "Median age"]];
    let rows = "";
    for (let y = this.data.yearStart; y <= this.data.yearEnd; y++) {
      const a = this.data.annualFigures(place.index, y)!;
      const p = this.data.profile(place.index, y);
      const proj = y > this.data.lastEstimate;
      out.push([y, proj ? "projection" : "estimate", Math.round(a.population), Math.round(a.change), a.growthRate, Math.round(a.births), Math.round(a.deaths), Math.round(a.netMigration), p.tfr, p.e0, p.medianAge]);
      const cls = [y === year ? "is-current" : "", proj ? "is-proj" : ""].filter(Boolean).join(" ");
      rows += `<tr class="${cls}" data-year="${y}"><th scope="row">${y}</th><td class="num">${int(a.population)}</td><td class="num">${signedInt(a.change)}</td><td class="num">${num(a.growthRate, 2)}</td><td class="num">${int(a.births)}</td><td class="num">${int(a.deaths)}</td><td class="num">${signedInt(a.netMigration)}</td><td class="num">${num(p.tfr, 2)}</td><td class="num">${num(p.e0, 1)}</td><td class="num">${num(p.medianAge, 1)}</td></tr>`;
    }
    this.csv = { name: `${slug}-1950-2100-annual.csv`, rows: out };
    requestAnimationFrame(() => this.scrollToYear());
    return `<h3 class="d-title">${esc(place.name)}, every year 1950–2100</h3><p class="muted d-sub">Tap a row to jump the atlas to that year</p>
      <div class="table-wrap d-years-wrap"><table class="d-table d-years"><thead><tr><th scope="col">Year</th><th scope="col" class="num">Population</th><th scope="col" class="num">Change</th><th scope="col" class="num">Growth %</th><th scope="col" class="num">Births</th><th scope="col" class="num">Deaths</th><th scope="col" class="num">Net migration</th><th scope="col" class="num">Births per woman</th><th scope="col" class="num">Life exp.</th><th scope="col" class="num">Median age</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  private scrollToYear() {
    const body = $("details-body");
    const row = body.querySelector<HTMLElement>("tr.is-current");
    const wrap = body.querySelector<HTMLElement>(".d-years-wrap");
    if (row && wrap) wrap.scrollTop = row.offsetTop - wrap.clientHeight / 2;
  }

  private download() {
    const cell = (v: string | number) => {
      const s = typeof v === "number" ? (Number.isFinite(v) ? String(+v.toFixed(4)) : "") : v;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = [
      "# Source: United Nations, Department of Economic and Social Affairs, Population Division (2024). World Population Prospects 2024. CC BY 3.0 IGO.",
      ...this.csv.rows.map((r) => r.map(cell).join(",")),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: this.csv.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
