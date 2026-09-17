// One search box for both pages: countries and regions (world atlas) and Pakistan
// districts and tehsils (Pakistan section). Suggestions appear while typing; the
// best match is completed in grey and Tab or Enter accepts it.

export interface SearchItem {
  t: "country" | "region" | "district" | "tehsil";
  n: string; // name
  s: string; // secondary line
  c?: number; // UN location code
  d?: string; // district slug
  a?: string[]; // other names
}

interface SearchIndex {
  countries: SearchItem[];
  districts: SearchItem[];
  tehsils: SearchItem[];
}

declare global {
  interface Window {
    __SEARCH__?: SearchIndex;
  }
}

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const KIND: Record<SearchItem["t"], string> = { country: "Country", region: "Region", district: "Pakistan district", tehsil: "Pakistan tehsil" };
const MAX = 8;

let indexPromise: Promise<SearchItem[]> | null = null;
function loadIndex(): Promise<SearchItem[]> {
  indexPromise ??= (async () => {
    const data: SearchIndex = window.__SEARCH__ ?? (await (await fetch(`${import.meta.env.BASE_URL}data/search.json`)).json());
    return [...data.countries, ...data.districts, ...data.tehsils];
  })();
  return indexPromise;
}

/** Rank a match: lower is better; Infinity means no match. */
function score(item: SearchItem, q: string): { rank: number; label: string } {
  const names = [item.n, ...(item.a ?? [])];
  let best = Infinity, label = item.n;
  for (const name of names) {
    const n = norm(name);
    let r = Infinity;
    if (n === q) r = 0;
    else if (n.startsWith(q)) r = 1;
    else if (n.split(" ").some((w) => w.startsWith(q))) r = 2;
    else if (n.includes(q)) r = 3;
    if (r < best) (best = r), (label = name);
  }
  if (best === Infinity) return { rank: best, label };
  // prefer countries and districts over regions and tehsils, then shorter names
  const kind = { country: 0, district: 0.1, region: 0.3, tehsil: 0.5 }[item.t];
  return { rank: best + kind + item.n.length / 1000, label };
}

export class SearchBox {
  private input: HTMLInputElement;
  private ghost: HTMLElement;
  private list: HTMLUListElement;
  private results: { item: SearchItem; label: string }[] = [];
  private active = -1;
  private items: SearchItem[] = [];

  constructor(private root: HTMLElement, private onPick: (item: SearchItem) => void) {
    this.input = root.querySelector("input")!;
    this.ghost = root.querySelector(".search-ghost")!;
    this.list = root.querySelector("ul")!;
    const id = `${root.id || "search"}-list`;
    this.list.id = id;
    Object.entries({ role: "combobox", "aria-autocomplete": "both", "aria-expanded": "false", "aria-controls": id }).forEach(([k, v]) => this.input.setAttribute(k, v));
    this.list.setAttribute("role", "listbox");

    const warm = () => loadIndex().then((items) => (this.items = items));
    this.input.addEventListener("focus", () => {
      warm();
      if (this.input.value) this.update();
    });
    this.input.addEventListener("input", () => warm().then(() => this.update()));
    this.input.addEventListener("keydown", (e) => this.key(e));
    this.input.addEventListener("blur", () => setTimeout(() => this.close(), 150));
    this.list.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus while choosing
    this.list.addEventListener("click", (e) => {
      const li = (e.target as Element).closest<HTMLElement>("[data-i]");
      if (li) this.choose(Number(li.dataset.i));
    });
    root.addEventListener("pointerdown", (e) => e.stopPropagation());
    root.addEventListener("wheel", (e) => e.stopPropagation());
    // "/" focuses the search, as on many sites
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement) && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        this.input.focus();
      }
    });
  }

  private update() {
    const q = norm(this.input.value);
    if (!q) {
      this.results = [];
      this.render();
      return;
    }
    this.results = this.items
      .map((item) => ({ item, ...score(item, q) }))
      .filter((r) => r.rank < Infinity)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, MAX)
      .map(({ item, label }) => ({ item, label }));
    this.active = this.results.length ? 0 : -1;
    this.render();
  }

  private render() {
    const typed = this.input.value;
    const open = this.results.length > 0 || !!norm(typed);
    this.root.classList.toggle("is-open", open);
    this.input.setAttribute("aria-expanded", String(open));
    if (!this.results.length) {
      this.list.innerHTML = norm(typed) ? `<li class="search-empty">No country or district called “${esc(typed)}”</li>` : "";
      this.ghost.textContent = "";
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    const q = norm(typed);
    this.list.innerHTML = this.results
      .map(({ item, label }, i) => {
        const n = norm(label);
        const at = n.indexOf(q);
        // highlight the typed part when the normalised text lines up with the label
        const shown = at >= 0 && norm(label.slice(0, at + q.length)).length === at + q.length && label.length === n.length
          ? `${esc(label.slice(0, at))}<mark>${esc(label.slice(at, at + q.length))}</mark>${esc(label.slice(at + q.length))}`
          : esc(label);
        const extra = label !== item.n ? ` <span class="search-alias">${esc(item.n)}</span>` : "";
        return `<li id="${this.list.id}-${i}" role="option" data-i="${i}" aria-selected="${i === this.active}" class="${i === this.active ? "is-active" : ""}">
          <span class="search-name">${shown}${extra}</span>
          <span class="search-meta"><span class="search-kind search-kind-${item.t}">${KIND[item.t]}</span>${item.s ? ` ${esc(item.s)}` : ""}</span></li>`;
      })
      .join("");
    this.input.setAttribute("aria-activedescendant", `${this.list.id}-${this.active}`);
    // grey completion of the best match when the typed text is its beginning
    const top = this.results[Math.max(this.active, 0)];
    this.ghost.textContent = top && top.label.toLowerCase().startsWith(typed.toLowerCase()) ? typed + top.label.slice(typed.length) : "";
  }

  private key(e: KeyboardEvent) {
    const n = this.results.length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      this.active = (this.active + 1) % n;
      this.render();
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      this.active = (this.active - 1 + n) % n;
      this.render();
    } else if (e.key === "Enter" && n) {
      e.preventDefault();
      this.choose(Math.max(this.active, 0));
    } else if (e.key === "Tab" && this.ghost.textContent && !e.shiftKey) {
      e.preventDefault();
      this.input.value = this.ghost.textContent;
      this.update();
    } else if (e.key === "Escape") {
      this.input.value = "";
      this.results = [];
      this.render();
      this.input.blur();
    }
  }

  private choose(i: number) {
    const r = this.results[i];
    if (!r) return;
    this.input.value = "";
    this.results = [];
    this.render();
    this.input.blur();
    this.onPick(r.item);
  }

  private close() {
    this.root.classList.remove("is-open");
    this.input.setAttribute("aria-expanded", "false");
    this.ghost.textContent = "";
  }
}

export const searchMarkup = `
  <div class="search-field">
    <svg class="search-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></svg>
    <span class="search-ghost" aria-hidden="true"></span>
    <input type="search" placeholder="Search countries and Pakistan districts" autocomplete="off" spellcheck="false" aria-label="Search countries and Pakistan districts" />
  </div>
  <ul class="search-list"></ul>`;
