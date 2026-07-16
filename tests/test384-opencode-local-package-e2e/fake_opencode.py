#!/usr/bin/python3
"""Deterministic OpenCode ACP child for release security/lifecycle gates.

The mode is read from /tmp/test384/fake-opencode-mode so the runtime does not
need to inherit a test-only environment variable.  Captures key *names* and a
small allowlisted set of non-secret values; credential values are never
written to disk or the persisted report.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


ROOT = Path("/tmp/test384")
MODE_FILE = ROOT / "fake-opencode-mode"


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def send(value: object) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    if "--version" in sys.argv:
        print("1.18.1")
        return 0
    if len(sys.argv) < 2 or sys.argv[1] != "acp":
        print("fake-opencode only implements --version and acp", file=sys.stderr)
        return 2

    mode = MODE_FILE.read_text(encoding="utf-8").strip()
    if mode not in {"good", "reject", "hang"}:
        raise RuntimeError(f"unknown fake mode: {mode!r}")

    selected_names = (
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PWD",
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "XDG_RUNTIME_DIR",
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_PERMISSION",
        "OPENCODE_TEST_MANAGED_CONFIG_DIR",
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_PURE",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_LSP_DOWNLOAD",
    )
    # Do not capture arbitrary values: the complete key inventory is enough
    # to prove that credentials were removed at the final spawn boundary.
    dump_path = ROOT / f"fake-opencode-env-{mode}.json"
    dump = {
        "mode": mode,
        "pid": os.getpid(),
        "executable": str(Path(sys.argv[0]).resolve()),
        "argv": sys.argv[1:],
        "cwd": os.getcwd(),
        "keys": sorted(os.environ),
        "selected": {name: os.environ[name] for name in selected_names if name in os.environ},
        "session_requests": [],
    }
    write_json(dump_path, dump)
    (ROOT / f"fake-opencode-pid-{mode}").write_text(str(os.getpid()), encoding="ascii")

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request = json.loads(raw)
        request_id = request.get("id")
        method = request.get("method")

        if mode == "hang":
            # Deliberately keep the handshake open until the foreground
            # supervisor is signalled.  This exercises the opening window.
            continue
        if mode == "reject" and method == "initialize":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32077, "message": "intentional handshake rejection"},
                }
            )
            # Stay alive after rejecting. The runtime must explicitly reap us.
            continue

        if method in {"session/load", "session/new"}:
            dump["session_requests"].append(
                {"method": method, "cwd": request.get("params", {}).get("cwd")}
            )
            write_json(dump_path, dump)

        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {}}
        elif method == "session/load":
            result = {"sessionId": request.get("params", {}).get("sessionId", "ses_fake_security")}
        elif method == "session/new":
            result = {"sessionId": "ses_fake_security"}
        elif method == "session/prompt":
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "ses_fake_security",
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "SECURITY_PROBE_OK"},
                        },
                    },
                }
            )
            result = {
                "stopReason": "end_turn",
                "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
            }
        else:
            result = {}
        send({"jsonrpc": "2.0", "id": request_id, "result": result})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
