import { describe, expect, test } from "bun:test";
import { alreadyRunningMessage, isAgentNodeCommand, runningNodePid } from "./node-running-guard.js";

describe("#1130 node start refuses an alias that is already running", () => {
  test("recognises agent-node / anet node start command lines, not arbitrary reused pids", () => {
    expect(isAgentNodeCommand("node /home/u/.nvm/versions/node/v20/bin/agent-node --config x/config.json --alias 甲")).toBe(true);
    expect(isAgentNodeCommand("/usr/bin/node /x/node_modules/@sleep2agi/agent-node/dist/cli.js --config y")).toBe(true);
    expect(isAgentNodeCommand("node /usr/bin/anet node start 甲")).toBe(true);
    expect(isAgentNodeCommand("bash -lc sleep 3600")).toBe(false);
    expect(isAgentNodeCommand("")).toBe(false);
  });
  test("pid file → alive → agent-node command ⇒ running", () => {
    expect(runningNodePid({ pidFileContent: "4242\n", isAlive: () => true, commandOf: () => "node agent-node --config c" })).toBe(4242);
  });
  test("dead pid, garbage pid file, or reused pid ⇒ not running", () => {
    expect(runningNodePid({ pidFileContent: "4242", isAlive: () => false, commandOf: () => "node agent-node" })).toBeNull();
    expect(runningNodePid({ pidFileContent: "abc", isAlive: () => true, commandOf: () => "node agent-node" })).toBeNull();
    expect(runningNodePid({ pidFileContent: null, isAlive: () => true, commandOf: () => "node agent-node" })).toBeNull();
    expect(runningNodePid({ pidFileContent: "4242", isAlive: () => true, commandOf: () => "/usr/bin/vim notes.txt" })).toBeNull();
    expect(runningNodePid({ pidFileContent: "1", isAlive: () => true, commandOf: () => "init" })).toBeNull();
  });
  test("unreadable command line fails closed (treated as running)", () => {
    expect(runningNodePid({ pidFileContent: "4242", isAlive: () => true, commandOf: () => null })).toBe(4242);
  });
  test("message names the alias, the pid, the consequence and the two ways out", () => {
    const m = alreadyRunningMessage("甲", 4242).join("\n");
    expect(m).toContain('"甲"'); expect(m).toContain("4242"); expect(m).toContain("#1130");
    expect(m).toContain("anet node restart '甲'"); expect(m).toContain("anet node stop '甲'");
  });
});
