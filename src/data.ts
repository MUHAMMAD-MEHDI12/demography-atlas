// Loads and decodes the WPP 2024 data pack produced by pipeline/build_data.py.
//
// Layout (little endian):
//   "WPP5" | uint16 nLoc | uint16 nYears | uint16 nRecord | uint32 metaLength | meta JSON | pad to 4
//   float32[6 * nLoc * nYears]          official annual series, in this order:
//                                        population (1 July), births, deaths, net migration,
//                                        population change (thousands) and growth rate (%)
//   uint16[nLoc * nYears * nRecord]     year-delta-encoded record, see meta.layout

export interface Place {
  index: number;
  code: number;
  name: string;
  area: string;
  region: string;
}

interface Meta {
  source: string;
  license: string;
  yearStart: number;
  yearEnd: number;
  lastEstimate: number;
  ages: string[];
  fertAges: string[];
  scales: { shares: number; tfr: number; e0: number; medianAge: number };
  missing: number;
  locations: Omit<Place, "index">[];
}

export const AGE_GROUPS = 20;
export const FERT_GROUPS = 7;
const OFF = { popM: 0, popF: 20, deathsM: 40, deathsF: 60, fert: 80, tfr: 87, e0: 88, medianAge: 89 } as const;

/** Official WPP 2024 annual figures for one place and calendar year (people, not thousands). */
export interface Annual {
  year: number;
  population: number; // 1 July
  births: number;
  deaths: number;
  netMigration: number;
  change: number; // 1 January of year to 1 January of next year
  growthRate: number; // %
}

const SERIES = ["population", "births", "deaths", "netMigration", "change", "growthRate"] as const;
type SeriesKey = (typeof SERIES)[number];

/** One location at one (possibly fractional) year. Shares are percentages. */
export interface Profile {
  popM: Float64Array;
  popF: Float64Array;
  deathsM: Float64Array;
  deathsF: Float64Array;
  fert: Float64Array;
  population: number; // thousands
  tfr: number;
  e0: number;
  medianAge: number;
}

export const emptyProfile = (): Profile => ({
  popM: new Float64Array(AGE_GROUPS),
  popF: new Float64Array(AGE_GROUPS),
  deathsM: new Float64Array(AGE_GROUPS),
  deathsF: new Float64Array(AGE_GROUPS),
  fert: new Float64Array(FERT_GROUPS),
  population: NaN,
  tfr: NaN,
  e0: NaN,
  medianAge: NaN,
});

declare global {
  interface Window {
    __WPP_PACK__?: string; // base64, used by the single-file build
  }
}

