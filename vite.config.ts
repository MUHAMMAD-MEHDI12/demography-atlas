import { defineConfig } from "vite";
import { resolve } from "node:path";

// base "./" keeps asset and data paths relative, so the build works on
// GitHub Pages project sites (https://<user>.github.io/<repo>/) without changes.
// ENTRY=index or ENTRY=pakistan builds one page on its own (used for single-file exports).
const entry = process.env.ENTRY;
const pages = { main: resolve(__dirname, "index.html"), pakistan: resolve(__dirname, "pakistan.html") };

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: entry ? (entry === "pakistan" ? pages.pakistan : pages.main) : pages,
    },
  },
});
