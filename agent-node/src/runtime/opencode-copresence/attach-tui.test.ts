import { execFileSync, spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";
import {
  ATTACH_GEN_ENV,
  ATTACH_PLACEHOLDER_MARKER,
  attachRecordPath,
  paneIsPlaceholder,
  previousAttachRecordPath,
  readAttachRecord,
  readStartTicks,
  relaunchPreviousAttach,
  renderAttachRecordShell,
  stopRecordedAttach,
  type TmuxRunner,
} from "./attach-tui";

function tmuxAvailable(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}
const tmuxOnly = process.platform === "linux" && tmuxAvailable() ? test : test.skip;
const noTmux: TmuxRunner = () => { throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }); };


const linuxOnly = process.platform === "linux" ? test : test.skip;

function tmp() {
  const root = mkdtempSync(join(tmpdir(), "opencode-attach-tui-"));
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function spawnSleeper() {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 50));
  const startTicks = readStartTicks(child.pid!);
  if (startTicks === undefined) throw new Error("could not read sleeper start ticks");
  const identity = { pid: child.pid!, startTicks };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, identity, exited };
}

describe("#1957 attach TUI record / stop / relaunch", () => {
  linuxOnly("the launcher records its own pid, start ticks and tmux pane before exec, and exports the generation marker", () => {
    const t = tmp();
    try {
      const recordPath = attachRecordPath(t.root);
      const script = ["#!/usr/bin/env bash", "set -eu", ...renderAttachRecordShell(recordPath, "ses_gen1"), "exec sleep 30", ""].join("\n");
      const scriptPath = join(t.root, "launcher.sh");
      writeFileSync(scriptPath, script, { mode: 0o700 });
      expect(script).toContain(`export ${ATTACH_GEN_ENV}='ses_gen1'`);
      expect(script).toContain("/proc/$$/stat");
      const child = spawn("bash", [scriptPath], { stdio: "ignore", env: { ...process.env, TMUX_PANE: "%42" } });
      try {
        // the record is written by the launcher itself before exec
        const deadline = Date.now() + 3_000;
        while (!existsSync(recordPath) && Date.now() < deadline) Bun.sleepSync(20);
        const record = readAttachRecord(recordPath);
        expect(record?.pid).toBe(child.pid);
        expect(record?.pane).toBe("%42");
        expect(record?.gen).toBe("ses_gen1");
        // same reader on both sides: the launcher's $$ read and the runtime's live read
        expect(record?.startTicks).toBe(readStartTicks(child.pid!));
      } finally {
        child.kill("SIGKILL");
      }
    } finally { t.close(); }
  });

  linuxOnly("close-time stop signals exactly the recorded pid when start ticks match, and keeps the pane for relaunch", async () => {
    const t = tmp();
    const s = await spawnSleeper();
    try {
      writeFileSync(attachRecordPath(t.root), JSON.stringify({ pid: s.identity.pid, startTicks: s.identity.startTicks, pane: "%7", gen: "ses_a" }));
      const logs: string[] = [];
      // restart without tmux available → SIGTERM fallback, pane kept in .prev
      const out = stopRecordedAttach(t.root, { restart: true, tmux: noTmux, log: (m) => logs.push(m), warn: (m) => logs.push("WARN " + m) });
      expect(out.action).toBe("signalled");
      const exit = await s.exited;
      expect(exit.signal).toBe("SIGTERM");
      expect(existsSync(attachRecordPath(t.root))).toBe(false);
      expect(readAttachRecord(previousAttachRecordPath(t.root))?.pane).toBe("%7");
      expect(logs.join("\n")).toContain(`stopped attach TUI pid ${s.identity.pid}`);
    } finally { try { s.child.kill("SIGKILL"); } catch {} t.close(); }
  });

  linuxOnly("a record whose start ticks differ from the live process is never signalled", async () => {
    const t = tmp();
    const s = await spawnSleeper();
    try {
      writeFileSync(attachRecordPath(t.root), JSON.stringify({ pid: s.identity.pid, startTicks: String(Number(s.identity.startTicks) + 1), pane: "", gen: "ses_a" }));
      const warns: string[] = [];
      const out = stopRecordedAttach(t.root, { restart: true, tmux: noTmux, warn: (m) => warns.push(m) });
      expect(out.action).toBe("skipped");
      expect(warns.join("\n")).toContain("pid was reused");
      await new Promise((r) => setTimeout(r, 100));
      expect(s.child.exitCode).toBeNull();
      expect(s.child.signalCode).toBeNull();
    } finally { try { s.child.kill("SIGKILL"); } catch {} t.close(); }
  });

  test("no record → nothing signalled, no relaunch", () => {
    const t = tmp();
    try {
      const out = stopRecordedAttach(t.root, {});
      expect(out.action).toBe("skipped");
      expect(relaunchPreviousAttach(t.root, join(t.root, "opencode-attach.sh"), {})).toBeUndefined();
    } finally { t.close(); }
  });

  test("relaunch respawns the regenerated launcher in the recorded tmux pane", () => {
    const t = tmp();
    try {
      writeFileSync(previousAttachRecordPath(t.root), JSON.stringify({ pid: 4242, startTicks: "1", pane: "%7", gen: "ses_a" }));
      const calls: Array<[string, string]> = [];
      const out = relaunchPreviousAttach(t.root, "/x/opencode-attach.sh", { respawn: (pane, script) => { calls.push([pane, script]); } });
      expect(out).toEqual({ action: "respawned", pane: "%7" });
      expect(calls).toEqual([["%7", "/x/opencode-attach.sh"]]);
      expect(existsSync(previousAttachRecordPath(t.root))).toBe(false);
    } finally { t.close(); }
  });

  test("without tmux (or a dead pane) it only logs the relaunch command", () => {
    const t = tmp();
    try {
      writeFileSync(previousAttachRecordPath(t.root), JSON.stringify({ pid: 4242, startTicks: "1", pane: "%7", gen: "ses_a" }));
      const warns: string[] = [];
      const out = relaunchPreviousAttach(t.root, "/x/opencode-attach.sh", {
        warn: (m) => warns.push(m),
        respawn: () => { throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" }); },
      });
      expect(out?.action).toBe("manual");
      expect(warns.join("\n")).toContain("previous attach TUI (pid 4242) stopped; relaunch: /x/opencode-attach.sh");
      expect(warns.join("\n")).toContain("tmux not found");
      // no pane recorded → plain hint, no respawn attempted
      writeFileSync(previousAttachRecordPath(t.root), JSON.stringify({ pid: 4343, startTicks: "1", pane: "", gen: "ses_b" }));
      const logs: string[] = [];
      let attempted = false;
      const out2 = relaunchPreviousAttach(t.root, "/x/opencode-attach.sh", { log: (m) => logs.push(m), respawn: () => { attempted = true; } });
      expect(out2?.action).toBe("manual");
      expect(attempted).toBe(false);
      expect(logs.join("\n")).toContain("pid 4343) stopped; relaunch: /x/opencode-attach.sh");
    } finally { t.close(); }
  });

  linuxOnly("a plain stop (not a restart) SIGTERMs the TUI and leaves no .prev record behind", async () => {
    const t = tmp();
    const s = await spawnSleeper();
    try {
      writeFileSync(attachRecordPath(t.root), JSON.stringify({ pid: s.identity.pid, startTicks: s.identity.startTicks, pane: "%7", gen: "ses_a" }));
      const out = stopRecordedAttach(t.root, { restart: false, tmux: noTmux });
      expect(out.action).toBe("signalled");
      expect((await s.exited).signal).toBe("SIGTERM");
      expect(existsSync(previousAttachRecordPath(t.root))).toBe(false);
    } finally { try { s.child.kill("SIGKILL"); } catch {} t.close(); }
  });

  tmuxOnly("restart keeps the tmux pane alive with a placeholder, and the ready-time relaunch respawns the new launcher into it", async () => {
    const t = tmp();
    const sock = `anet-test-${process.pid}-${Date.now()}`;
    const tmux: TmuxRunner = (args) => execFileSync("tmux", ["-L", sock, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    try {
      // a launcher that records itself (as the real one does) then becomes the attach process
      const recordPath = attachRecordPath(t.root);
      const oldLauncher = join(t.root, "old-launcher.sh");
      writeFileSync(oldLauncher, ["#!/usr/bin/env bash", "set -eu", ...renderAttachRecordShell(recordPath, "ses_old"), "exec sleep 300", ""].join("\n"), { mode: 0o700 });
      tmux(["new-session", "-d", "-s", "node-a", "-x", "80", "-y", "24", `bash ${JSON.stringify(oldLauncher)}`]);
      const deadline = Date.now() + 3_000;
      while (!existsSync(recordPath) && Date.now() < deadline) Bun.sleepSync(20);
      const record = readAttachRecord(recordPath)!;
      expect(record.pane).toMatch(/^%\d+$/);
      expect(tmux(["display-message", "-p", "-t", record.pane, "#{pane_pid}"]).trim()).toBe(String(record.pid));

      // close() on a config restart
      const logs: string[] = [];
      const out = stopRecordedAttach(t.root, { restart: true, tmux, log: (m) => logs.push(m) });
      expect(out.action).toBe("placeholder");
      // the pane still exists and shows the placeholder; the old attach pid is gone
      expect(tmux(["display-message", "-p", "-t", record.pane, "#{pane_current_command}"]).trim()).toBe("sleep");
      expect(paneIsPlaceholder(tmux, record.pane)).toBe(true);
      expect(tmux(["display-message", "-p", "-t", record.pane, "#{pane_pid}"]).trim()).not.toBe(String(record.pid));
      expect(logs.join("\n")).toContain(`replaced attach TUI pid ${record.pid} in tmux pane ${record.pane}`);
      const shown = tmux(["capture-pane", "-p", "-t", record.pane]);
      expect(shown).toContain(ATTACH_PLACEHOLDER_MARKER);

      // the next generation is ready: the regenerated launcher goes back into that pane
      const newLauncher = join(t.root, "opencode-attach.sh");
      writeFileSync(newLauncher, "#!/usr/bin/env bash\nexec tail -f /dev/null\n", { mode: 0o700 });
      const relaunch = relaunchPreviousAttach(t.root, newLauncher, { tmux, log: (m) => logs.push(m) });
      expect(relaunch).toEqual({ action: "respawned", pane: record.pane });
      const until = Date.now() + 3_000;
      let current = "";
      while (Date.now() < until) { current = tmux(["display-message", "-p", "-t", record.pane, "#{pane_current_command}"]).trim(); if (current === "tail") break; Bun.sleepSync(50); }
      expect(current).toBe("tail");
      expect(paneIsPlaceholder(tmux, record.pane)).toBe(false);

      // a later plain stop of a node whose restart never reached ready removes a leftover placeholder pane
      writeFileSync(previousAttachRecordPath(t.root), JSON.stringify({ pid: 4242, startTicks: "1", pane: record.pane, gen: "x" }));
      tmux(["respawn-pane", "-k", "-t", record.pane, `bash -c 'printf "%s\\n" "${ATTACH_PLACEHOLDER_MARKER}…"; exec sleep 3600'`]);
      expect(paneIsPlaceholder(tmux, record.pane)).toBe(true);
      stopRecordedAttach(t.root, { restart: false, tmux });
      let gone = false;
      try { tmux(["display-message", "-p", "-t", record.pane, "#{pane_id}"]); } catch { gone = true; }
      expect(gone).toBe(true);
    } finally {
      try { execFileSync("tmux", ["-L", sock, "kill-server"], { stdio: "ignore" }); } catch {}
      t.close();
    }
  }, 20_000);
});
