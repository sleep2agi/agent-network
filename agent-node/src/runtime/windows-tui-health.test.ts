import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { readWindowsTuiIdentity, probeWindowsTuiHealth, runPowerShell } from "./windows-tui-health";
import {
  describePreCheck,
  diagnosingRunPowerShell,
  measureFixtureBirthQuery,
  windowsTuiDiagnosticsEnabled,
} from "./windows-tui-health-diagnostics";
import { createCodexHealthMonitor, ModelAuthTracker } from "./codex-health";

const identity = { version: 1 as const, nodeId: "n_test", marker: "generation-a", remote: "ws://127.0.0.1:9000", pid: 42, creationDate: "1234" };

test("receipt requires exact node, marker, remote and safe process identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-health-"));
  const path = join(dir, "windows-tui-health.json");
  try {
    expect(readWindowsTuiIdentity(path, identity)).toBeUndefined();
    writeFileSync(path, JSON.stringify(identity));
    expect(readWindowsTuiIdentity(path, identity)).toEqual(identity);
    for (const change of [{ nodeId: "other" }, { marker: "old" }, { remote: "ws://127.0.0.1:9001" }, { pid: 0 }, { creationDate: "1234';exit" }, { version: 2 }]) {
      writeFileSync(path, JSON.stringify({ ...identity, ...change }));
      expect(readWindowsTuiIdentity(path, identity)).toBeUndefined();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only explicit native evidence proves running, death or missing connection", async () => {
  for (const reason of ["running", "pane-dead", "session-missing"]) {
    expect(await probeWindowsTuiHealth(identity, async () => reason)).toEqual({ ok: reason === "running", reason });
  }
  for (const reason of ["unknown", "", "True", "warning\nrunning"]) {
    expect(await probeWindowsTuiHealth(identity, async () => reason)).toBeUndefined();
  }
  expect(await probeWindowsTuiHealth(identity, async () => { throw new Error("access denied"); })).toBeUndefined();
});

test("native unknown clears stale healthy evidence without degrading AppServer; real auth remains", async () => {
  let evidence: any = { ok: true, reason: "running" };
  const auth = new ModelAuthTracker();
  auth.noteError("refresh token revoked");
  const monitor = createCodexHealthMonitor({ appServerUrl: () => "ws://127.0.0.1:9000", modelAuth: auth,
    probeAppServer: async () => ({ ok: true, rtt_ms: 1, last_error: null }), probeNativeTui: async () => evidence });
  expect((await monitor.tick()).tui?.ok).toBe(true);
  evidence = undefined;
  const unknown = await monitor.tick();
  expect(unknown.tui).toBeUndefined();
  expect(unknown.app_server?.ok).toBe(true);
  expect(unknown.model_auth).toBe("revoked");
  evidence = { ok: false, reason: "pane-dead" };
  expect((await monitor.tick()).tui?.ok).toBe(false);
});

test("first attested native failure reports immediately", async () => {
  const reports: any[] = [];
  const monitor = createCodexHealthMonitor({ appServerUrl: () => undefined, modelAuth: new ModelAuthTracker(),
    probeAppServer: async () => { throw new Error("unused"); }, probeNativeTui: async () => ({ ok: false, reason: "pane-dead" }),
    onChange: (r) => reports.push(r) });
  await monitor.tick();
  expect(reports).toHaveLength(1);
  expect(reports[0].tui.reason).toBe("pane-dead");
});

/**
 * #1285 — the fixture's birth query is a PowerShell spawn, and on a loaded Windows
 * runner it can take longer than the 10 s it used to allow (2026-10-14: `ETIMEDOUT`
 * in `spawnSync powershell.exe`, and 2026-10-24: the same test failed after 10.35 s).
 *
 * This is deliberately NOT "just raise the timeout":
 *   * it measures the wall time and prints it when the query is slow, so the cost is
 *     visible instead of silently eating the test's budget;
 *   * it retries **once** on timeout, because a cold PowerShell start is the most
 *     likely cause and a second attempt distinguishes "slow start" from "hung";
 *   * if both attempts fail it throws an error naming the label, both elapsed times
 *     and the underlying error — a fixture failure that says what happened instead of
 *     a bare `ETIMEDOUT`.
 *
 * The assertions around the probe are unchanged; only the fixture's own query does.
 */
