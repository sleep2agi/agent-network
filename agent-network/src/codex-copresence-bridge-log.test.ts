import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeLaunchFailureLines, codexBridgeTeeCommand, tailLines } from "./codex-copresence-bridge-log";

describe("#535 codex bridge launch log", () => {
  test("a dead bridge: tail + path, and no tmux attach to a session that is gone", () => {
    const logText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\nError: exact paired package identity validation failed\n\n";
    const lines = bridgeLaunchFailureLines({ bridgeAlive: false, attachCommand: "tmux attach -t '=x-桥'", logPath: "/n/codex-bridge.log", logText, waitedSeconds: 25, cleanupCommand: "anet node stop x" });
    const text = lines.join("\n");
    expect(text).toContain("bridge exited before attaching");
    expect(text).toContain("Last 20 line(s) of the bridge output (/n/codex-bridge.log)");
    expect(text).toContain("| Error: exact paired package identity validation failed");
    expect(text).toContain("| line 12");
    expect(text).not.toContain("| line 11");
    expect(text).not.toContain("tmux attach");
    expect(text).toContain("Full log: /n/codex-bridge.log");
  });
  test("a live but silent bridge keeps the attach hint and says the log is empty", () => {
    const text = bridgeLaunchFailureLines({ bridgeAlive: true, attachCommand: "tmux attach -t '=x-桥'", logPath: "/n/l", logText: "", waitedSeconds: 25, cleanupCommand: "c" }).join("\n");
    expect(text).toContain("within 25s (it is still running)");
    expect(text).toContain("wrote nothing to /n/l");
    expect(text).toContain("Debug:   tmux attach -t '=x-桥'");
  });
  test("tailLines drops trailing blanks and CRs", () => {
    expect(tailLines("a\r\nb  \n\n\n", 5)).toEqual(["a", "b"]);
  });
  test("the tee statement copies stdout+stderr to the log, whole lines up to the cap, without breaking the writer", () => {
    const d = mkdtempSync(join(tmpdir(), "t535-tee-"));
    try {
      const log = join(d, "b.log");
      const script = `${codexBridgeTeeCommand(`'${log}'`, 64)} && echo out-line && echo err-line >&2 && head -c 4096 /dev/zero | tr '\\0' 'x' && echo && echo still-alive`;
      const pane = join(d, "pane.txt");
      // `&&` chain: a writer broken by a closed pipe (SIGPIPE/EPIPE) would stop the chain and exit non-zero.
      const r = spawnSync("bash", ["-c", `(${script}) > '${pane}'`], { encoding: "utf8" });
      expect(r.status).toBe(0);
      const readOf = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !(readOf(log).includes("err-line") && readOf(pane).includes("still-alive"))) spawnSync("sleep", ["0.05"]);
      expect(readOf(pane)).toContain("still-alive"); // the pane keeps getting everything past the cap
      expect(readOf(log)).toBe("out-line\nerr-line\n");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("a line reaches the log while the writer is still running (a live bridge that never attached)", async () => {
    const d = mkdtempSync(join(tmpdir(), "t535-tee-live-"));
    try {
      const log = join(d, "b.log");
      const child = spawn("bash", ["-c", `${codexBridgeTeeCommand(`'${log}'`)} && echo first-line && sleep 3 && echo second-line`], { stdio: "ignore" });
      const read = () => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline && !read().includes("first-line")) await new Promise((r) => setTimeout(r, 50));
      const seen = read();
      child.kill("SIGKILL");
      expect(seen).toContain("first-line");
      expect(seen).not.toContain("second-line");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
