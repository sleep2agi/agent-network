#!/usr/bin/env python3
"""Drive a REAL codex app-server over stdio (board #738 test fixture).
  new    BIN CWD        -> thread/start + turn/start; prints the new thread id
  turn   BIN CWD TID    -> thread/resume + turn/start (appends to the thread's rollout)
  resume BIN CWD TID    -> thread/resume; prints "RESUME OK <id>" or "RESUME ERROR <message>"
CODEX_HOME comes from the environment. The fake API key makes the model call fail; codex
writes the turn's opening lines to the rollout before that, which is all a fixture needs."""
import json, os, select, subprocess, sys, time
mode, binary, cwd = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(cwd, exist_ok=True)
p = subprocess.Popen([binary, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, cwd=cwd)
def send(o): p.stdin.write(json.dumps(o) + "\n"); p.stdin.flush()
pending = bytearray()
def wait(id_, t=60):
    end = time.monotonic() + t
    # Do not mix select(fd) with TextIOWrapper.readline(): readline can buffer
    # the response after a notification, leaving the fd empty until the timeout.
    # Drain complete buffered frames first; partial frames share the deadline.
    while time.monotonic() < end:
        if b"\n" in pending:
            line, _, rest = pending.partition(b"\n")
            pending[:] = rest
            try: m = json.loads(line)
            except ValueError: continue
            if isinstance(m, dict) and m.get("id") == id_: return m
            continue
        remaining = end - time.monotonic()
        if remaining <= 0: break
        r, _, _ = select.select([p.stdout], [], [], min(1, remaining))
        if not r: continue
        chunk = os.read(p.stdout.fileno(), 65536)
        if not chunk: break
        pending.extend(chunk)
    return {"error": {"message": "timeout"}}
send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "t738", "version": "0"}}}); wait(1)
send({"method": "initialized"})
try:
    if mode == "new":
        send({"id": 2, "method": "thread/start", "params": {"cwd": cwd}}); r = wait(2)
        tid = r["result"]["thread"]["id"]
        send({"id": 3, "method": "turn/start", "params": {"threadId": tid, "input": [{"type": "text", "text": "say hi"}]}}); wait(3)
        time.sleep(4); print(tid)
    elif mode == "turn":
        tid = sys.argv[4]
        send({"id": 2, "method": "thread/resume", "params": {"threadId": tid}}); r = wait(2)
        if "error" in r: sys.exit("resume failed: " + str(r["error"]))
        send({"id": 3, "method": "turn/start", "params": {"threadId": tid, "input": [{"type": "text", "text": "second msg"}]}}); wait(3)
        time.sleep(4)
    elif mode == "resume":
        send({"id": 2, "method": "thread/resume", "params": {"threadId": sys.argv[4], "excludeTurns": True}}); r = wait(2)
        if "error" in r: print("RESUME ERROR", r["error"].get("message"))
        else: print("RESUME OK", r["result"]["thread"]["id"])
finally:
    p.kill()
    p.wait()
