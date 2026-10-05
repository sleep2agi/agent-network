#!/usr/bin/env python3
# #543 — minimal OpenAI-compatible chat-completions stub (streaming + non-streaming),
# loopback only, no credentials. "Reply with exactly X" -> X; "STUB_FAIL" -> HTTP 400;
# "STUB_DELAY_<s>" -> the turn takes <s> seconds. Every request is logged (path, tool names,
# last user text) to argv[2] so the harness can see which tools OpenCode offered the model.
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = sys.argv[2] if len(sys.argv) > 2 else None
def last_user(body):
    for m in reversed(body.get("messages", [])):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):
                c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            return c or ""
    return ""
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": "stub-model", "object": "model"}]}); return
        self._json(404, {"error": "nf"})
    def _json(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        if LOG:
            with open(LOG, "a") as f: f.write(json.dumps({"path": self.path, "tools": [t.get("function", {}).get("name") for t in body.get("tools", []) or []], "user": last_user(body)[:200]}) + "\n")
        u = last_user(body)
        if "STUB_FAIL" in u:
            self._json(400, {"error": {"message": "stub provider refused: STUB_FAIL requested", "type": "invalid_request_error"}}); return
        m = re.search(r"Reply with exactly (\S+)", u)
        text = m.group(1) if m else "STUB_OK"
        d = re.search(r"STUB_DELAY_(\d+)", u)
        if d: time.sleep(int(d.group(1)))
        if not body.get("stream"):
            self._json(200, {"id": "c1", "object": "chat.completion", "created": int(time.time()), "model": "stub-model",
              "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
              "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}); return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("cache-control", "no-cache"); self.end_headers()
        def ev(o): self.wfile.write(("data: " + json.dumps(o) + "\n\n").encode()); self.wfile.flush()
        base = {"id": "c1", "object": "chat.completion.chunk", "created": int(time.time()), "model": "stub-model"}
        ev({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]})
        ev({**base, "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}]})
        ev({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
        self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
