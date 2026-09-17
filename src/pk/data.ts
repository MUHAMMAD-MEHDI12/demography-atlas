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
  kind: "census" | "new" | "reduced" | "merged";
  parent?: string;
  parts?: string[];
  note?: string;
  tehsils: string[];
  population: number;
  male: number;
  female: number;
  transgender: number;
  area: number;
  density: number | null;
  sexRatio: number;
  urbanPct: number;
  urban: number;
  rural: number;
  pop2017: number;
  growth: number | null;
  center: [number, number];
  bounds: [number, number, number, number];
  age: { detail: "5-year" | "broad"; overall: AgeShares; urban: AgeShares; rural: AgeShares };
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
