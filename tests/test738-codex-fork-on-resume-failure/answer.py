#!/usr/bin/env python3
"""Run a command on a real pseudo-terminal; when PROMPT appears in its output, type ANSWER.
  answer.py PROMPT ANSWER -- cmd args...      (output is copied to stdout; exit = the command's)"""
import os, pty, sys, time
prompt, answer = sys.argv[1].encode(), sys.argv[2].encode() + b"\r"
cmd = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
seen, answered = b"", False
while True:
    try: chunk = os.read(fd, 4096)
    except OSError: break
    if not chunk: break
    sys.stdout.buffer.write(chunk); sys.stdout.flush()
    seen = (seen + chunk)[-4096:]
    if not answered and prompt in seen:
        time.sleep(0.3); os.write(fd, answer); answered = True
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
