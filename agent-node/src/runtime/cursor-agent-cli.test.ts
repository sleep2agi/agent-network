import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCursorAgentArgs,
  cursorAgentChildEnv,
  parseCursorAgentJson,
  resolveCursorAgentBinary,
  killActiveCursorAgentTurn,
  runCursorAgentTurn,
} from "./cursor-agent-cli";

describe("cursor-agent binary resolution", () => {
  test("prefers cursor-agent over a generic agent name", () => {
    const seen: string[] = [];
    const resolved = resolveCursorAgentBinary({
      env: {},
      lookup: (name) => {
        seen.push(name);
        return name === "cursor-agent" || name === "agent";
      },
    });
    expect(resolved).toEqual({ binary: "cursor-agent", source: "cursor-agent" });
    expect(seen).toEqual(["cursor-agent"]);
  });

  test("falls back to agent when cursor-agent is absent", () => {
    const resolved = resolveCursorAgentBinary({
      env: {},
      lookup: (name) => name === "agent",
    });
    expect(resolved).toEqual({ binary: "agent", source: "agent" });
  });

  test("CURSOR_AGENT_BIN wins and a missing file is refused without echoing the path", () => {
    expect(resolveCursorAgentBinary({
      env: { CURSOR_AGENT_BIN: "cursor-agent-test-bin" },
      lookup: (name) => name === "cursor-agent-test-bin",
    })).toEqual({ binary: "cursor-agent-test-bin", source: "CURSOR_AGENT_BIN" });

    expect(() => resolveCursorAgentBinary({
      env: { CURSOR_AGENT_BIN: "/tmp/does-not-exist-cursor-agent" },
      lookup: () => false,
    })).toThrow(/CURSOR_AGENT_BIN is set but is not executable/);
  });

  test("names both PATH candidates when nothing is installed", () => {
    expect(() => resolveCursorAgentBinary({ env: {}, lookup: () => false }))
      .toThrow(/cursor-agent.*agent/);
  });
});

describe("cursor-agent turn contract", () => {
  test("print-mode args trust the workspace, force commands, and pass the prompt after --", () => {
    expect(buildCursorAgentArgs({
      prompt: "reply with pong",
      cwd: "/work/node",
      model: "composer-2.5",
      sessionId: "sess-1",
    })).toEqual([
      "-p", "--output-format", "json", "--trust", "--force",
      "--workspace", "/work/node",
      "--model", "composer-2.5",
      "--resume", "sess-1",
      "--", "reply with pong",
    ]);
  });

  test("child env keeps the Cursor login env and drops Hub credentials", () => {
    const env = cursorAgentChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      CURSOR_API_KEY: "cursor_test_key",
      COMMHUB_TOKEN: "ntok_test_only",
      COMMHUB_URL: "http://127.0.0.1:9200",
      COMMHUB_NODE_ID: "n_test",
    });
    expect(env.CURSOR_API_KEY).toBe("cursor_test_key");
    expect(env.HOME).toBe("/home/user");
    expect(env.COMMHUB_TOKEN).toBeUndefined();
    expect(env.COMMHUB_URL).toBeUndefined();
    expect(env.COMMHUB_NODE_ID).toBeUndefined();
  });

  test("json result text and session id are the reply", () => {
    const parsed = parseCursorAgentJson(`noise\n${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "pong",
      session_id: "sess-preview-1",
    })}\n`);
    expect(parsed).toEqual({ result: "pong", sessionId: "sess-preview-1" });
  });

  test("a failed or empty result is not a reply", () => {
    expect(() => parseCursorAgentJson(JSON.stringify({
      type: "result", subtype: "success", is_error: true, result: "nope",
    }))).toThrow(/not a successful result/);
    expect(() => parseCursorAgentJson(JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "  ",
    }))).toThrow(/empty result/);
  });
});

describe("cursor-agent smoke spawn", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-agent-smoke-"));
  const bin = join(root, "cursor-agent");
  const logFile = join(root, "invocations");
  const tokenFile = join(root, "token");
  const keyFile = join(root, "key");

  writeFileSync(bin, `#!/bin/sh
printf '%s\\0' "$@" >> ${JSON.stringify(logFile)}
printf '\\n---\\n' >> ${JSON.stringify(logFile)}
printf '%s' "$COMMHUB_TOKEN" > ${JSON.stringify(tokenFile)}
printf '%s' "$CURSOR_API_KEY" > ${JSON.stringify(keyFile)}
if printf '%s\\n' "$@" | grep -qx -- '--resume'; then
  echo 'unknown session' >&2
  exit 1
fi
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"sess-preview-1"}'
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  test("a fake local CLI returns the reply, strips the hub token, and retries a rejected session", async () => {
    const turn = await runCursorAgentTurn({
      binary: bin,
      prompt: "say pong",
      cwd: root,
      sessionId: "stale-session",
      env: cursorAgentChildEnv({
        PATH: process.env.PATH,
        HOME: "/home/user",
        CURSOR_API_KEY: "cursor_test_key",
        COMMHUB_TOKEN: "ntok_test_only",
      }),
      timeoutMs: 5_000,
    });
    expect(turn).toEqual({ result: "pong", sessionId: "sess-preview-1" });
    const log = readFileSync(logFile, "utf8").split("\n---\n").filter(Boolean);
    expect(log).toHaveLength(2);
    expect(log[0]).toContain("--resume");
    expect(log[0]).toContain("stale-session");
    expect(log[1]).toContain("--trust");
    expect(log[1]).toContain("--force");
    expect(log[1]).toContain("say pong");
    expect(log[1]).not.toContain("--resume");
    expect(readFileSync(tokenFile, "utf8")).toBe("");
    expect(readFileSync(keyFile, "utf8")).toBe("cursor_test_key");
  });

  test("timeout kills the turn instead of hanging the node", async () => {
    const sleeper = join(root, "sleep-agent");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    chmodSync(sleeper, 0o755);
    await expect(runCursorAgentTurn({
      binary: sleeper,
      prompt: "hang",
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 200,
    })).rejects.toThrow(/timed out/);
  });

  test("stop can kill the in-flight CLI without waiting out its timeout", async () => {
    const sleeper = join(root, "stop-agent");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    chmodSync(sleeper, 0o755);
    const pending = runCursorAgentTurn({
      binary: sleeper,
      prompt: "hang",
      cwd: root,
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 30_000,
    });
    const deadline = Date.now() + 2_000;
    let killed = false;
    while (Date.now() < deadline) {
      if (killActiveCursorAgentTurn()) {
        killed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(killed).toBe(true);
    await expect(pending).rejects.toThrow(/exited/);
    expect(killActiveCursorAgentTurn()).toBe(false);
  });
});
