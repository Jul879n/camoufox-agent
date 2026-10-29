# camoufox-agent

Fork de [whit3rabbit/camoufox-mcp](https://github.com/whit3rabbit/camoufox-mcp) sobre el navegador oficial [Camoufox](https://github.com/daijro/camoufox) (binario fijado por SHA-256, sin compilar Firefox). README original: [docs/upstream-README.md](docs/upstream-README.md).

Dos modos en un solo binario:

| Comando | Qué hace |
|---|---|
| `camoufox-agent` | Servidor MCP por stdio (Claude Code, opencode, Hermes, OpenClaw, Codex, Cursor…) |
| `camoufox-agent serve` | HTTP: REST para apps web, MCP Streamable HTTP en `/mcp`, vista en vivo en `/live`, cron |
| `camoufox-agent run <flujo>` | Ejecuta un flujo guardado una vez (para cron/launchd/Programador de tareas) |
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
  - Límite: Camoufox es Firefox, sin CDP. No hay Lighthouse, performance traces de Chrome, heap snapshots ni cobertura; en Firefox faltan además CLS y long tasks (el informe los lista como no soportados).

Datos en `CAMOUFOX_AGENT_HOME` (por defecto `~/.camoufox-agent`): `profiles/`, `flows/`, `runs/`, `files/`, `secrets.json`.

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
for s in upload profile extract; do node scripts/mcp-smoke.mjs $s; done
CAMOUFOX_SECRET_HEROKU_PASS='SuperSecretPassword!' node scripts/mcp-smoke.mjs secret
CAMOUFOX_SECRET_HEROKU_PASS='SuperSecretPassword!' node scripts/mcp-smoke.mjs flow
```

Los escenarios usan un sitio local (`tests/fixtures/site.mjs`) con `CAMOUFOX_MCP_ALLOWED_PRIVATE_HOSTS=localhost`.
