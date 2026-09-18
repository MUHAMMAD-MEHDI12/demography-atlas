// Pakistan districts: Census 2023 (PBS) built by pipeline/build_pakistan.py.

import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";

export interface AgeShares {
  m: number[];
  f: number[];
  total: number;
  bands?: { m: number[]; f: number[] };
}

export interface District {
  id: number;
  key: string;
  name: string;
  province: string;
  division: string;
  kind: "census" | "new" | "reduced" | "merged" | "ajk" | "gb" | "iok";
  popLabel?: string;
  popYear?: number;
  source?: string;
  parent?: string;
  parts?: string[];
  note?: string;
  tehsils: string[];
  population: number | null;
  male: number | null;
  female: number | null;
  transgender: number | null;
  area: number | null;
  density: number | null;
  sexRatio: number | null;
  urbanPct: number | null;
  urban: number | null;
  rural: number | null;
  pop2017: number | null;
  growth: number | null;
  center: [number, number];
  bounds: [number, number, number, number];
  /** null where no age table is published (AJK, Gilgit-Baltistan, Occupied Kashmir) */
  age: { detail: "5-year" | "broad"; overall: AgeShares; urban: AgeShares; rural: AgeShares } | null;
}

export interface PakistanData {
  source: {
    census: string;
    censusUrl: string;
    tables: string;
    boundaries: string;
    boundariesUrl: string;
    fixes: string[];
    growthYears: number;
  };
  totals: { population: number; provinces: Record<string, number> };
  ageLabels: string[];
  broadLabels: string[];
  units: District[];
  context: { id: number; name: string; region: string }[];
  topology: Topology<{ districts: GeometryCollection }>;
}

declare global {
  interface Window {
    __PK_DATA__?: PakistanData;
  }
}

export async function loadPakistan(): Promise<PakistanData> {
  if (window.__PK_DATA__) return window.__PK_DATA__;
  const res = await fetch(`${import.meta.env.BASE_URL}data/pakistan.json`);
  if (!res.ok) throw new Error(`The district data could not be loaded (HTTP ${res.status}).`);
  return res.json();
}

export function shapes(data: PakistanData) {
  const fc = feature(data.topology, data.topology.objects.districts) as unknown as { features: Feature<Geometry, null>[] };
  for (const f of fc.features) f.id = Number((f.properties as unknown as { id?: number } | null)?.id ?? f.id);
  return {
    districts: fc.features.filter((f) => Number(f.id) > 0),
    inactive: fc.features.filter((f) => Number(f.id) < 0),
  };
}

export type Indicator = "population" | "density" | "growth" | "urbanPct" | "sexRatio";

export const INDICATORS: Record<Indicator, { label: string; unit: string; digits: number; log?: boolean }> = {
  population: { label: "Population", unit: "people", digits: 0 },
  density: { label: "People per km²", unit: "per km²", digits: 0, log: true },
  growth: { label: "Growth per year, 2017–2023", unit: "%", digits: 2 },
  urbanPct: { label: "Urban population", unit: "%", digits: 1 },
  sexRatio: { label: "Males per 100 females", unit: "", digits: 1 },
};

export function value(d: District, key: Indicator): number {
  const v = d[key];
  return typeof v === "number" ? v : NaN;
}

/** Districts with a full PBS age table. */
export const hasAge = (d: District) => d.age !== null;

/** Quantile class breaks (6 classes) so every colour holds about the same number of districts. */
export function breaks(units: District[], key: Indicator, classes = 6): number[] {
  const vals = units.map((u) => value(u, key)).filter(Number.isFinite).sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < classes; i++) out.push(vals[Math.floor((i / classes) * (vals.length - 1))]);
  return out;
}

export function classOf(v: number, cuts: number[]): number {
  let i = 0;
  while (i < cuts.length && v > cuts[i]) i++;
  return i;
}

const hex = (h: string) => {
  const s = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};

/** Colours between two theme tokens. */
export function ramp(from: string, to: string, n = 6): string[] {
  const a = hex(from), b = hex(to);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * Math.pow(t, 0.9)));
    return `rgb(${c.join(",")})`;
  });
}

/**
 * Heatmap colour: maps a normalised value (0–1) to a colour ramp
 * from dark (low density) to bright orange/pink (high density).
 * Inspired by LandScan Mosaic.
 */
export function heatmapColour(t: number): string {
  // Clamp to 0–1
  const x = Math.max(0, Math.min(1, t));
  // Multi-stop ramp: dark purple → magenta → orange → bright yellow
  let r: number, g: number, b: number;
  if (x < 0.25) {
    // Dark purple to deep magenta
    const s = x / 0.25;
    r = Math.round(10 + s * 80);
    g = Math.round(0 + s * 10);
    b = Math.round(30 + s * 50);
  } else if (x < 0.5) {
    // Deep magenta to hot pink/orange
    const s = (x - 0.25) / 0.25;
    r = Math.round(90 + s * 130);
    g = Math.round(10 + s * 40);
    b = Math.round(80 - s * 40);
  } else if (x < 0.75) {
    // Hot pink to bright orange
    const s = (x - 0.5) / 0.25;
    r = Math.round(220 + s * 35);
    g = Math.round(50 + s * 100);
    b = Math.round(40 - s * 20);
  } else {
    // Bright orange to yellow-white
    const s = (x - 0.75) / 0.25;
    r = Math.round(255);
    g = Math.round(150 + s * 105);
    b = Math.round(20 + s * 60);
  }
  return `rgb(${r},${g},${b})`;
}

/**
 * Returns the normalised value (0–1) for a district based on the given indicator.
 * Uses log scale for density and population for better visual spread.
 */
export function heatmapNormalise(units: District[], key: Indicator): Map<number, number> {
  const vals = units.map((u) => value(u, key)).filter(Number.isFinite);
  if (!vals.length) return new Map();
  const useLog = key === "population" || key === "density";
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const min = useLog ? Math.log(Math.max(rawMin, 1)) : rawMin;
  const max = useLog ? Math.log(Math.max(rawMax, 1)) : rawMax;
  const range = max - min || 1;
  const out = new Map<number, number>();
  for (const u of units) {
    const v = value(u, key);
    if (!Number.isFinite(v)) { out.set(u.id, 0); continue; }
    const norm = useLog ? (Math.log(Math.max(v, 1)) - min) / range : (v - min) / range;
    out.set(u.id, Math.max(0, Math.min(1, norm)));
  }
  return out;
}
