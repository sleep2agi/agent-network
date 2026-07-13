import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertGrokCliFeatures, assertGrokCliVersion, buildGrokCliArgs, normalizeGrokCliTools, runGrokCliTurn } from "./grok-build-cli";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeGrok(source: string): { root: string; binary: string } {
  const root = mkdtempSync(join(tmpdir(), "grok-cli-runtime-"));
  roots.push(root);
  const binary = join(root, "grok");
  writeFileSync(binary, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(binary, 0o755);
  return { root, binary };
}

describe("buildGrokCliArgs", () => {
  it("rejects an older Grok CLI before it can ignore required safety flags", () => {
    expect(() => assertGrokCliFeatures("--cwd --resume --tools")).toThrow("--prompt-file");
    expect(() => assertGrokCliFeatures([
      "--prompt-file", "streaming-json", "--cwd", "--resume", "--tools",
      "--disallowed-tools", "--no-subagents", "--deny", "--always-approve", "--sandbox",
    ].join(" "))).not.toThrow();
    expect(() => assertGrokCliVersion("grok 0.2.92")).toThrow("verified minimum");
    expect(() => assertGrokCliVersion("grok 0.2.93")).not.toThrow();
  });

  it("uses streaming headless mode and resumes an existing session", () => {
    const args = buildGrokCliArgs({
      prompt: "hello",
      cwd: "/work",
      sessionId: "session-1",
      model: "grok-4.5",
      maxTurns: 7,
      alwaysApprove: true,
    }, "/private/prompt.txt");
    expect(args).toEqual([
      "--prompt-file", "/private/prompt.txt",
      "--output-format", "streaming-json",
      "--cwd", "/work",
      "--resume", "session-1",
      "--model", "grok-4.5",
      "--max-turns", "7",
      "--sandbox", "workspace",
      "--always-approve",
      "--disallowed-tools", "search_tool,use_tool",
      "--deny", "MCPTool",
    ]);
    expect(args).not.toContain("--session-id");
  });

  it("fails closed instead of auto-approving when permission bypass is disabled", () => {
    const args = buildGrokCliArgs({ prompt: "hello", cwd: "/work" }, "/private/prompt.txt");
    expect(args).toContain("read_file,grep,list_dir,web_search,web_fetch");
    expect(args.filter((arg) => arg === "--deny")).toHaveLength(4);
    expect(args).toContain("--no-subagents");
    expect(args).toContain("read-only");
    expect(args).not.toContain("--always-approve");
    expect(args).not.toContain("dontAsk");
    expect(args).not.toContain("--resume");
  });

  it("maps an explicit node tool allowlist and keeps MCP unavailable", () => {
    const args = buildGrokCliArgs({
      prompt: "hello",
      cwd: "/work",
      alwaysApprove: true,
      toolAllowlist: ["Read", "Bash", "Edit", "Grep", "Read"],
    }, "/private/prompt.txt");
    expect(args).toContain("read_file,run_terminal_cmd,search_replace,grep");
    expect(args).toContain("--always-approve");
    expect(args).toContain("workspace");
    expect(args).toContain("search_tool,use_tool");
    expect(args).toContain("MCPTool");
  });

  it("intersects explicit tools with the read-only set when auto-approval is off", () => {
    const args = buildGrokCliArgs({
      prompt: "hello",
      cwd: "/work",
      toolAllowlist: ["Read", "Bash", "WebFetch"],
    }, "/private/prompt.txt");
    expect(args).toContain("read_file,web_fetch");
    expect(args).not.toContain("run_terminal_cmd");
  });

  it("rejects unknown node tool names instead of silently widening access", () => {
    expect(() => normalizeGrokCliTools(["Read", "MadeUpTool"])).toThrow("MadeUpTool");
  });

  it("rejects an explicit empty tool allowlist instead of widening to all tools", () => {
    expect(() => buildGrokCliArgs({
      prompt: "hello",
      cwd: "/work",
      alwaysApprove: true,
      toolAllowlist: [],
    }, "/private/prompt.txt")).toThrow("allowlist is empty");
  });

  it("denies model reads of runtime credential and node-state paths", () => {
    const args = buildGrokCliArgs({
      prompt: "hello",
      cwd: "/work",
      protectedPaths: ["/state/grok-home", "/work/.anet"],
    }, "/private/prompt.txt");
    expect(args).toContain("Read(/state/grok-home/**)");
    expect(args).toContain("Grep(/work/.anet/**)");
  });
});

describe("runGrokCliTurn", () => {
  it("reduces streaming JSON text and persists the end-event session", async () => {
    const { root, binary } = fakeGrok(`
      process.stdout.write(JSON.stringify({type:"thought",data:"hidden"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"text",data:"HELLO "}) + "\\n");
      process.stdout.write(JSON.stringify({type:"text",data:"WORLD"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"end",stopReason:"EndTurn",sessionId:"session-new",requestId:"req-1"}) + "\\n");
    `);
    const seen: string[] = [];
    const result = await runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 1_000,
      onEvent: (event) => seen.push(String(event.type)),
    });
    expect(result.replyText).toBe("HELLO WORLD");
    expect(result.sessionId).toBe("session-new");
    expect(result.stopReason).toBe("EndTurn");
    expect(result.requestId).toBe("req-1");
    expect(seen).toEqual(["thought", "text", "text", "end"]);
  });

  it("spawns with exactly the projected environment and no ambient credentials", async () => {
    const { root, binary } = fakeGrok(`
      process.stdout.write(JSON.stringify({type:"text",data:JSON.stringify(process.env)}) + "\\n");
      process.stdout.write(JSON.stringify({type:"end",stopReason:"EndTurn",sessionId:"session-env"}) + "\\n");
    `);
    const result = await runGrokCliTurn({
      prompt: "inspect env",
      cwd: root,
      binary,
      idleTimeoutMs: 1_000,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/runtime/home",
        GROK_HOME: "/runtime/home",
        GROK_AUTH_PATH: "/runtime/home/auth.json",
        GROK_CLAUDE_MCPS_ENABLED: "false",
        GROK_CURSOR_MCPS_ENABLED: "false",
        GROK_CLAUDE_HOOKS_ENABLED: "false",
        GROK_CURSOR_HOOKS_ENABLED: "false",
        GROK_FOLDER_TRUST: "1",
        DATABASE_URL: "postgres://private",
        AWS_ACCESS_KEY_ID: "AKIA_PRIVATE",
        AWS_SECRET_ACCESS_KEY: "aws-private",
        ARBITRARY_TOKEN: "token-private",
        ARBITRARY_SECRET: "secret-private",
        ARBITRARY_KEY: "key-private",
        NODE_TOKEN_ALIAS: "ntok_private",
        USER_TOKEN_ALIAS: "utok_private",
      },
    });
    expect(JSON.parse(result.replyText)).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/runtime/home",
      GROK_HOME: "/runtime/home",
      GROK_AUTH_PATH: "/runtime/home/auth.json",
      GROK_CLAUDE_MCPS_ENABLED: "false",
      GROK_CURSOR_MCPS_ENABLED: "false",
      GROK_CLAUDE_HOOKS_ENABLED: "false",
      GROK_CURSOR_HOOKS_ENABLED: "false",
      GROK_FOLDER_TRUST: "1",
    });
  });

  it("surfaces non-zero exits and stderr", async () => {
    const { root, binary } = fakeGrok(`
      process.stderr.write("auth failed\\n");
      process.exit(17);
    `);
    await expect(runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 1_000,
    })).rejects.toThrow("code 17");
  });

  it("fails fast when headless Grok asks for an interactive login", async () => {
    const { root, binary } = fakeGrok(`
      process.stderr.write("You are not authenticated. Run grok login.\\n");
      setInterval(() => {}, 10_000);
    `);
    const started = Date.now();
    await expect(runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 10_000,
    })).rejects.toThrow("run `grok login`");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects cancelled turns", async () => {
    const { root, binary } = fakeGrok(`
      process.stdout.write(JSON.stringify({type:"end",stopReason:"Cancelled",sessionId:"session-cancelled"}) + "\\n");
    `);
    await expect(runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 1_000,
    })).rejects.toThrow("cancelled");
  });

  it("rejects a formal error event even if the process exits zero", async () => {
    const { root, binary } = fakeGrok(`
      process.stdout.write(JSON.stringify({type:"error",message:"session exploded"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"end",stopReason:"EndTurn",sessionId:"session-error"}) + "\\n");
    `);
    await expect(runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 1_000,
    })).rejects.toThrow("session exploded");
  });

  it("rejects max-turn truncation instead of reporting a partial reply as success", async () => {
    const { root, binary } = fakeGrok(`
      process.stdout.write(JSON.stringify({type:"text",data:"partial"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"max_turns_reached"}) + "\\n");
      process.stdout.write(JSON.stringify({type:"end",stopReason:"EndTurn",sessionId:"session-max"}) + "\\n");
    `);
    await expect(runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 1_000,
    })).rejects.toThrow("maximum turn limit");
  });

  it("terminates the process group when the caller aborts", async () => {
    const { root, binary } = fakeGrok(`setInterval(() => {}, 10_000);`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await expect(runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 10_000,
      signal: controller.signal,
    })).rejects.toThrow("aborted");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("kills a silent child after the idle timeout", async () => {
    const { root, binary } = fakeGrok(`setInterval(() => {}, 10_000);`);
    const started = Date.now();
    await expect(runGrokCliTurn({
      prompt: "hello",
      cwd: root,
      binary,
      idleTimeoutMs: 30,
    })).rejects.toThrow("idle for 30ms");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