async function readBytes(): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (window.__WPP_PACK__) {
    const bin = atob(window.__WPP_PACK__);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    const res = await fetch(`${import.meta.env.BASE_URL}data/wpp2024.pack`);
    if (!res.ok) throw new Error(`The data file could not be loaded (HTTP ${res.status}).`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  // Some servers decompress transparently; only inflate if the gzip signature is present.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

export class Dataset {
  readonly places: Place[];
  readonly ages: string[];
  readonly fertAges: string[];
  readonly yearStart: number;
  readonly yearEnd: number;
  readonly lastEstimate: number;
  readonly source: string;
  readonly license: string;
  private readonly nYears: number;
  private readonly nRec: number;
  private readonly annual: Float32Array;
  private readonly nLoc: number;
  private readonly rec: Uint16Array;
  private readonly meta: Meta;

  private constructor(buf: ArrayBuffer) {
    const view = new DataView(buf);
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (magic !== "WPP5") throw new Error("The data file has an unexpected format.");
    const nLoc = view.getUint16(4, true);
    this.nLoc = nLoc;
    this.nYears = view.getUint16(6, true);
    this.nRec = view.getUint16(8, true);
    const metaLen = view.getUint32(10, true);
    this.meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 14, metaLen)));
    let off = 14 + metaLen;
    off += (4 - (off % 4)) % 4;
    this.annual = new Float32Array(buf, off, SERIES.length * nLoc * this.nYears);
    off += SERIES.length * nLoc * this.nYears * 4;
    this.rec = new Uint16Array(buf.slice(off, off + nLoc * this.nYears * this.nRec * 2));

    // undo year-delta encoding in place
    const stride = this.nYears * this.nRec;
    for (let l = 0; l < nLoc; l++) {
      for (let y = 1; y < this.nYears; y++) {
        const base = l * stride + y * this.nRec;
        for (let r = 0; r < this.nRec; r++) this.rec[base + r] = (this.rec[base + r] + this.rec[base - this.nRec + r]) & 0xffff;
      }
    }

    this.places = this.meta.locations.map((p, index) => ({ ...p, index }));
    this.ages = this.meta.ages;
    this.fertAges = this.meta.fertAges;
    this.yearStart = this.meta.yearStart;
    this.yearEnd = this.meta.yearEnd;
    this.lastEstimate = this.meta.lastEstimate;
    this.source = this.meta.source;
    this.license = this.meta.license;
  }

  static async load(): Promise<Dataset> {
    const bytes = await readBytes();
    return new Dataset(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  byCode(code: number): Place | undefined {
    return this.places.find((p) => p.code === code);
  }

  /** Linear interpolation between annual values; integer years return exact WPP values. */
  profile(place: number, year: number, out: Profile = emptyProfile()): Profile {
    const t = Math.min(Math.max(year, this.yearStart), this.yearEnd) - this.yearStart;
    const y0 = Math.min(Math.floor(t), this.nYears - 1);
    const y1 = Math.min(y0 + 1, this.nYears - 1);
    const f = t - y0;
    const a = (place * this.nYears + y0) * this.nRec;
    const b = (place * this.nYears + y1) * this.nRec;
    const miss = this.meta.missing;
    const v = (i: number, scale: number) => {
      const va = this.rec[a + i], vb = this.rec[b + i];
      if (va === miss || vb === miss) return NaN;
      return (va + (vb - va) * f) / scale;
    };
    const s = this.meta.scales.shares;
    for (let i = 0; i < AGE_GROUPS; i++) {
      out.popM[i] = v(OFF.popM + i, s);
      out.popF[i] = v(OFF.popF + i, s);
      out.deathsM[i] = v(OFF.deathsM + i, s);
      out.deathsF[i] = v(OFF.deathsF + i, s);
    }
    for (let i = 0; i < FERT_GROUPS; i++) out.fert[i] = v(OFF.fert + i, s);
    out.tfr = v(OFF.tfr, this.meta.scales.tfr);
    out.e0 = v(OFF.e0, this.meta.scales.e0);
    out.medianAge = v(OFF.medianAge, this.meta.scales.medianAge);
    const pa = this.series("population", place, y0), pb = this.series("population", place, y1);
    out.population = pa + (pb - pa) * f;
    return out;
  }

  private series(key: SeriesKey, place: number, yearIndex: number): number {
    return this.annual[(SERIES.indexOf(key) * this.nLoc + place) * this.nYears + yearIndex];
  }

  /** Official annual figures; counts converted from thousands to people. */
  annualFigures(place: number, year: number): Annual | null {
    const y = Math.round(year) - this.yearStart;
    if (y < 0 || y >= this.nYears) return null;
    const k = (key: SeriesKey) => this.series(key, place, y) * 1000;
    return {
      year: Math.round(year),
      population: k("population"),
      births: k("births"),
      deaths: k("deaths"),
      netMigration: k("netMigration"),
      change: k("change"),
      growthRate: this.series("growthRate", place, y),
    };
  }

  /** Total population (people, 1 July) for every year, for charts. */
  populationSeries(place: number): Float64Array {
    const out = new Float64Array(this.nYears);
    for (let y = 0; y < this.nYears; y++) out[y] = this.series("population", place, y) * 1000;
    return out;
  }
}

/** People aged 65+ per 100 people aged 15-64, from the population shares. */
export function oldAgeDependency(p: Profile): number {
  let work = 0, old = 0;
  for (let i = 3; i < 13; i++) work += p.popM[i] + p.popF[i];
  for (let i = 13; i < AGE_GROUPS; i++) old += p.popM[i] + p.popF[i];
  return work > 0 ? (old / work) * 100 : NaN;
}
