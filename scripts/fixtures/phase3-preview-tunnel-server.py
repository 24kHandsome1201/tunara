#!/usr/bin/env python3
import argparse
import http.server
import socket


parser = argparse.ArgumentParser()
parser.add_argument("--host", choices=("127.0.0.1", "::1"), required=True)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--label", choices=("A", "B"), required=True)
args = parser.parse_args()
if not 1 <= args.port <= 65535:
    raise SystemExit("invalid port")


PAGE = f"""<!doctype html>
<meta charset=\"utf-8\"><title>Tunara tunnel {args.label}</title>
<h1 id=\"identity\">TUNARA_TUNNEL_{args.label}</h1>
<script>
(async () => {{
  console.error('TUNARA_TUNNEL_{args.label}_LOADED');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) {{ console.error('TUNARA_TUNNEL_{args.label}_BRIDGE_ABSENT'); return; }}
  const rejected = [];
  const unexpected = [];
  for (const [category, name, payload] of [
    ['file', 'fs_read_file', {{path:'/etc/hosts'}}],
    ['store', 'plugin:store|load', {{path:'forbidden.json',options:{{autoSave:false}}}}],
    ['pty', 'pty_write', {{id:1,data:'FORBIDDEN'}}],
    ['ssh', 'ssh_hosts_load', {{}}],
    ['tunnel', 'preview_tunnel_close', {{source:{{}}}}],
    ['app', 'preview_open', {{source:{{}}}}]
  ]) {{
    try {{ await invoke(name, payload); unexpected.push(category); }}
    catch (_) {{ rejected.push(category); }}
  }}
  console.error('TUNARA_TUNNEL_{args.label}_ACL_COMPLETE rejected=' + rejected.join(',') + ' unexpected=' + (unexpected.join(',') || 'none'));
}})();
</script>""".encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, _format, *_args):
        pass


class Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6 if args.host == "::1" else socket.AF_INET


with Server((args.host, args.port), Handler) as server:
    shown_host = f"[{args.host}]" if ":" in args.host else args.host
    print(f"TUNARA_TUNNEL_{args.label}_READY http://{shown_host}:{args.port}/", flush=True)
    server.serve_forever()
