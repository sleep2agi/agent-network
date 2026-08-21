import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pty from "../../agent-network/node_modules/node-pty/lib/index.js";

if (process.platform !== "win32") throw new Error("windows-e2e must run on Windows");
const repo = resolve(import.meta.dirname, "../..");
const cli = join(repo, "agent-network", "bin", "cli.ts");
const root = join(process.env.RUNNER_TEMP, "anet-test751-e2e");
const project = join(root, "project");
const bin = join(root, "bin");
const userHome = join(root, "home");
const rpcLog = join(root, "rpc.log");
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(join(userHome, ".anet"), { recursive: true });
writeFileSync(join(userHome, ".anet", "config.json"), JSON.stringify({ hub: "http://127.0.0.1:19351" }));
writeFileSync(join(bin, "codex.cmd"), `@echo off\r\nbun "${join(import.meta.dirname, "fake-codex.mjs")}" %*\r\n`);
writeFileSync(join(bin, "agent-node.cmd"), `@echo off\r\nbun "${join(import.meta.dirname, "fake-agent-node.mjs")}" %*\r\n`);
const env = {
  ...process.env, HOME: userHome, USERPROFILE: userHome,
  PATH: `${bin};${process.env.PATH}`, ANET_TEST751_RPC_LOG: rpcLog,
};

function command(args, stdin = "") {
  const result = Bun.spawnSync([process.execPath, cli, ...args], { cwd: project, env, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`command failed (${args.join(" ")}):\n${output}`);
  return output;
}

function terminal(args, onData, timeoutMs = 45_000) {
  return new Promise((resolvePromise, reject) => {
    const child = pty.spawn(process.execPath, [cli, ...args], { cwd: project, env, cols: 120, rows: 40 });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`PTY timeout: ${args.join(" ")}\n${output}`)); }, timeoutMs);
    child.onData((data) => { output += data; onData?.(child, output); });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0) reject(new Error(`PTY failed (${exitCode}): ${args.join(" ")}\n${output}`));
      else resolvePromise(output);
    });
  });
}

command(["register", "--username", "t751", "--password", "pass123456"]);
command(["login", "--username", "t751", "--password", "pass123456"]);
let selected = false;
const pickerOutput = await terminal(["node", "create", "windows-picker", "--hub", "http://127.0.0.1:19351"], (child, output) => {
  if (!selected && output.includes("选择 runtime:")) {
    selected = true;
    child.write("\x1b[B\x1b[B\x1b[B\r");
  }
});
if (!pickerOutput.includes("Codex 共存 TUI")) throw new Error("interactive picker did not display Codex co-presence");
const configPath = join(project, ".anet", "nodes", "windows-picker", "config.json");
const firstConfig = JSON.parse(readFileSync(configPath, "utf8"));
if (firstConfig.runtime !== "codex-app-server" || firstConfig.codexCopresence !== true) {
  throw new Error(`picker persisted wrong mode: ${JSON.stringify(firstConfig)}`);
}
const codexHome = join(project, ".anet", "nodes", "windows-picker", "codex-home");
mkdirSync(codexHome, { recursive: true });
writeFileSync(join(codexHome, "auth.json"), "{}\n");

async function startAndStop(label) {
  const out = await terminal(["node", "start", "windows-picker", "--no-inherit-codex-home"], undefined, 60_000);
  if (!out.includes("FAKE_CODEX_TUI_RESUMED thread_windows_e2e")) throw new Error(`${label}: TUI did not resume expected thread\n${out}`);
  const record = join(project, ".anet", "nodes", "windows-picker", "windows-copresence.json");
  if (!existsSync(record)) throw new Error(`${label}: managed process record missing`);
  command(["node", "stop", "windows-picker"]);
  if (existsSync(record)) throw new Error(`${label}: stop left managed process record`);
}

await startAndStop("first start");
await startAndStop("restart");
const calls = readFileSync(rpcLog, "utf8");
if ((calls.match(/^rpc:thread\/start$/gm) || []).length !== 1) throw new Error(`expected exactly one new thread:\n${calls}`);
if ((calls.match(/^rpc:thread\/resume:thread_windows_e2e$/gm) || []).length !== 1) throw new Error(`restart did not resume persisted thread:\n${calls}`);
if ((calls.match(/^tui:thread_windows_e2e$/gm) || []).length !== 2) throw new Error(`TUI did not adopt same thread twice:\n${calls}`);
console.log("PASS interactive create -> native start -> stop -> restart resumes same Codex thread");
