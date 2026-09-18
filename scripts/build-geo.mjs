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

/** Convert steradians to square kilometres (1 steradian = R² km², π already included in steradians). */
const steradiansToKm2 = (sr) => Math.round(sr * 6371.0088 * 6371.0088);

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
// Official areas from national statistics offices (km²), deduplicated.
const officialAreas = {
  // Americas
  840: 9_833_517, 124: 9_984_670, 484: 1_964_375, 76: 8_515_767, 32: 2_780_400,
  152: 756_102, 604: 1_285_216, 68: 1_098_581, 862: 912_050, 170: 1_141_748,
  218: 283_561, 600: 406_752, 858: 176_215, 192: 109_884, 214: 48_671, 332: 27_750,
  188: 51_100, 591: 75_417, 320: 108_889, 340: 112_090, 222: 21_041, 558: 130_373,
  630: 21_298,
  // Europe
  826: 243_610, 276: 357_022, 250: 640_679, 380: 301_340, 724: 505_990, 620: 92_212,
  616: 312_696, 203: 78_867, 642: 238_397, 804: 603_628, 372: 70_273, 40: 83_871,
  56: 30_528, 208: 43_094, 578: 385_207, 752: 450_295, 246: 338_424, 352: 103_000,
  756: 41_285, 528: 41_543, 442: 2_586, 191: 56_594, 70: 51_197, 8: 28_748,
  688: 88_361, 807: 25_713, 499: 13_812, 100: 110_994, 300: 131_957, 348: 93_028,
  703: 49_035, 233: 45_339, 428: 64_559, 440: 65_300, 498: 33_846,   112: 207_600,
  // Russia
  643: 17_098_242,
  // Asia
  156: 9_596_961, 356: 3_287_263, 392: 377_975, 410: 100_210, 408: 120_538,
  360: 1_904_569, 608: 300_000, 764: 513_120, 704: 331_212, 458: 330_803,
  104: 676_578, 116: 181_035, 496: 1_564_116, 418: 236_800, 104: 676_578,
  792: 783_562, 364: 1_648_195, 682: 2_149_690, 784: 83_600, 376: 22_145,
  400: 89_342, 422: 6_045, 430: 1_710_401, 586: 881_913, 398: 2_724_900,
  860: 448_978, 762: 199_951, 417: 199_953,
  // Africa
  566: 923_768, 818: 1_002_450, 12: 2_381_741, 788: 163_610, 504: 446_550,
  732: 266_672, 466: 1_241_238, 854: 274_200, 384: 322_463, 324: 245_857,
  686: 196_722, 478: 1_030_700, 562: 1_267_000, 120: 475_442, 140: 622_984,
  178: 342_000, 180: 2_344_858, 232: 117_600, 231: 1_104_300, 404: 580_367,
  706: 637_657, 728: 1_113_700, 729: 1_886_068, 834: 947_303, 800: 241_038,
  894: 752_618, 716: 390_757, 710: 1_221_037, 508: 801_590, 454: 118_484,
  516: 824_292, 72: 581_730,
  // Oceania
  36: 7_692_024, 554: 268_837, 242: 18_274, 598: 462_840,
};
for (const [id, [x, y, r]] of Object.entries(extra)) {
  places[id] ??= { c: [x, y], b: [x - r, y - r, x + r, y + r], dot: 1 };
}
// Override areas with official figures where available.
for (const [id, area] of Object.entries(officialAreas)) {
  if (places[id]) places[id].area = area;
}
// Drop names from the drawing topology; the app uses UN names.
for (const g of t110.objects.countries.geometries) delete g.properties;
delete t110.objects.land;
writeFileSync(new URL("../public/data/world.json", import.meta.url), JSON.stringify({ topology: t110, places }));
console.log(`world.json: ${Object.keys(places).length} places, ${in110.size} drawn shapes`);
