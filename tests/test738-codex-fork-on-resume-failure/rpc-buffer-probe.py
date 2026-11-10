#!/usr/bin/env python3
"""Exercise the shipped fixture with coalesced JSON-RPC notification/response.

This is a fixture transport regression, not a fake replacement for native L2.
All generated files and owned process groups belong to the Docker test only.
"""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

helper = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="t738-rpc-buffer-") as root:
    fake = Path(root) / "fake-codex"
    fake.write_text('''#!/usr/bin/env python3
import json, os, sys, time
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        os.write(1, b'{"id":1,"result":{}}\\n')
    elif msg.get("method") == "thread/resume":
        tid = msg["params"]["threadId"]
        response = (json.dumps({"id": 2, "result": {"thread": {"id": tid}}}) + "\\n").encode()
        if tid == "eof":
            sys.exit(0)
        if tid == "fragmented":
            os.write(1, response[:12])
            time.sleep(0.05)
            os.write(1, response[12:])
        else:
            # One write: TextIOWrapper.readline may read every line ahead.
            prefix = b'{"method":"thread/status/changed","params":{}}\\n'
            if tid == "malformed":
                prefix += b'not-json\\nnull\\n[]\\n'
            os.write(1, prefix + response)
''')
    fake.chmod(0o700)
    for mode in ("coalesced", "malformed", "fragmented", "eof"):
        proc = subprocess.Popen(
            [sys.executable, str(helper), "resume", str(fake), root, mode],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        try:
            try:
                out, err = proc.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                print(f"FAIL: {mode} was not consumed within 3s", flush=True)
                sys.exit(1)
            expected = "RESUME ERROR timeout" if mode == "eof" else f"RESUME OK {mode}"
            if proc.returncode != 0 or out.strip() != expected:
                print(f"FAIL: {mode} exit={proc.returncode} stdout={out!r} stderr={err!r}")
                sys.exit(1)
            print(f"PASS: {mode}")
        finally:
            # Private session created above, never any ambient tmux/process group.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
