// Sitio local determinista para los escenarios E2E (reemplaza sitios públicos con terceros bloqueados por la política de red).
import http from "node:http";
import { createHash } from "node:crypto";

export const BIG_SIZE = 8 * 1024 * 1024;
const PASS = "SuperSecretPassword!";

function page(body) { return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`; }

export function startFixtureSite(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers }); res.end(body); };
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      const loggedIn = /(?:^|;\s*)fx=1/.test(req.headers.cookie ?? "");
      if (url.pathname === "/upload" && req.method === "GET") {
        return send(200, page(`<h3>File Uploader</h3><form method="post" enctype="multipart/form-data"><input id="file-upload" type="file" name="file" style="display:none"><input id="file-submit" type="submit" value="Upload"></form>`));
      }
      if (url.pathname === "/upload") {
        const name = /filename="([^"]*)"/.exec(body)?.[1] ?? "";
        return send(200, page(`<h3>File Uploaded!</h3><div id="uploaded-files">${name}</div>`));
      }
      if (url.pathname === "/login" && req.method === "GET") {
        return send(200, page(`<h2>Login Page</h2><form method="post"><input id="username" name="username"><input id="password" name="password" type="password"><button type="submit">Login</button></form>`));
      }
      if (url.pathname === "/login") {
        const params = new URLSearchParams(body);
        if (params.get("username") === "tomsmith" && params.get("password") === PASS) {
          return send(302, "", { location: "/secure", "set-cookie": "fx=1; Path=/; Max-Age=86400" });
        }
        return send(200, page(`<h2>Login Page</h2><div id="flash">Your password is invalid!</div>`));
      }
      if (url.pathname === "/secure") {
        return loggedIn ? send(200, page(`<h2>Secure Area</h2>`)) : send(302, "", { location: "/login" });
      }
      const m = /^\/quotes(?:\/page\/(\d+))?$/.exec(url.pathname);
      if (m) {
        const n = Number(m[1] ?? 1);
        const items = Array.from({ length: 10 }, (_, i) => {
          const k = (n - 1) * 10 + i + 1;
          return `<div class="quote"><span class="text">Quote "${k}", with comma</span><small class="author">Author ${k % 4}</small><a class="tag" href="/t/a">a${k}</a><a class="tag" href="/t/b">b</a></div>`;
        }).join("");
        return send(200, page(`${items}<ul>${n < 10 ? `<li class="next"><a href="/quotes/page/${n + 1}">Next</a></li>` : ""}</ul>`));
      }
      if (url.pathname === "/broken") {
        return send(200, `<!doctype html><html><head><title>Roto</title><style>.box{width:120px;padding:8px;border:2px solid red;color:blue}</style></head><body><h1>A</h1><h1>B</h1><img src="/missing.png"><div class="box" id="box">hola</div><a href="/x" target="_blank"></a><script>console.error("boom");console.warn("cuidado");setTimeout(()=>{throw new Error("fallo async")},50)</script></body></html>`);
      }
      if (url.pathname === "/api/data") {
        return send(200, JSON.stringify({ items: [1, 2, 3] }), { "content-type": "application/json" });
      }
      if (url.pathname === "/redirect-file") { res.writeHead(302, { location: "/big.bin" }); return res.end(); }
      if (url.pathname === "/file-post" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="post.bin"' });
        return res.end(Buffer.alloc(1024 * 1024, 3));
      }
      if (url.pathname === "/downloads") {
        return send(200, page(`<a id="d-redirect" href="/redirect-file">redirect</a>
<a id="d-blank" href="/big.bin" target="_blank">blank</a>
<button id="d-js" onclick="location.href='/big.bin'">js</button>
<button id="d-blob" onclick="document.title='blob-clicked';const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob([new Uint8Array(1048576).fill(5)]));a.download='blob.bin';document.body.appendChild(a);a.click()">blob</button>
<form method="post" action="/file-post"><button id="d-post" type="submit">post</button></form>
<iframe id="fr" srcdoc="<a id='d-frame' href='/big.bin' download>frame</a>"></iframe>`));
      }
      if (url.pathname === "/many") {
        return send(200, page(`<script>(async()=>{let ok=0;for(let i=0;i<1300;i++){const r=await fetch('/api/data?i='+i).catch(()=>null);if(r&&r.ok)ok++}document.title='many-'+ok})()</script>`));
      }
      if (url.pathname === "/gone") return send(404, page("<h1>gone</h1>"));
      if (url.pathname === "/frames") {
        return send(200, page(`<button id="top">top</button>
<div id="host"></div><details><summary id="sum">more</summary>hidden</details><div id="oc" onclick="document.title='oc'">oc</div>
<iframe id="fr" src="/frame-inner"></iframe>
<script>const r = document.getElementById("host").attachShadow({mode:"open"}); r.innerHTML = '<button id="sh" onclick="document.title=\\'shadow\\'">shadow</button>';</script>`));
      }
      if (url.pathname === "/frame-inner") {
        return send(200, page(`<button id="inner" onclick="parent.document.title='inner'">inner</button>`));
      }
      if (url.pathname === "/big.bin") {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="big.bin"' });
        return res.end(Buffer.alloc(BIG_SIZE, 7));
      }
      if (url.pathname === "/app") {
        return send(200, `<!doctype html><html><head><meta charset="utf-8"><title>App</title><style>.used{color:red}.unused{color:blue}</style></head><body>
<h1 id="title" class="used">Demo</h1>
<button id="inc">+1</button> <span id="count">0</span>
<button id="load">load</button> <button id="bad">bad</button> <button id="ask">ask</button>
<a id="pop" href="/app" target="_blank">pop</a> <a id="dl" download href="/big.bin">dl</a> <a id="dlbad" download href="/gone">dlbad</a>
<div id="src" draggable="true">src</div><div id="dst">dst</div>
<span id="touch"></span>
<button id="leak">leak</button> <button id="ws">ws</button> <button id="jank">jank</button>
<pre id="out"></pre>
<script>
const $ = (id) => document.getElementById(id);
localStorage.setItem("token", "abc123");
$("touch").textContent = String(navigator.maxTouchPoints || ("ontouchstart" in window ? 1 : 0)); // Camoufox fija maxTouchPoints en 0
$("inc").onclick = () => { $("count").textContent = String(Number($("count").textContent) + 1); };
$("load").onclick = async () => { $("out").textContent = await (await fetch("/api/data")).text(); };
$("bad").onclick = () => console.error("app-error");
$("ask").onclick = () => { $("out").textContent = confirm("¿Seguro?") ? "si" : "no"; };
$("dst").ondragover = (e) => e.preventDefault();
$("dst").ondrop = (e) => { e.preventDefault(); $("out").textContent = "dropped"; };
window.__leaked = [];
$("leak").onclick = () => { const d = document.createElement("div"); window.__leaked.push(d); document.body.appendChild(d); window.addEventListener("scroll", () => {}); };
$("ws").onclick = () => { const w = new WebSocket("ws://" + location.host + "/ws"); w.onopen = () => w.send("ping"); w.onmessage = (e) => { $("out").textContent = e.data; }; };
$("jank").onclick = () => { const t = performance.now(); while (performance.now() - t < 300); };
</script></body></html>`);
      }
      send(404, page("not found"));
    });
  });
  server.on("upgrade", (req, socket) => {
    if (new URL(req.url, "http://x").pathname !== "/ws") return socket.destroy();
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (buf) => {
      const op = buf[0] & 0x0f;
      if (op === 8) return socket.end();
      if (op !== 1) return;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      const mask = buf.subarray(off, off + 4); off += 4;
      const text = Buffer.from(buf.subarray(off, off + len).map((b, i) => b ^ mask[i % 4])).toString("utf8");
      const out = Buffer.from("pong:" + text);
      socket.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    resolve({ url: `http://localhost:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
