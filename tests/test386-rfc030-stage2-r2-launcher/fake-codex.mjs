#!/usr/bin/env node

// Fake only at the Codex executable boundary. Keeping this as a direct Node
// shebang avoids Bash synthesizing PWD/SHLVL/_ and lets the probe inspect the
// exact environment received across the real util-linux PTY + shell exec.

import { readFileSync, writeFileSync } from "node:fs";

const CAPTURE = "/tmp/rfc030-tui-capture.txt";
const stat = readFileSync("/proc/self/stat", "utf8");
const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
const wrapperStat = readFileSync(`/proc/${process.ppid}/stat`, "utf8");
const wrapperAfterComm = wrapperStat
  .slice(wrapperStat.lastIndexOf(")") + 2)
  .trim()
  .split(/\s+/);
// /proc/<pid>/stat fields after comm begin at field 3 (state): ppid/pgrp/sid
// are indexes 1/2/3 and starttime (field 22) is index 19.
const parentPid = Number(afterComm[1]);
const processGroupId = Number(afterComm[2]);
const sessionId = Number(afterComm[3]);

const lines = [
  `PID=${process.pid}`,
  `PPID=${parentPid}`,
  `PGID=${processGroupId}`,
  `SID=${sessionId}`,
  `STARTTIME=${afterComm[19]}`,
  `WRAPPER_PID=${parentPid}`,
  `WRAPPER_PGID=${wrapperAfterComm[2]}`,
  `WRAPPER_SID=${wrapperAfterComm[3]}`,
  `WRAPPER_STARTTIME=${wrapperAfterComm[19]}`,
  ...process.argv.slice(2).map((arg) => `ARG=${arg}`),
  ...Object.keys(process.env).sort().map((key) => `ENV_KEY=${key}`),
];
writeFileSync(CAPTURE, `${lines.join("\n")}\n`, { mode: 0o600 });

// Force the launcher's bounded TERM -> KILL path. No environment value is
// printed, so the bearer cannot enter either the capture or report.
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
process.on("SIGINT", () => {});
setInterval(() => {}, 1_000);
