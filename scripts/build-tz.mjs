// Generates src/tz.json: UN country/area code -> IANA time zone, taken from the
// country's centre point in public/data/world.json (the same point the chart is
// pinned to). Run after world.json changes:  node scripts/build-tz.mjs
import { readFileSync, writeFileSync } from "node:fs";
import tzlookup from "tz-lookup";

const world = JSON.parse(readFileSync(new URL("../public/data/world.json", import.meta.url), "utf8"));
const out = {};
let bad = 0;
for (const [code, p] of Object.entries(world.places)) {
  const [lon, lat] = p.c;
  const tz = tzlookup(lat, lon);
  if (!tz) { bad++; continue; }
  out[code] = tz;
}
writeFileSync(new URL("../src/tz.json", import.meta.url), JSON.stringify(out, null, 0) + "\n");
console.log(`tz.json: ${Object.keys(out).length} places${bad ? `, ${bad} skipped` : ""}`);
