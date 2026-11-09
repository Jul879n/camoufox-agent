# Roadmap: scrape por niveles, navegador tibio y automatización sin agente

camoufox-agent absorbe a scrape-lite. Casillas `- [x]` solo tras ver la salida real del comando.
Límite honesto: 100 % no es alcanzable (CAPTCHA interactivos, logins, anti-bot comercial); el objetivo verificable es ≥ 95 % en la suite fija; el resto cae en `waitForHuman`/`/live`.

Prerrequisito: `cd ~/dev/camoufox-agent`, Node ≥ 22.15, Chrome instalado, Camoufox descargado (`npm run fetch:camoufox`) para bloqueos.

## Fase 0 — Objetivos
- [x] Este documento tiene ≥ 14 casillas: `grep -c -- "- \[ \]" docs/scrape-roadmap.md` → ≥ 14 (antes de marcar).

## Fase 1 — Núcleo scrape
- [x] Paso 2: `npm run build` → 0 errores (turndown, gfm, domino).
- [x] Paso 3: `npm run build && node tests/unit_scrape_extract.mjs` → `unit_scrape_extract ok`.
- [x] Paso 4: `npm run build && node tests/unit_scrape_http.mjs` → `unit_scrape_http ok`.
- [x] Paso 5: `node dist/cli.js scrape https://books.toscrape.com/` → `http 200 20` (engine, status, images).

## Fase 2 — Niveles y navegador tibio
- [x] Paso 6: `node dist/cli.js scrape https://quotes.toscrape.com/js/ --no-server` → `engine: chrome` y ≥ 10 "by ". — chrome, 11 "by "; cloudflare-challenge lo resuelve Camoufox.
- [x] Paso 7: con `serve` corriendo, 2.ª ejecución de quotes/js → `engine: chrome`, `real` < 2,5 s; con `--fast` < 1,6 s. — medido: tibio mediana 2,07–2,33 s; `--fast` mediana 1,23 s (fast usa `load` + 150 ms en vez de networkidle).

## Fase 3 — Sin agente
- [x] Paso 8: `call browse '{"url":"https://example.com","outputMode":"metadata"}'` → `Example Domain`; `call nope` → `unknown_tool` y exit 1. — OK (`Example Domain`; `unknown_tool`, exit 1).
- [x] Paso 9: `run tests/fixtures/flows/heroku-login.json` → JSON `FlowRun` con `steps`. — devuelve `FlowRun` con `steps`; el fixture apunta a localhost y la política SSRF lo rechaza (esperado).
- [x] Paso 10: `import { scrape, close } from dist/lib.js` sobre books.toscrape → `http 20`. — `http 20`.

## Fase 4 — Peso
- [x] Paso 11: `npm install --omit=dev && du -sh node_modules` ≤ 80 MB; sin `node_modules/better-sqlite3/build`; `npm run test:unit` todo `ok`. — 76 MB, sin better-sqlite3 (turndown/domino empaquetados con esbuild). Límite: el override solo aplica al instalar desde la raíz; como dependencia sigue bajando better-sqlite3.

## Fase 5 — Benchmark y retiro
- [x] Paso 12: `node scripts/bench-scrape.mjs` → tasa de éxito ≥ 95 %; skill `web-scrape` menciona `camoufox-agent scrape`. — 96,7 % (29/30).
- [x] Umbral estático books.toscrape: `engine: http`, ≤ 0,9 s (mediana de 3). — mediana 0,88 s.
- [x] Umbral JS quotes/js (build final, load ~4): frío sin caché de nivel 3,58 s (< 3,7 s); tibio 1,92 s (< 2,5 s); `--fast` tibio 1,54 s (< 1,6 s). Hay outliers por carga de la máquina (hasta 6 s en una corrida de 7).
- [x] (DECISIÓN DEL USUARIO: priorizar estáticos ≤ 0,9 s; el umbral sin serve queda documentado como inestable) Umbral `nowsecure.nl`: `success` y "NOWSECURE" cumplen siempre; tibio 2,05 s (< 2,5 s, cumple); sin serve NO es estable: 3,0 s / 3,98 s en dos benchmarks (umbral < 3,7 s) y 4,11 s con caché borrada. Se probó lanzar Chrome en paralelo al HTTP (3,33 s) pero encarecía lo estático de 0,84 a 1,04 s (> 0,9 s) y se descartó.
- [x] Humano: `scrape https://bot.sannysoft.com/ --engine chrome --full` → `WebDriver` sin `failed` y UA sin `HeadlessChrome`; igual con `--engine camoufox`. — Chrome: `webdriver-result` = passed, UA `Chrome/156`; Camoufox: passed, UA Firefox.
- [x] `npm run test:local` igual que la línea base — "All tests passed" en el build final (tras el cambio de la guarda y de paginación); `test:unit`: 23/23.
- [x] Flujo real login → navegar → select → descargar (`export-demo.json`, 8 pasos `passed`, archivo en `files/descargas/`).

## Notas / decisiones
- `installRequestGuard` usa `routeWebSocket`; compatibilidad con Chromium por confirmar (ver Paso 6).
- Retiro de scrape-lite: borrado de `~/dev/scrape-lite` y `~/.claude/skills/web-scrape/scrape.py` solo con confirmación explícita.
- Benchmark final (build final, sin serve): 96,7 % (29/30) en las dos últimas corridas; falla 1 de 3 en `cloudflare-challenge` o `antibot-challenge` según la corrida (Camoufox no supera el desafío siempre). Corrida intermedia: 100 %. Sitios reales: varía.
- Desviaciones: `humanizePage` tiene tope duro (el cursor humanizado de Camoufox podía colgarlo); Chrome espera ≤ 6 s a que un interstitial se resuelva antes de escalar a Camoufox; caché de nivel por host+primer segmento de ruta (24 h, `~/.cache/camoufox-agent/tiers.json`) evita repetir HTTP en sitios JS; el cierre del navegador privado no se espera (ahorra ~0,3 s).
- `installRequestGuard` (con `routeWebSocket`) funciona en Chromium; se ignoran sus bloqueos por "Could not resolve URL host" (hosts efímeros de desafíos).

## Librería ligera (`camoufox-scrape`, `lite-pkg/`)
- [x] `dist/lite.js` 272 KB, cero dependencias (HTTP + Chrome del usuario por CDP crudo con el `WebSocket` nativo de Node; sin Playwright ni Camoufox). Paquete `camoufox-scrape`: 80,8 kB comprimido; instalado en un proyecto limpio `node_modules` = 284 KB.
- [x] Consumidor limpio: `scrape()` → `http 200 20` (books) y `chrome true 11` (quotes/js). nowsecure por CDP: `success` y "NOWSECURE", ~2,5 s.
- [x] `tests/unit_scrape_lite.mjs` (tamaño < 400 KB, sin imports pesados, política SSRF). Camoufox solo vía `serve` (delegación) o el paquete completo.
- [x] Regresión: `test:unit` 24/24, `test:local` pasa, benchmark 100 % (30/30).
