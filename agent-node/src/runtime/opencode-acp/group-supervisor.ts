/**
 * Source for the Linux-only OpenCode ACP process-group supervisor.
 *
 * It is deliberately evaluated by the already-running, trusted
 * `process.execPath` instead of being shipped as a second executable asset.
 * The supervisor becomes a long-lived session/process-group leader, reports
 * that identity over the private child-process IPC channel, and does not
 * launch OpenCode until the parent confirms that the durable launch marker is
 * on disk.  No control bytes are ever written to stdout: fd 0/1/2 are inherited
 * directly by the vendor process for the ACP transport.
 */
export const OPENCODE_GROUP_SUPERVISOR_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const { readdirSync, readFileSync } = require("node:fs");
const { isAbsolute } = require("node:path");

const GRACE_MS = 1200;
const POLL_MS = 25;
const selfPid = process.pid;
let vendor = null;
let launched = false;
let stopping = false;
let cleanupTimer = null;
let cleanupDeadline = 0;
let vendorExit = null;
let cleanupFailureReported = false;

function readStat(pid) {
  try {
    const source = readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = source.lastIndexOf(")");
    if (close < 0) return null;
    const fields = source.slice(close + 1).trim().split(/\s+/);
    const pgrp = Number(fields[2]);
    const session = Number(fields[3]);
    const start = fields[19];
    if (!fields[0] || !Number.isSafeInteger(pgrp) || !Number.isSafeInteger(session) || !start) {
      return null;
    }
    return { state: fields[0], pgrp, session, identity: pid + ":" + start };
  } catch {
    return null;
  }
}

function send(message, callback) {
  if (typeof process.send !== "function" || !process.connected) {
    if (callback) callback(new Error("parent IPC channel is closed"));
    return;
  }
  try {
    process.send(message, callback);
  } catch (error) {
    if (callback) callback(error);
  }
}

function sessionPeers() {
  let entries;
  try { entries = readdirSync("/proc"); }
  catch { return { kind: "unknown", peers: [] }; }
  const peers = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === selfPid) continue;
    const stat = readStat(pid);
    if (!stat || stat.state === "Z" || stat.state === "X") continue;
    if (stat.session === selfPid) peers.push({ pid, pgrp: stat.pgrp });
  }
  return { kind: "known", peers };
}

function finishWithoutPeers() {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  const code = vendorExit && Number.isInteger(vendorExit.code)
    ? Math.max(0, Math.min(255, vendorExit.code))
    : (stopping ? 0 : 1);
  process.exit(code);
}

function reportCleanupFailure(reason, peers) {
  if (!cleanupFailureReported) {
    cleanupFailureReported = true;
    send({
      v: 1,
      type: "cleanup-failed",
      reason,
      peers: peers.map((peer) => ({ pid: peer.pid, pgrp: peer.pgrp })),
    });
  }
  // Keep the exact SID/PGID leader alive. A later retry may succeed after an
  // opaque or alternate-pgrp descendant exits; killing the anchor would turn
  // a detected residual tree into an unowned orphan.
  cleanupTimer = setTimeout(checkCleanup, POLL_MS * 8);
}

function forceOwnedGroup() {
  const inspected = sessionPeers();
  if (inspected.kind !== "known") {
    reportCleanupFailure("cannot inspect supervisor session", []);
    return;
  }
  const escaped = inspected.peers.filter((peer) => peer.pgrp !== selfPid);
  if (escaped.length > 0) {
    reportCleanupFailure("same-session process escaped the owned process group", escaped);
    return;
  }
  if (inspected.peers.length === 0) {
    finishWithoutPeers();
    return;
  }
  // The caller is still the exact process-group leader. This is the only
  // negative-PGID SIGKILL in the design; it atomically kills the leader and
  // every remaining member, so no stale numeric PGID is ever targeted.
  process.kill(-selfPid, "SIGKILL");
}

