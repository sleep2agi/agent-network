#!/usr/bin/env python3
"""Serve the locally built agent-node tarball as a one-package npm registry.

Why this exists: a headless codex-app-server start resolves agent-node ONLY as
the exact release pair, `npx -y @sleep2agi/agent-node@<PAIRED_AGENT_NODE_VERSION>`
(agent-network/bin/cli.ts resolveCodexAgentNodeLaunchPlan; anet itself ignores
PATH by design). On a release PR that pin names a version that is not on npm yet, so
npx fails with ETARGET and the daemon's child exits before agent-node starts.
The only override, ANET_AGENT_NODE_BIN, cannot reach the child: the daemon
forks `anet node start` with minimalEnv(). HOME does reach it, so run.sh points
the @sleep2agi scope at this server through $HOME/.npmrc.

npx (libnpmexec) fetches the packument for `name@version` first and only then
notices the global install of that exact version and runs it — so in practice
only the packument is requested and the child runs the image's global agent-node
(this build), same as on main. The tarball is served too in case the global
lookup ever misses; the tarball's own dependencies would still come from npm.

usage: paired-registry.py <tgz> <port>
"""
import base64
import hashlib
import http.server
import json
import sys
import tarfile
from urllib.parse import unquote

tgz_path, port = sys.argv[1], int(sys.argv[2])
raw = open(tgz_path, "rb").read()
with tarfile.open(tgz_path, "r:gz") as tf:
    pkg = json.load(tf.extractfile("package/package.json"))
name, version = pkg["name"], pkg["version"]
tarball_url = f"http://127.0.0.1:{port}/tarball.tgz"
manifest = dict(pkg)
manifest["_id"] = f"{name}@{version}"
manifest["dist"] = {
    "tarball": tarball_url,
    "shasum": hashlib.sha1(raw).hexdigest(),
    "integrity": "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode(),
}
packument = json.dumps({
    "name": name,
    "dist-tags": {"latest": version, "preview": version},
    "versions": {version: manifest},
}).encode()


class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = unquote(self.path.split("?", 1)[0]).lstrip("/")
        if path == name:
            body, ctype = packument, "application/json"
        elif path == "tarball.tgz":
            body, ctype = raw, "application/octet-stream"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[paired-registry] " + (fmt % args) + "\n")


print(f"[paired-registry] serving {name}@{version} on 127.0.0.1:{port}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