function birthTicks(pid: number, label: string): string {
  const script = `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`;
  const attempts: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30_000 }).trim();
      const elapsed = Date.now() - started;
      if (elapsed > 5_000) console.warn(`[#1285] ${label} birth query took ${elapsed}ms (attempt ${attempt})`);
      return out;
    } catch (err: any) {
      const elapsed = Date.now() - started;
      attempts.push(`attempt ${attempt}: ${elapsed}ms, ${err?.code ?? err?.name ?? "error"}${err?.signal ? `, signal ${err.signal}` : ""}`);
      if (attempt === 1) console.warn(`[#1285] ${label} birth query failed once (${elapsed}ms) — retrying`);
    }
  }
  throw new Error(`[#1285] ${label} birth query failed after 2 attempts — ${attempts.join(" | ")}`);
}

describe.skipIf(process.platform !== "win32")("native Windows generation and TCP ownership", () => {
  test("owned connection, foreign client, different remote, birth mismatch, then exit", async () => {
    const server = createServer((socket) => socket.on("error", () => {}));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as any).port;
    const child = spawn(process.execPath, ["-e", `const net=require('node:net');const socket=net.connect(${port},'127.0.0.1',()=>console.log('READY'));setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "pipe"] });
    const sibling = spawn(process.execPath, ["-e", "console.log('READY');setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await Promise.all([once(child.stdout!, "data"), once(sibling.stdout!, "data")]);
      // #1321 — opt-in diagnostics only; the fixture value and every assertion
      // below are unchanged whether or not they are enabled.
      const diag = windowsTuiDiagnosticsEnabled();
      let capturedBirth = "";
      const birthQuery = () => {
        capturedBirth = birthTicks(child.pid!, "child");
        return capturedBirth;
      };
      // Exactly one PowerShell invocation either way: the diagnostics call the
      // same query and report its duration/validity, and the probe receives the
      // identical value it would have received without diagnostics.
      const creationDate = diag ? (measureFixtureBirthQuery(birthQuery), capturedBirth) : birthQuery();
      const live = { ...identity, pid: child.pid!, creationDate, remote: `ws://127.0.0.1:${port}` };
      if (diag) console.error(`[diag-1321] ${describePreCheck(live)}`);
      const run = diag ? diagnosingRunPowerShell(runPowerShell) : undefined;
      // #1321 follow-up: the rich diagnostics above are opt-in (a repository
      // Variable), so a CI failure used to leave only "+ Received + 1" — the
      // received object truncated out of the diff. Print the probe result and the
      // pre-check state **when it is not what we expect**, unconditionally. This
      // adds output only on failure and changes no assertion.
      const probed = await probeWindowsTuiHealth(live, run);
      if (!(probed.ok === true && probed.reason === "running")) {
        console.error(`[diag-1321] probe=${JSON.stringify(probed)} ${describePreCheck(live)}`);
      }
      expect(probed).toEqual({ ok: true, reason: "running" });
      let capturedSiblingBirth = "";
      const siblingQuery = () => {
        capturedSiblingBirth = birthTicks(sibling.pid!, "sibling");
        return capturedSiblingBirth;
      };
      const siblingBirth = diag ? (measureFixtureBirthQuery(siblingQuery), capturedSiblingBirth) : siblingQuery();
      // A live sibling has no owned connection even while this foreign client is connected.
      expect(await probeWindowsTuiHealth({ ...live, pid: sibling.pid!, creationDate: siblingBirth }, run)).toEqual({ ok: false, reason: "session-missing" });
      expect(await probeWindowsTuiHealth({ ...live, remote: `ws://127.0.0.1:${port === 65535 ? port - 1 : port + 1}` }, run)).toEqual({ ok: false, reason: "session-missing" });
      expect(await probeWindowsTuiHealth({ ...live, creationDate: "1" }, run)).toEqual({ ok: false, reason: "pane-dead" });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      expect(await probeWindowsTuiHealth(live, run)).toEqual({ ok: false, reason: "pane-dead" });
    } finally { child.kill(); sibling.kill(); server.close(); }
  }, 90_000);
});
