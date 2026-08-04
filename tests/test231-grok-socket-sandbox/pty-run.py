#!/usr/bin/env python3
import argparse
import errno
import os
import pty
import select
import signal
import time


parser = argparse.ArgumentParser()
parser.add_argument("--timeout", type=float, required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--watch-socket", required=True)
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
if args.command[:1] == ["--"]:
    args.command = args.command[1:]
if not args.command:
    raise SystemExit("missing command")

pid, fd = pty.fork()
if pid == 0:
    os.execvp(args.command[0], args.command)

deadline = time.monotonic() + args.timeout
captured = bytearray()
socket_seen = False
status = None
while time.monotonic() < deadline:
    socket_seen = socket_seen or os.path.exists(args.watch_socket)
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
            if chunk:
                captured.extend(chunk)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

timed_out = status is None
if timed_out:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            pass
        end = time.monotonic() + 0.5
        while time.monotonic() < end:
            waited, candidate = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = candidate
                break
            time.sleep(0.02)
        if status is not None:
            break
if status is None:
    _, status = os.waitpid(pid, 0)

# Grok's leader helper may inherit the slave PTY after the direct child has
# exited. Do not let a bounded liveness probe become an unbounded blocking
# read merely because that detached helper still owns the descriptor.
os.set_blocking(fd, False)
while True:
    try:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        captured.extend(chunk)
    except BlockingIOError:
        break
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        break
os.close(fd)

captured.extend(f"\nTEST231_SOCKET_SEEN={int(socket_seen)}\n".encode())
with open(args.output, "wb") as output:
    output.write(captured)

if timed_out:
    raise SystemExit(124)
if os.WIFEXITED(status):
    raise SystemExit(os.WEXITSTATUS(status))
raise SystemExit(128 + os.WTERMSIG(status))
