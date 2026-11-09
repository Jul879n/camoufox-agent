import { build } from "esbuild";

// One self-contained file: HTTP tier, extraction (turndown + domino inlined) and the CDP Chrome tier. No runtime dependencies.
await build({
  entryPoints: ["dist/scrape/lite.js"],
  outfile: "dist/lite.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
});
