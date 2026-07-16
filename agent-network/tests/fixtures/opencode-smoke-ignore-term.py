#!/usr/bin/env python3
"""ACP smoke fixture: succeeds, ignores TERM, and records non-secret state."""

import json
import os
import signal
import sys


RESULT = "/tmp/anet-opencode-smoke-fixture.json"


def send(value: object) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


if "--version" in sys.argv:
    print("1.18.1")
    raise SystemExit(0)

if sys.argv[1:] != ["acp"]:
    raise SystemExit(2)

# The caller must escalate to SIGKILL after its bounded TERM grace period.
signal.signal(signal.SIGTERM, signal.SIG_IGN)

for raw in sys.stdin:
    request = json.loads(raw)
    method = request.get("method")
    request_id = request.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": 1}})
    elif method == "session/new":
        with open(RESULT, "w", encoding="utf-8") as stream:
            json.dump(
                {
                    "pid": os.getpid(),
                    "cwd": os.getcwd(),
                    "sessionCwd": request.get("params", {}).get("cwd"),
                    "keys": sorted(os.environ),
                    "home": os.environ.get("HOME"),
                    "xdgConfig": os.environ.get("XDG_CONFIG_HOME"),
                    "inlineConfig": json.loads(os.environ["OPENCODE_CONFIG_CONTENT"]),
                },
                stream,
                sort_keys=True,
            )
        send({"jsonrpc": "2.0", "id": request_id, "result": {"sessionId": "ses_smoke_fixture"}})

