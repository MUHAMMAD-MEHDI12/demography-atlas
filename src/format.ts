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
