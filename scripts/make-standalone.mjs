// Packs each page into one self-contained HTML file (JS, CSS, data and map inlined).
// Run: node scripts/make-standalone.mjs   ->  dist-single/humanscape-world.html, humanscape-pakistan.html
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
mkdirSync(new URL("dist-single/", root), { recursive: true });
const world = readFileSync(new URL("public/data/world.json", root), "utf8");
const search = readFileSync(new URL("public/data/search.json", root), "utf8");

for (const [entry, html, out, data] of [
  ["index", "index.html", "humanscape-world.html", () => `window.__WPP_PACK__="${readFileSync(new URL("public/data/wpp2024.pack", root)).toString("base64")}";`],
  ["pakistan", "pakistan.html", "humanscape-pakistan.html", () => `window.__PK_DATA__=${readFileSync(new URL("public/data/pakistan.json", root), "utf8")};`],
]) {
  const dir = new URL(`dist-single/${entry}/`, root);
  execSync(`npx vite build --outDir ${dir.pathname} --emptyOutDir`, { cwd: root, env: { ...process.env, ENTRY: entry }, stdio: "ignore" });
  let page = readFileSync(new URL(html, dir), "utf8");
  page = page.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, f) => `<script type="module">${readFileSync(new URL(f, dir), "utf8")}</script>`);
  page = page.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/g, (_, f) => `<style>${readFileSync(new URL(f, dir), "utf8")}</style>`);
  if (/src="\.\/assets|href="\.\/assets/.test(page)) throw new Error(`${out}: an asset was not inlined`);
  page = page.replace("</head>", `<script>${data()}window.__WORLD__=${world};window.__SEARCH__=${search};</script>\n</head>`);
  writeFileSync(new URL(`dist-single/${out}`, root), page);
  console.log(`dist-single/${out} (${(page.length / 1e6).toFixed(1)} MB)`);
}
