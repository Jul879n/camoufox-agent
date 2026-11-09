#!/usr/bin/env node
// Benchmark of `camoufox-agent scrape` (full process per run). Usage: node scripts/bench-scrape.mjs [--runs N] [--no-server]
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const runs = Number(process.argv.includes("--runs") ? process.argv[process.argv.indexOf("--runs") + 1] : 3);
const extra = process.argv.includes("--no-server") ? ["--no-server"] : [];

const has = (text) => (d) => d.markdown.includes(text) || JSON.stringify(d.metadata).includes(text);
const SUITE = [
  { url: "https://books.toscrape.com/", ok: has("A Light in the Attic") },
  { url: "https://quotes.toscrape.com/js/", ok: (d) => (d.markdown.match(/by /g) ?? []).length >= 10 },
  { url: "https://nowsecure.nl/", ok: has("NOWSECURE") },
  { url: "https://bot.sannysoft.com/", ok: (d) => d.status_code === 200 },
  { url: "https://www.scrapingcourse.com/cloudflare-challenge", ok: (d) => d.success && d.status_code === 200 && !/just a moment/i.test(d.markdown) },
  { url: "https://www.scrapingcourse.com/antibot-challenge", ok: (d) => d.success && d.status_code === 200 && !/just a moment/i.test(d.markdown) },
  { url: "https://example.com/", ok: has("Example Domain") },
  { url: "https://es.wikipedia.org/wiki/Chile", ok: (d) => d.tables.length >= 1 },
  { url: "https://www.mercadolibre.cl/", ok: (d) => d.status_code === 200 && d.markdown.length > 1000 },
  { url: "https://github.com/", ok: (d) => d.markdown.length > 1000 },
];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rows = [];
for (const site of SUITE) {
  const times = [];
  let valid = 0;
  let last = {};
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const proc = spawnSync(process.execPath, [cli, "scrape", site.url, ...extra], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    times.push((performance.now() - t0) / 1000);
    try {
      last = JSON.parse(proc.stdout);
      if (last.success && site.ok(last)) valid++;
    } catch {
      last = { engine: "-", success: false, error_message: "no JSON output" };
    }
  }
  rows.push({ url: site.url, median: median(times), engine: last.engine, valid, runs, error: last.error_message });
}

console.log("\nURL".padEnd(58) + "median".padEnd(9) + "engine".padEnd(10) + "valid");
for (const r of rows) {
  console.log(r.url.padEnd(57) + `${r.median.toFixed(2)}s`.padEnd(9) + String(r.engine).padEnd(10) + `${r.valid}/${r.runs}${r.error ? `  (${r.error})` : ""}`);
}
const total = rows.reduce((n, r) => n + r.runs, 0);
const good = rows.reduce((n, r) => n + r.valid, 0);
const rate = (good / total) * 100;
console.log(`\nSuccess rate: ${rate.toFixed(1)}% (${good}/${total})`);
process.exit(rate >= 95 ? 0 : 1);
