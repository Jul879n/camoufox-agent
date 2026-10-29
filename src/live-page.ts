// Página única (sin build ni dependencias) para ver y controlar sesiones en vivo.
export const LIVE_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Camoufox Agent — vista en vivo</title>
<style>
  body{font:14px system-ui,sans-serif;margin:0;background:#111;color:#eee}
  header{display:flex;gap:8px;align-items:center;padding:8px 12px;background:#1c1c1c;flex-wrap:wrap}
  select,input,button{font:inherit;padding:4px 8px}
  #stage{padding:12px}
  #frame{max-width:100%;border:1px solid #444;cursor:crosshair;background:#000;outline:none}
  #pending{padding:0 12px 12px}
  .card{border:1px solid #555;background:#222;border-radius:6px;padding:8px;margin:6px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  #status{color:#9a9}
</style></head><body>
<header>
  <label>Sesión <select id="sessions"></select></label>
  <input id="text" placeholder="Texto a escribir/pegar" size="28">
  <button id="send">Enviar texto</button>
  <span id="status"></span>
</header>
<div id="pending"></div>
<div id="stage"><img id="frame" tabindex="0" alt="Sin sesión"></div>
<script>
(function(){
  var token = new URLSearchParams(location.search).get("token") || "";
  history.replaceState(null, "", location.pathname);
  var sel = document.getElementById("sessions"), img = document.getElementById("frame"),
      statusEl = document.getElementById("status"), pendingEl = document.getElementById("pending");
  function api(path, opts){
    opts = opts || {}; opts.headers = Object.assign({}, opts.headers, token ? {Authorization: "Bearer " + token} : {});
    return fetch(path, opts);
  }
  function post(path, body){
    return api(path, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
  }
  function refreshSessions(){
    api("/api/sessions").then(function(r){ return r.json(); }).then(function(list){
      if (!Array.isArray(list)) { statusEl.textContent = "No autorizado"; return; }
      var current = sel.value;
      sel.innerHTML = "";
      list.forEach(function(s){
        var o = document.createElement("option");
        o.value = s.id; o.textContent = (s.profile ? s.profile + " · " : "") + s.url;
        sel.appendChild(o);
      });
      if (list.some(function(s){ return s.id === current; })) sel.value = current;
      statusEl.textContent = list.length ? "" : "Sin sesiones activas";
    }).catch(function(){ statusEl.textContent = "Sin conexión"; });
  }
  var busy = false, lastUrl = null;
  function refreshFrame(){
    if (busy || !sel.value) return;
    busy = true;
    api("/api/sessions/" + encodeURIComponent(sel.value) + "/frame.jpg?t=" + Date.now())
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(function(b){ var u = URL.createObjectURL(b); img.onload = function(){ if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = u; }; img.src = u; })
      .catch(function(){}).then(function(){ busy = false; });
  }
  function refreshPending(){
    api("/api/human").then(function(r){ return r.json(); }).then(function(list){
      if (!Array.isArray(list)) return;
      pendingEl.innerHTML = "";
      list.forEach(function(p){
        var d = document.createElement("div"); d.className = "card";
        var t = document.createElement("span"); t.textContent = p.reason; d.appendChild(t);
        var code = null;
        if (p.kind === "code") { code = document.createElement("input"); code.placeholder = p.label || "Código"; d.appendChild(code); }
        var b = document.createElement("button"); b.textContent = "Listo";
        b.onclick = function(){ post("/api/human/" + p.id, code ? {code: code.value} : {}).then(refreshPending); };
        d.appendChild(b);
        sel.value = p.sessionId || sel.value;
        pendingEl.appendChild(d);
      });
    }).catch(function(){});
  }
  function input(body){ if (!sel.value) return; post("/api/sessions/" + encodeURIComponent(sel.value) + "/input", body).then(function(){ setTimeout(refreshFrame, 150); }); }
  img.addEventListener("click", function(e){
    img.focus();
    var rect = img.getBoundingClientRect();
    input({type: "click", x: Math.round((e.clientX - rect.left) * img.naturalWidth / rect.width), y: Math.round((e.clientY - rect.top) * img.naturalHeight / rect.height)});
  });
  img.addEventListener("keydown", function(e){
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault(); input({type: "key", key: e.key});
  });
  img.addEventListener("wheel", function(e){ e.preventDefault(); input({type: "scroll", deltaY: Math.round(e.deltaY)}); }, {passive: false});
  document.getElementById("send").onclick = function(){
    var t = document.getElementById("text"); if (t.value) { input({type: "type", text: t.value}); t.value = ""; }
  };
  setInterval(refreshFrame, 700); setInterval(refreshSessions, 3000); setInterval(refreshPending, 2000);
  refreshSessions(); refreshPending();
})();
</script></body></html>`;
