// Packs dist/ into one self-contained HTML file (JS, CSS, data and map inlined).
// Useful for sharing the app as a single file or hosting where only one file is allowed.
// Run after `npm run build`:  node scripts/make-standalone.mjs
import { readFileSync, writeFileSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
let html = readFileSync(new URL("index.html", dist), "utf8");

html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, f) =>
  `<script type="module">${readFileSync(new URL(f, dist), "utf8")}</script>`);
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/, (_, f) =>
  `<style>${readFileSync(new URL(f, dist), "utf8")}</style>`);

const pack = readFileSync(new URL("data/wpp2024.pack", dist)).toString("base64");
const world = readFileSync(new URL("data/world.json", dist), "utf8");
html = html.replace("</head>", `<script>window.__WPP_PACK__="${pack}";window.__WORLD__=${world};</script>\n</head>`);

writeFileSync(new URL("demography-atlas.html", dist), html);
console.log(`dist/demography-atlas.html (${(html.length / 1e6).toFixed(1)} MB)`);
