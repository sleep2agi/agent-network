#!/usr/bin/env bash

# Return success only when a direct REST response or an MCP JSON-RPC/SSE
# response contains a canonical boolean `ok: true`.  A literal "ok" token is
# not evidence: `{ "ok": false }` contains the same substring and was the
# source of #292's false-green E2E assertions.
#
# The function is intentionally silent.  Callers may print the original
# response on failure, but this parser never echoes response data itself.
response_json_ok() {
  local payload=${1-}
  printf '%s' "$payload" | python3 -c '
import json
import sys

raw = sys.stdin.read().strip()
if not raw:
    raise SystemExit(1)

candidates = []
for line in raw.splitlines():
    stripped = line.strip()
    if stripped.startswith("data:"):
        stripped = stripped[5:].strip()
    if not stripped or stripped == "[DONE]":
        continue
    try:
        candidates.append(json.loads(stripped))
    except Exception:
        pass

if not candidates:
    try:
        candidates.append(json.loads(raw))
    except Exception:
        raise SystemExit(1)

seen_true = False
seen_failure = False

def inspect(value, depth=0):
    global seen_true, seen_failure
    if depth > 6:
        seen_failure = True
        return
    if isinstance(value, str):
        try:
            inspect(json.loads(value), depth + 1)
        except Exception:
            return
        return
    if isinstance(value, list):
        for item in value:
            inspect(item, depth + 1)
        return
    if not isinstance(value, dict):
        return
    if value.get("isError") is True or value.get("error") is not None:
        seen_failure = True
    if "ok" in value:
        if value.get("ok") is True:
            seen_true = True
        else:
            seen_failure = True
    if "result" in value:
        inspect(value["result"], depth + 1)
    if "content" in value:
        inspect(value["content"], depth + 1)
    if value.get("type") == "text" and "text" in value:
        inspect(value["text"], depth + 1)

for candidate in candidates:
    inspect(candidate)

raise SystemExit(0 if seen_true and not seen_failure else 1)
'
}
