// Sitio local determinista para los escenarios E2E (reemplaza sitios públicos con terceros bloqueados por la política de red).
import http from "node:http";

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
      send(404, page("not found"));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    resolve({ url: `http://localhost:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
