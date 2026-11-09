import { build } from "esbuild";

await build({
  entryPoints: ["scripts/vendor-entry.mjs"],
  outfile: "dist/scrape/vendor.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
});
