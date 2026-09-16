const nf = new Map<number, Intl.NumberFormat>();
export function fmt(v: number, digits: number): string {
  if (!Number.isFinite(v)) return "No data";
  if (!nf.has(digits)) nf.set(digits, new Intl.NumberFormat("en", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  return nf.get(digits)!.format(v);
}

export const pct = (v: number) => (Number.isFinite(v) ? `${fmt(v, v < 10 ? 2 : 1)}%` : "no data");

/** Population is stored in thousands. */
export function formatPopulation(thousands: number): string {
  if (!Number.isFinite(thousands)) return "No data";
  const people = thousands * 1000;
  if (people >= 1e9) return `${fmt(people / 1e9, 2)} billion`;
  if (people >= 1e6) return `${fmt(people / 1e6, people >= 1e8 ? 0 : 1)} million`;
  if (people >= 1e4) return `${fmt(people / 1e3, 0)} thousand`;
  return `${fmt(Math.round(people), 0)} people`;
}

/** Short counts for charts: 6.88M, 312K, 950. `long` spells out the unit. */
export function compact(people: number, long = false): string {
  if (!Number.isFinite(people)) return "no data";
  const a = Math.abs(people);
  const sign = people < 0 ? "−" : "";
  const unit = (v: number, short: string, word: string, d: number) => `${sign}${fmt(v, d)}${long ? ` ${word}` : short}`;
  if (a >= 1e9) return unit(a / 1e9, "B", "billion", long ? 3 : 2);
  if (a >= 1e6) return unit(a / 1e6, "M", "million", long ? (a >= 1e7 ? 1 : 2) : a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2);
  if (a >= 1e3) return unit(a / 1e3, "K", "thousand", a >= 1e5 ? 0 : 1);
  return `${sign}${fmt(a, 0)}`;
}

export function signedCompact(people: number): string {
  if (!Number.isFinite(people)) return "no data";
  return people > 0 ? `+${compact(people)}` : compact(people);
}
