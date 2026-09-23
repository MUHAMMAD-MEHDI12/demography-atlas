// Builds public/data/search.json: one small list of every searchable place for both pages
// (UN WPP 2024 countries and regions, and Pakistan census districts with their tehsils).
// Run after the data files change:  node scripts/build-search.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const pack = gunzipSync(readFileSync(new URL("public/data/wpp2024.pack", root)));
const metaLen = pack.readUInt32LE(10);
const meta = JSON.parse(pack.subarray(14, 14 + metaLen).toString("utf8"));
const pk = JSON.parse(readFileSync(new URL("public/data/pakistan.json", root), "utf8"));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// everyday names for UN country names that are hard to guess
const aliases = {
  840: ["USA", "United States", "America", "US"], 826: ["UK", "United Kingdom", "Britain", "England"],
  643: ["Russia"], 364: ["Iran"], 410: ["South Korea", "Korea"], 408: ["North Korea"], 704: ["Vietnam"],
  68: ["Bolivia"], 760: ["Syria"], 834: ["Tanzania"], 792: ["Turkey", "Turkiye"], 418: ["Laos"],
  498: ["Moldova"], 862: ["Venezuela"], 158: ["Taiwan"], 344: ["Hong Kong"], 446: ["Macau", "Macao"],
  180: ["DR Congo", "Congo Kinshasa"], 178: ["Congo Brazzaville"], 384: ["Ivory Coast"], 275: ["Palestine"],
  583: ["Micronesia"], 203: ["Czech Republic"], 807: ["Macedonia"], 748: ["Swaziland"], 104: ["Burma"],
  900: ["Earth", "Global"],
};

// everyday names for the non-PBS parts of Pakistan, so the districts show up in search
const PROVINCE_ALIASES = {
  "Azad Jammu and Kashmir": ["Azad Kashmir", "AJK", "AJ&K"],
  "Gilgit-Baltistan": ["Gilgit-Baltistan", "Gilgit", "GB", "Baltistan"],
  "Indian Occupied Kashmir": ["Occupied Kashmir", "IOK", "Azad Jammu and Kashmir", "Kashmir"],
};

const countries = meta.locations.map((l) => ({
  t: l.area === "Aggregate" ? "region" : "country",
  n: l.name,
  c: l.code,
  s: l.area === "Aggregate" ? "World and regions" : l.region || l.area,
  a: aliases[l.code] ?? [],
}));
const districts = pk.units.map((u) => ({ t: "district", n: u.name, d: slug(u.name), s: `${u.province}${u.kind === "new" ? ", new district" : ""}`, a: PROVINCE_ALIASES[u.province] ?? [] }));
const tehsils = pk.units.flatMap((u) => u.tehsils.filter((t) => t.toLowerCase() !== u.name.toLowerCase()).map((t) => ({ t: "tehsil", n: t, d: slug(u.name), s: `Tehsil in ${u.name} district` })));

const out = { countries, districts, tehsils };
writeFileSync(new URL("public/data/search.json", root), JSON.stringify(out));
console.log(`search.json: ${countries.length} countries and regions, ${districts.length} districts, ${tehsils.length} tehsils`);
