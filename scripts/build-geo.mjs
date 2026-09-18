// Builds public/data/world.json from Natural Earth (via the world-atlas package):
// a 1:110m country topology for drawing, plus a centroid, bounding box and area
// for every country in the more detailed 1:50m set, so small states (Singapore,
// Maldives, Pacific islands) can still be located and tapped as dots.
import { readFileSync, writeFileSync } from "node:fs";
import { feature } from "topojson-client";
import { geoArea, geoBounds, geoCentroid } from "d3-geo";

const load = (f) => JSON.parse(readFileSync(new URL(`../node_modules/world-atlas/${f}`, import.meta.url)));
const t110 = load("countries-110m.json");
const t50 = load("countries-50m.json");

const mainPolygon = (f) => {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === "Polygon") return f;
  let best = null, area = -1;
  for (const coordinates of g.coordinates) {
    const p = { type: "Feature", geometry: { type: "Polygon", coordinates } };
    const a = geoArea(p);
    if (a > area) { area = a; best = p; }
  }
  return best;
};

/** Convert steradians to square kilometres. */
const steradiansToKm2 = (sr) => Math.round(sr * 6371.0088 * 6371.0088 * Math.PI);

const round = (v) => Math.round(v * 100) / 100;
const in110 = new Set(t110.objects.countries.geometries.map((g) => g.id).filter(Boolean).map(Number));
const places = {};
for (const f of feature(t50, t50.objects.countries).features) {
  if (!f.id) continue;
  const main = mainPolygon(f);
  if (!main) continue;
  // Frame the whole country unless it spans oceans (e.g. France with overseas
  // regions, the US with Hawaii); then frame the largest polygon only.
  let [[w, s], [e, n]] = geoBounds(f);
  const width = (e - w + 360) % 360 || 360;
  if (width > 60 || n - s > 60) [[w, s], [e, n]] = geoBounds(main);
  places[Number(f.id)] = {
    c: geoCentroid(main).map(round),
    b: [round(w), round(s), round(e), round(n)],
    dot: in110.has(Number(f.id)) ? 0 : 1,
    area: steradiansToKm2(geoArea(f)),
  };
}
// UN areas that Natural Earth folds into a parent country or omits.
const extra = {
  175: [45.15, -12.83, 0.3], 638: [55.54, -21.12, 0.4], 292: [-5.35, 36.14, 0.1], 412: [20.9, 42.6, 0.8],
  535: [-68.26, 12.18, 0.3], 312: [-61.55, 16.25, 0.4], 474: [-61.02, 14.64, 0.3], 254: [-53.1, 3.93, 1.6],
  772: [-171.85, -9.2, 0.3], 798: [179.2, -8.52, 0.5],
};
for (const [id, [x, y, r]] of Object.entries(extra)) {
  places[id] ??= { c: [x, y], b: [x - r, y - r, x + r, y + r], dot: 1 };
}
// Drop names from the drawing topology; the app uses UN names.
for (const g of t110.objects.countries.geometries) delete g.properties;
delete t110.objects.land;
writeFileSync(new URL("../public/data/world.json", import.meta.url), JSON.stringify({ topology: t110, places }));
console.log(`world.json: ${Object.keys(places).length} places, ${in110.size} drawn shapes`);
