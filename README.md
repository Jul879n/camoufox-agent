# camoufox-agent

Fork de [whit3rabbit/camoufox-mcp](https://github.com/whit3rabbit/camoufox-mcp) sobre el navegador oficial [Camoufox](https://github.com/daijro/camoufox) (binario fijado por SHA-256, sin compilar Firefox). README original: [docs/upstream-README.md](docs/upstream-README.md).

Dos modos en un solo binario:

| Comando | Qué hace |
|---|---|
| `camoufox-agent` | Servidor MCP por stdio (Claude Code, opencode, Hermes, OpenClaw, Codex, Cursor…) |
| `camoufox-agent serve` | HTTP: REST para apps web, MCP Streamable HTTP en `/mcp`, vista en vivo en `/live`, cron |
| `camoufox-agent run <flujo>` | Ejecuta un flujo guardado una vez (para cron/launchd/Programador de tareas) |
| `camoufox-agent test <flujo…> \| --all [--junit f.xml]` | Ejecuta flujos como pruebas; exit 1 si alguna falla |
| `camoufox-agent secret set <nombre>` / `secret list` | Credenciales para `fillSecret` |
| `camoufox-agent fetch` / `doctor` | Descarga del navegador / diagnóstico |

## Instalación

Publicado en npm: [`camoufox-agent`](https://www.npmjs.com/package/camoufox-agent) (Node >= 22).

```bash
npm i -g camoufox-agent
camoufox-agent fetch      # descarga el navegador fijado por SHA-256 (Linux, macOS, Windows)
camoufox-agent doctor     # verifica pines, navegador y un lanzamiento real
```

Sin instalar globalmente: `npx -y camoufox-agent <comando>` (la primera vez ejecute `npx -y camoufox-agent fetch`).

### Registro en agentes

| Agente | Comando / configuración |
|---|---|
| Claude Code | `claude mcp add camoufox -- camoufox-agent` (o `-- npx -y camoufox-agent`) |
| Codex | `codex mcp add camoufox -- camoufox-agent` |
| opencode | `opencode.json`: `"mcp": { "camoufox-agent": { "type": "local", "command": ["camoufox-agent"], "enabled": true } }` |
| Hermes | `printf "Y\n" \| hermes mcp add camoufox-agent --command camoufox-agent` |
| OpenClaw | `openclaw mcp add camoufox-agent --command camoufox-agent` |
| Por HTTP | `camoufox-agent serve` y apunte el cliente a `http://127.0.0.1:9420/mcp` con `Authorization: Bearer <token>` |

Si el agente no hereda su `PATH`, use la ruta absoluta del binario (`which camoufox-agent`).

### Desde el código fuente

```bash
git clone https://github.com/Jul879n/camoufox-agent && cd camoufox-agent
npm install --include=optional && npm run build
npm link
camoufox-agent fetch
```

## Novedades respecto al upstream

- **Sesiones sin límite de tiempo** (`CAMOUFOX_MCP_SESSION_TTL_MS` sin definir = nunca expiran). `CAMOUFOX_MCP_MAX_SESSIONS` (4 por defecto, máx. 64), `CAMOUFOX_MCP_MAX_CONCURRENCY` (4), `CAMOUFOX_MCP_MAX_SEQUENCE_ACTIONS` (100).
- **Perfiles persistentes**: `browse_session_start { profile }` guarda cookies, localStorage e IndexedDB (`browse_profiles_list`, `browse_profile_delete`). El perfil fija `os`/`locale`/`proxy`/`window`/fingerprint.
- **Credenciales sin exponerlas**: acción `fillSecret` (`CAMOUFOX_SECRET_<NOMBRE>` o `secrets.json` con chmod 600).
- **Archivos**: acciones `upload` y `download` dentro de `CAMOUFOX_MCP_FILES_DIR` (por defecto `<HOME>/files`).
- **Extracción estructurada**: `browse_extract` (paginación, `saveAs` JSON/CSV en `exports/`).
- **Flujos**: `flow_save`, `flow_list`, `flow_run`; login por script, extracción y `schedule` (cron de 5 campos).
- **Humano en el loop**: acciones `waitForHuman` y `promptCode`; con `serve`, el usuario interviene desde `/live`.
- Acción `goto` dentro de secuencias y sesiones.
- **Diagnóstico para desarrollo**:
  - `browse_diagnose` (`url` o `sessionId`): consola y errores no capturados con stack, red (tiempos, tamaños, fallos, caché, compresión), Web Vitals y navigation timing, estadísticas del DOM y una auditoría (SEO, accesibilidad, cabeceras de seguridad, cookies, contenido mixto). `saveAs` guarda el informe en `exports/`.
  - `browse_inspect`: caja, estilos computados, reglas CSS aplicadas, visibilidad, desbordamiento y árbol de accesibilidad de un selector.
  - `emulation` en cualquier tool: `colorScheme`, `reducedMotion`, `timezoneId`, `geolocation`, `offline`.
  - `browse_session_start { recordHar }` (HAR al cerrar) y `browse_session_trace` (trace de Playwright en `.zip`).
  - Límite: Camoufox es Firefox, sin CDP (detalle y equivalentes en «Depurar y probar apps»). Faltan CLS y long tasks nativos; `tbtApproxMs` los aproxima.

- **Depuración y pruebas** (0.3.0): ver [Depurar y probar apps](#depurar-y-probar-apps).

Datos en `CAMOUFOX_AGENT_HOME` (por defecto `~/.camoufox-agent`): `profiles/`, `flows/`, `runs/`, `files/`, `secrets.json`.

## Depurar y probar apps

Camoufox es Firefox (Juggler, sin CDP): no hay heap, profiler, cobertura JS ni throttling de CPU. Cada función de `chrome-devtools-mcp` tiene aquí un equivalente que sí funciona en Firefox:

| `chrome-devtools-mcp` | camoufox-agent |
|---|---|
| `lighthouse_audit` | `browse_audit`: axe-core (accesibilidad), SEO, buenas prácticas, seguridad y puntaje de rendimiento con la fórmula de Lighthouse sobre métricas de Firefox (sin CLS; TBT y Speed Index aproximados). Comparable entre corridas de camoufox-agent, no idéntico al de Chrome |
| `take_heapsnapshot` | `browse_profile_app { mode: "leaks" }`: repite una acción N veces y mide el crecimiento de nodos DOM, listeners y timers |
| cobertura | `browse_profile_app { mode: "cssCoverage" }` (reglas CSS que nunca aplicaron). Sin cobertura JS |
| `performance_start_trace` | `browse_session_trace` (trace de Playwright), `browse_diagnose` (cascada de recursos, `tbtApproxMs` y `longFrames`, presupuestos con `budgets`) |
| `emulate` (red) | `network` en cualquier tool y `browse_session_network`: latencia, bloqueos, mocks y `offline` |
| `emulate` (móvil) | `emulation.device` (`iphone-15`, `pixel-8`, `ipad`, `laptop-720p`, `desktop-1080p`), `hasTouch`, `forcedColors`, `contrast`, `javaScriptEnabled`, `httpCredentials` |
| `list_network_requests` / `get_network_request` | `browse_diagnose` + `browse_network_request { id }` (cabeceras, cuerpo, tiempos) |
| `list_pages` / `select_page` / `handle_dialog` | `browse_session_tabs` y la acción `dialog` |
| `drag`, `fill_form`, `click`… | acciones `drag`, `fill`, `click`… |

**Pérdidas reales sin Chrome**: throttling de CPU, user agent móvil (`isMobile` no existe en Firefox y cambiar el user agent rompería la huella) y ver cómo renderiza Chrome. Camoufox tampoco genera video (`recordVideo` no produce archivo) y fija `navigator.maxTouchPoints` en 0 aunque `hasTouch` esté activo (siguen funcionando `ontouchstart` y `pointer: coarse`).

Además, lo que `chrome-devtools-mcp` no tiene:

- **Aserciones** `expect` (`visible`, `text`, `value`, `count`, `url`, `noConsoleErrors`, `noFailedRequests`…) con reintento, `soft` y la acción `clearDiagnostics`.
- **Flujos como pruebas**: `flow_run` marca cada paso `passed|failed|error`, guarda una captura `-fail.png` y el contexto de la falla; `camoufox-agent test <flujo…> | --all [--junit archivo.xml]` sale con 1 si algo falla.
- **Mocks de red**, frames de **WebSocket** (`browse_diagnose` → `network.websockets`), **storage** (`browse_storage`), **regresión visual** (`browse_visual_diff`) y **presupuestos** de rendimiento.

```jsonc
// Auditoría móvil con informe HTML
browse_audit { "url": "http://localhost:3000/app", "formFactor": "mobile", "saveAs": "audit.html" }

// Probar que +1 sube el contador, con la API simulada y sin errores de consola
browse_session_network { "sessionId": "…", "network": { "mocks": [{ "url": "**/api/data", "status": 500 }] } }
browse_session_action { "sessionId": "…", "action": { "type": "click", "selector": "#inc" } }
browse_session_action { "sessionId": "…", "action": { "type": "expect", "check": "text", "selector": "#count", "equals": "1" } }

// Fugas al repetir una acción
browse_profile_app { "sessionId": "…", "mode": "leaks", "actions": [{ "type": "click", "selector": "#open" }, { "type": "click", "selector": "#close" }], "iterations": 10 }

// Línea base visual y comparación
browse_visual_diff { "sessionId": "…", "name": "home", "maxDiffPct": 0.5 }
```

## Servidor HTTP (`serve`)

```bash
CAMOUFOX_AGENT_TOKEN=secreto camoufox-agent serve --port 9420
```

- `GET /health` (sin auth) · `GET /api/tools` · `POST /api/tools/:nombre` (mismo cuerpo que el input de la tool MCP; 400 `invalid_input`, 404 `unknown_tool`, 422 si la tool devuelve error).
- `POST|GET|DELETE /mcp`: MCP Streamable HTTP.
- `GET /live?token=…`: vista en vivo (capturas JPEG cada 700 ms, clics y teclado reenviados, pendientes «Listo»/código).
- `GET /api/sessions`, `/api/sessions/:id/frame.jpg`, `POST /api/sessions/:id/input`, `GET /api/human`, `POST /api/human/:id`, `GET /api/flows/:nombre/runs`.
- Auth: `CAMOUFOX_AGENT_TOKEN` (obligatorio si `--host` no es loopback). CORS: `CAMOUFOX_AGENT_CORS_ORIGINS=https://app.ejemplo.cl`.
- Otras: `CAMOUFOX_AGENT_HOST`, `CAMOUFOX_AGENT_PORT`, `CAMOUFOX_AGENT_HEADLESS` (`true|false|virtual`).

Desde una app web, llame al servidor **desde su backend**; el token nunca debe llegar al navegador del cliente:

```js
const res = await fetch("http://127.0.0.1:9420/api/tools/browse_extract", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.CAMOUFOX_AGENT_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ url: "https://quotes.toscrape.com", itemSelector: ".quote", fields: { author: { selector: ".author" } }, maxPages: 2 }),
});
```

## Automatizaciones agendadas

Con `serve`, cada flujo con `schedule` se ejecuta solo (`protect`: no se solapa consigo mismo). Sin servidor, programe `camoufox-agent run <flujo>`:

- Linux: `*/30 * * * * camoufox-agent run mi-flujo >> ~/camoufox.log 2>&1`
- macOS: plist de `launchd` con `ProgramArguments` = `[/usr/local/bin/camoufox-agent, run, mi-flujo]` y `StartInterval`.
- Windows: `schtasks /create /tn camoufox-mi-flujo /sc daily /st 08:00 /tr "camoufox-agent run mi-flujo"`

## Docker Compose

```bash
CAMOUFOX_AGENT_TOKEN=secreto docker compose up -d --build
curl -s 127.0.0.1:9420/health
```

Los datos quedan en `./data` (el contenedor corre con uid 1001: `chown 1001 data` en Linux).

## Pruebas

```bash
npm run lint && npm run test:unit
for s in upload profile extract diagnose diagnose-session expect flow-test tabs-dialogs drag network emulation storage perf audit profile-app visual; do node scripts/mcp-smoke.mjs $s; done
CAMOUFOX_SECRET_HEROKU_PASS='SuperSecretPassword!' node scripts/mcp-smoke.mjs secret
CAMOUFOX_SECRET_HEROKU_PASS='SuperSecretPassword!' node scripts/mcp-smoke.mjs flow
```

Los escenarios usan un sitio local (`tests/fixtures/site.mjs`) con `CAMOUFOX_MCP_ALLOWED_PRIVATE_HOSTS=localhost`.
