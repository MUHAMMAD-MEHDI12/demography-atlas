/** UTM zone designator for a point, e.g. "42N" (Norway and Svalbard exceptions included). */
export function utmZone(lon: number, lat: number): string {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return "—";
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32; // southern Norway
  if (lat >= 72 && lat < 84) {
    if (lon >= 9 && lon < 21) zone = 33; // Svalbard
    else if (lon >= 21 && lon < 33) zone = 35;
  }
  zone = Math.min(60, Math.max(1, zone));
  return `${zone}${lat >= 0 ? "N" : "S"}`;
}

/** Clock reading in an IANA zone, e.g. "14:32:05 PKT". */
export function localClock(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).formatToParts(new Date());
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const zone = g("timeZoneName").replace(/^GMT([+-].*)$/, "UTC$1");
    return `${g("hour")}:${g("minute")}:${g("second")}${zone ? ` ${zone}` : ""}`;
  } catch {
    return `${new Date().toISOString().slice(11, 19)} UTC`;
  }
}