function checkCleanup() {
  cleanupTimer = null;
  const inspected = sessionPeers();
  if (inspected.kind !== "known") {
    reportCleanupFailure("cannot inspect supervisor session", []);
    return;
  }
  if (inspected.peers.length === 0) {
    finishWithoutPeers();
    return;
  }
  const escaped = inspected.peers.filter((peer) => peer.pgrp !== selfPid);
  if (escaped.length > 0) {
    reportCleanupFailure("same-session process escaped the owned process group", escaped);
    return;
  }
  if (Date.now() >= cleanupDeadline) {
    forceOwnedGroup();
    return;
  }
  cleanupTimer = setTimeout(checkCleanup, POLL_MS);
}

function beginGraceful(signal) {
  if (!launched) {
    process.exit(0);
    return;
  }
  if (!stopping) {
    stopping = true;
    cleanupFailureReported = false;
    cleanupDeadline = Date.now() + GRACE_MS;
    // Setting the stopping flag first prevents the supervisor's own handler
    // from recursively rebroadcasting this group-directed signal.
    try { process.kill(-selfPid, signal); }
    catch (error) {
      reportCleanupFailure("failed to signal owned process group: " + String(error), []);
      return;
    }
  }
  if (!cleanupTimer) cleanupTimer = setTimeout(checkCleanup, POLL_MS);
}

function beginForce() {
  if (!launched) {
    process.exit(0);
    return;
  }
  stopping = true;
  cleanupFailureReported = false;
  forceOwnedGroup();
}

function failBeforeOrAfterLaunch(phase, error) {
  send({ v: 1, type: "fatal", phase, message: String(error && error.message || error) });
  if (launched) beginForce();
  else process.exit(125);
}

process.on("message", (message) => {
  if (!message || message.v !== 1 || typeof message.type !== "string") return;
  if (message.type === "launch") {
    if (launched || stopping) return;
    const binary = message.binary;
    if (typeof binary !== "string" || !isAbsolute(binary) || binary.includes("\0")) {
      failBeforeOrAfterLaunch("launch", new Error("invalid pinned OpenCode binary"));
      return;
    }
    launched = true;
    try {
      vendor = spawn(binary, ["acp"], {
        env: process.env,
        stdio: "inherit",
        detached: false,
      });
    } catch (error) {
      failBeforeOrAfterLaunch("spawn", error);
      return;
    }
    vendor.once("spawn", () => {
      send({ v: 1, type: "child-started", childPid: vendor.pid });
    });
    vendor.once("error", (error) => {
      failBeforeOrAfterLaunch("spawn", error);
    });
    vendor.once("exit", (code, signal) => {
      vendorExit = { code, signal };
      send({ v: 1, type: "vendor-exit", code, signal });
      beginGraceful("SIGTERM");
    });
    return;
  }
  if (message.type === "stop") {
    if (message.mode === "force") beginForce();
    else beginGraceful(message.signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  }
});

process.on("disconnect", () => beginGraceful("SIGTERM"));
process.on("SIGTERM", () => { if (!stopping) beginGraceful("SIGTERM"); });
process.on("SIGINT", () => { if (!stopping) beginGraceful("SIGINT"); });
process.on("SIGHUP", () => { if (!stopping) beginGraceful("SIGTERM"); });
process.on("uncaughtException", (error) => failBeforeOrAfterLaunch("uncaughtException", error));
process.on("unhandledRejection", (error) => failBeforeOrAfterLaunch("unhandledRejection", error));

if (process.platform !== "linux" || typeof process.send !== "function" || !process.connected) {
  process.exit(125);
} else {
  const stat = readStat(selfPid);
  if (!stat || stat.pgrp !== selfPid || stat.session !== selfPid) {
    process.exit(125);
  } else {
    send({
      v: 1,
      type: "supervisor-ready",
      pid: selfPid,
      identity: stat.identity,
      processGroupId: stat.pgrp,
      sessionId: stat.session,
    }, (error) => {
      if (error) process.exit(125);
    });
  }
}
`;
