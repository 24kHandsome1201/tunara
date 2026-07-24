import http from "node:http";
import fs from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const port = Number(process.argv[2]);
const peerPort = Number(process.argv[3]);
const logPath = process.argv[4];
if (!Number.isInteger(port) || !Number.isInteger(peerPort) || !logPath) {
  throw new Error("usage: phase3-preview-security-server.mjs <port> <peer-port> <jsonl-log>");
}

function record(event, detail = {}) {
  fs.appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), port, event, ...detail })}\n`);
}

const page = `<!doctype html>
<meta charset="utf-8">
<title>Phase 3 Preview Security Fixture ${port}</title>
<style>body{font:15px system-ui;margin:24px;max-width:760px}button,a{display:inline-block;margin:5px;padding:7px}pre{padding:12px;background:#eee}</style>
<h1>Preview fixture ${port}</h1>
<p id="identity">origin=<strong>http://127.0.0.1:${port}</strong> peer=${peerPort}</p>
<pre id="ipc">probing</pre>
<button id="same">same-origin navigation</button>
<button id="public">public redirect</button>
<button id="other-port">other loopback port</button>
<button id="protocol">external protocol</button>
<button id="popup">public popup</button>
<a id="download" download href="/download">download fixture</a>
<script>
const report=(event,detail={})=>fetch('/event?event='+encodeURIComponent(event)+'&detail='+encodeURIComponent(JSON.stringify(detail))).catch(()=>{});
const internals=typeof window.__TAURI_INTERNALS__;
const globalApi=typeof window.__TAURI__;
document.querySelector('#ipc').textContent=JSON.stringify({internals,globalApi});
report('loaded',{href:location.href,internals,globalApi});
const reportViewport=()=>report('viewport',{innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio});
reportViewport();
addEventListener('resize',reportViewport);
(async()=>{
  if(!window.__TAURI_INTERNALS__?.invoke){report('ipc-bridge-absent');return}
  for(const [name,args] of [
    ['fs_read_file',{path:'/etc/hosts'}],
    ['plugin:store|load',{path:'phase3-preview-security.json',options:{autoSave:false}}],
    ['pty_write',{id:1,data:'FORBIDDEN'}],
    ['preview_telemetry_ingest',{event:{kind:'console-error',message:'forged'},nonce:'0'.repeat(64)}]
  ]){
    try{await window.__TAURI_INTERNALS__.invoke(name,args);report('ipc-invoke-unexpected-success',{name})}
    catch(error){report('ipc-invoke-denied',{name,message:String(error)})}
  }
})();
setTimeout(()=>{
  console.error('FIXTURE_CONSOLE_${port}', 'token=fixture-private-${port}');
  Promise.reject(new Error('FIXTURE_UNHANDLED_${port} /Users/fixture/private'));
  fetch('/status-failure?credential=fixture-private-${port}#hidden').catch(()=>{});
},2000);
document.querySelector('#same').onclick=()=>location.href='/same-origin';
document.querySelector('#public').onclick=()=>location.href='/redirect-public';
document.querySelector('#other-port').onclick=()=>location.href='http://127.0.0.1:${peerPort}/peer';
document.querySelector('#protocol').onclick=()=>location.href='tunara-preview-fixture://blocked';
document.querySelector('#popup').onclick=()=>report('popup-result',{opened:window.open('https://example.com/','_blank')!==null});
document.querySelector('#download').onclick=()=>report('download-clicked');
</script>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  record("request", { path: url.pathname });
  if (url.pathname === "/event") {
    record(url.searchParams.get("event") ?? "unknown", { detail: url.searchParams.get("detail") });
    response.writeHead(204).end();
  } else if (url.pathname === "/redirect-public") {
    response.writeHead(302, { Location: "https://example.com/phase3-blocked" }).end();
  } else if (url.pathname === "/download") {
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=blocked.txt" }).end("blocked download");
  } else if (url.pathname === "/status-failure") {
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }).end("fixture failure");
  } else if (url.pathname === "/same-origin") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<h1>same-origin allowed ${port}</h1>`);
  } else if (url.pathname === "/peer") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<h1>WRONG WORKTREE PEER ${port}</h1>`);
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page);
  }
});

server.listen(port, "127.0.0.1", () => {
  record("listening", { peerPort });
  process.stdout.write(`PREVIEW_FIXTURE_READY http://127.0.0.1:${port}/\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
