#!/usr/bin/env node
/**
 * E2E test for interactive anet create using node-pty
 */
import * as pty from "node-pty";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CLI = join(new URL(".", import.meta.url).pathname, "..", "dist", "bin", "cli.js");
let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(() => {
    console.log(`  ✅ ${name}`);
    passed++;
  }).catch(err => {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  });
}

function runInteractive(cwd, inputs, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const output = [];
    const proc = pty.spawn("node", [CLI, "create"], {
      cwd,
      cols: 120,
      rows: 30,
      env: { ...process.env, HOME: process.env.HOME },
    });

    let inputIndex = 0;
    let timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout. Output so far:\n${output.join("")}`));
    }, timeout);

    proc.onData(data => {
      output.push(data);
      const text = output.join("");
      // Feed next input when prompt appears
      while (inputIndex < inputs.length) {
        const [waitFor, send] = inputs[inputIndex];
        if (text.includes(waitFor)) {
          setTimeout(() => proc.write(send), 200);
          inputIndex++;
        } else {
          break;
        }
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({ exitCode, output: output.join("") });
    });
  });
}

console.log("\n=== Interactive anet create E2E Tests ===\n");

// Test 1: codex-sdk with params (non-interactive, just verify)
await test("codex-sdk param mode", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "anet-test-"));
  try {
    const proc = pty.spawn("node", [CLI, "create", "test-codex", "--runtime", "codex-sdk", "--model", "gpt-5.4"], {
      cwd: tmp, cols: 120, rows: 30,
      env: { ...process.env },
    });
    await new Promise((resolve) => {
      proc.onExit(resolve);
    });
    const config = JSON.parse(readFileSync(join(tmp, ".anet", "nodes", "test-codex", "config.json"), "utf-8"));
    if (config.runtime !== "codex-sdk") throw new Error(`runtime: ${config.runtime}`);
    if (config.model !== "gpt-5.4") throw new Error(`model: ${config.model}`);
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

// Test 2: invalid name
await test("invalid name rejected", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "anet-test-"));
  try {
    const proc = pty.spawn("node", [CLI, "create", "bad/name", "--runtime", "codex-sdk"], {
      cwd: tmp, cols: 120, rows: 30,
      env: { ...process.env },
    });
    const { exitCode } = await new Promise((resolve) => {
      proc.onExit(resolve);
    });
    if (exitCode === 0) throw new Error("should have failed");
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

// Test 3: interactive create codex-sdk
await test("interactive create codex-sdk", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "anet-test-"));
  try {
    const { exitCode, output } = await runInteractive(tmp, [
      ["Node name", "互动牛\r"],
      ["Select runtime", "\r"],            // 回车选默认
      ["Telegram", "n\r"],                 // 不加 telegram
    ], 15000);

    const configPath = join(tmp, ".anet", "nodes", "互动牛", "config.json");
    if (!existsSync(configPath)) throw new Error("config.json not created");
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

// Test 4: channel add after create
await test("channel add telegram", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "anet-test-"));
  try {
    // First create
    const p1 = pty.spawn("node", [CLI, "create", "tg-test", "--runtime", "codex-sdk", "--model", "gpt-5.4"], {
      cwd: tmp, cols: 120, rows: 30, env: { ...process.env },
    });
    await new Promise(r => p1.onExit(r));

    // Then add channel
    const p2 = pty.spawn("node", [CLI, "channel", "add", "telegram", "tg-test", "--bot-token", "123:test", "--allow", "999"], {
      cwd: tmp, cols: 120, rows: 30, env: { ...process.env },
    });
    await new Promise(r => p2.onExit(r));

    const envPath = join(tmp, ".anet", "nodes", "tg-test", "channels", "telegram", ".env");
    if (!existsSync(envPath)) throw new Error(".env not created");
    const config = JSON.parse(readFileSync(join(tmp, ".anet", "nodes", "tg-test", "config.json"), "utf-8"));
    if (!config.channels.includes("telegram")) throw new Error("telegram not in channels");
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
