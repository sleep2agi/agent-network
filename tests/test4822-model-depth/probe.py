"""Stock pinned V2 -> synthetic Provider -> native messages -> one-command readback.

No real model credentials, host HOME, shared server, tmux or crontab involved.
Different responses prove transport, not reasoning quality of a real LLM.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(tempfile.mkdtemp(prefix="model-depth-"))
AUTH = "Basic " + base64.b64encode(b"opencode:fixture4822").decode()
SEEN = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        SEEN.append(body)
        marker = "EFFORT_" + body.get("reasoning_effort", "MISSING")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        base = {"id": "fixture", "object": "chat.completion.chunk", "created": int(time.time()), "model": "model"}
        for delta, finish in [({"role": "assistant", "content": marker}, None), ({}, "stop")]:
            chunk = {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def request(path, body=None):
    req = urllib.request.Request("http://127.0.0.1:18543" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": AUTH, "Content-Type": "application/json", "x-opencode-directory": str(ROOT)})
    with urllib.request.urlopen(req, timeout=10) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


provider = ThreadingHTTPServer(("127.0.0.1", 18544), Provider)
threading.Thread(target=provider.serve_forever, daemon=True).start()
variants = [{"id": depth, "settings": {"reasoningEffort": depth}} for depth in ["low", "high"]]
config = {"providers": {"fixture": {
    "package": "@opencode/ai/providers/openai-compatible",
    "settings": {"baseURL": "http://127.0.0.1:18544/v1", "apiKey": "fixture-not-secret"},
    "models": {"model": {"variants": variants}},
}}}
env = dict(os.environ, HOME=str(ROOT), XDG_CONFIG_HOME=str(ROOT / "config"),
    XDG_DATA_HOME=str(ROOT / "data"), XDG_STATE_HOME=str(ROOT / "state"), XDG_CACHE_HOME=str(ROOT / "cache"),
    OPENCODE_CONFIG_CONTENT=json.dumps(config), OPENCODE_SERVER_PASSWORD="fixture4822")
digest = hashlib.sha256(Path("/tool/opencode").read_bytes()).hexdigest()
assert digest == "32cf5aa0a69a650e36277e3315d189835ddc79fb9aa1d0aef5025be5af5ad122", digest
print("stock_binary_sha256=" + digest, flush=True)
with (ROOT / "runtime.log").open("w") as log:
    process = subprocess.Popen(["/tool/opencode", "serve", "--hostname", "127.0.0.1", "--port", "18543"],
        cwd=ROOT, env=env, stdout=log, stderr=log)
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                info = request("/api/info")
                break
            except Exception:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("isolated stock runtime startup failed")
                time.sleep(.2)
        assert info["version"] == "2.0.22", info
        model = {"providerID": "fixture", "id": "model", "variant": "low"}
        created = request("/api/session", {"location": {"directory": str(ROOT)}, "model": model})
        sid = created["data"]["id"]
        # Session creation itself must preserve depth, not only later switches.
        assert request("/api/session/" + sid)["data"]["model"] == model
        evidence = []
        for depth in ["low", "high"]:
            model = {**model, "variant": depth}
            request("/api/session/" + sid + "/model", {"model": model})
            assert request("/api/session/" + sid)["data"]["model"] == model
            count = len(SEEN)
            request("/api/session/" + sid + "/prompt", {"text": "Return a short answer.", "delivery": "queue"})
            deadline = time.monotonic() + 30
            while True:
                messages = request("/api/session/" + sid + "/message")
                if len(SEEN) > count and "EFFORT_" + depth in json.dumps(messages):
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("missing provider response marker for " + depth)
                time.sleep(.2)
            assert SEEN[-1]["model"] == "model"
            assert SEEN[-1].get("reasoning_effort") == depth
            evidence.append({"provider": "fixture", "model": "model", "depth": depth, "response": "EFFORT_" + depth})
        # The catalog may not have settled at startup. Check only the exact fixture,
        # not an invented hardcoded global list or a claim of complete availability.
        catalog = request("/api/model")
        fixture = [row for row in catalog["data"] if row["providerID"] == "fixture" and row["id"] == "model"]
        assert len(fixture) == 1
        assert {row["id"] for row in fixture[0]["variants"]} == {"low", "high"}
        node = ROOT / "diagnostic-node"
        node.mkdir()
        endpoint = node / "opencode-v2-catalog-endpoint.json"
        endpoint.write_text(json.dumps({"version": 1, "url": "http://127.0.0.1:18543", "authorization": AUTH, "directory": str(ROOT)}))
        endpoint.chmod(0o600)
        command = subprocess.run(["bun", "scripts/opencode-v2-model-depth.ts", str(node), sid],
            cwd="/repo", env=env, capture_output=True, text=True, timeout=30)
        assert command.returncode == 0, command.stderr
        output = json.loads(command.stdout)
        assert output["current"] == {"provider": "fixture", "model": "model", "depth": "high"}
        assert {"provider": "fixture", "model": "model", "availableDepths": ["low", "high"]} in output["models"]
        assert AUTH not in command.stdout and "fixture-not-secret" not in command.stdout
        print("PASS stock create/switch/prompt/provider-response: " + json.dumps(evidence))
        print("PASS single-command catalog/current: " + command.stdout)
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        provider.shutdown()
