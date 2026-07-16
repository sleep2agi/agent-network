#!/usr/bin/env python3
"""Drive the real, exact-pinned upstream auth prompt without logging its key."""

import os
import signal
import sys
import time
from pathlib import Path

import pexpect


def fail(message: str) -> None:
    print(f"AUTH_LOGIN_FAIL: {message}", file=sys.stderr)
    raise SystemExit(1)


if len(sys.argv) != 4 or sys.argv[1] not in {"interrupt", "success"}:
    fail("usage: auth_login_probe.py interrupt|success WORKDIR NODE")

mode, workdir, node = sys.argv[1:]
key = os.environ.get("TEST_AUTH_LOGIN_KEY", "")
if mode == "success" and not key:
    fail("missing synthetic TEST_AUTH_LOGIN_KEY")
marker_raw = os.environ.get("AUTH_LOGIN_ANCESTOR_MARKER", "")
if not marker_raw:
    fail("missing AUTH_LOGIN_ANCESTOR_MARKER")
marker = Path(marker_raw)


def assert_plugin_absent(stage: str) -> None:
    if marker.exists() or marker.is_symlink():
        fail(f"malicious ancestor plugin executed by {stage}")

env = dict(os.environ)
for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY"):
    env.pop(name, None)

child = pexpect.spawn(
    "anet",
    ["opencode", "auth-login", node, "--provider", "anthropic"],
    cwd=workdir,
    env=env,
    encoding="utf-8",
    timeout=45,
)
child.setwinsize(40, 120)

try:
    child.expect("Enter your API key")
    assert_plugin_absent("real prompt")
    if mode == "interrupt":
        # Signal only the parent CLI. Its bounded signal-forwarding path must
        # reap upstream and finish sandbox cleanup before the process exits.
        child.kill(signal.SIGINT)
        child.expect(pexpect.EOF)
        child.close()
        if child.exitstatus == 0:
            fail("interrupted helper unexpectedly exited zero")
        assert_plugin_absent("interrupted helper exit")
    else:
        # OpenCode 1.18.1 renders this through OpenTUI. Sending the full line
        # in the same PTY chunk as the prompt match can be consumed as an
        # empty submit; model a human keystroke cadence instead, without ever
        # attaching a logfile or printing the buffer/key.
        time.sleep(0.25)
        for character in key:
            child.send(character)
            time.sleep(0.015)
        child.send("\r")
        child.expect("imported anthropic API credential")
        child.expect(pexpect.EOF)
        child.close()
        if child.exitstatus != 0:
            fail("successful helper exited nonzero")
        assert_plugin_absent("successful helper exit")
except Exception:
    child.close(force=True)
    fail(f"interactive {mode} path did not reach its expected terminal state")

print(f"AUTH_LOGIN_PASS: {mode}")
