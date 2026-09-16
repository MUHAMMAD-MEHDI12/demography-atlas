import { defineConfig } from "vite";

// base "./" keeps asset and data paths relative, so the build works on
// GitHub Pages project sites (https://<user>.github.io/<repo>/) without changes.
export default defineConfig({
  base: "./",
  build: { target: "es2022", assetsInlineLimit: 0 },
});
