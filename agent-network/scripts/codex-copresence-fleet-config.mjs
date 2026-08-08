#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function fail(message) { console.error(`REFUSE: ${message}`); process.exit(2); }
function parseArgs(argv) {
  const out = { mode: "plan" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected positional argument ${JSON.stringify(arg)}`);
    const key = arg.slice(2);
    if (!["mode", "config", "inventory-dir", "goals-root", "model", "workdir"].includes(key)) fail(`unknown option --${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) fail(`--${key} requires a value`);
    out[key] = value;
  }
  return out;
}
function safeJson(path) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { fail(`invalid JSON in ${path}: ${error.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${path} must contain a JSON object`);
  return parsed;
}
const permissionRepairs = [];
function recordPermissionRepair(path, mode, expectedMode) {
  if (!permissionRepairs.some((repair) => repair.path === path)) {
    permissionRepairs.push({ path, from: mode.toString(8), to: expectedMode.toString(8) });
  }
}
function assertOwnedRegular(path, expectedMode, label, allowMissing = false) {
  if (!existsSync(path)) { if (allowMissing) return; fail(`${label} is missing: ${path}`); }
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()) fail(`${label} must be a regular non-symlink file: ${path}`);
  if (st.uid !== process.getuid()) fail(`${label} owner uid ${st.uid} does not match euid ${process.getuid()}`);
  const mode = st.mode & 0o777;
  if (mode !== expectedMode) recordPermissionRepair(path, mode, expectedMode);
}
function assertOwnedDirectory(path, expectedMode, label) {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) fail(`${label} must be a non-symlink directory: ${path}`);
  if (st.uid !== process.getuid()) fail(`${label} owner uid ${st.uid} does not match euid ${process.getuid()}`);
  const mode = st.mode & 0o777;
  if (mode !== expectedMode) recordPermissionRepair(path, mode, expectedMode);
}

const args = parseArgs(process.argv);
if (!args.config || !args["inventory-dir"] || !args["goals-root"]) fail("--config, --inventory-dir and --goals-root are required");
if (!["plan", "prepare-permissions", "apply"].includes(args.mode)) fail("--mode must be plan, prepare-permissions, or apply");
const configPath = resolve(args.config);
const inventoryDir = resolve(args["inventory-dir"]);
const goalsRoot = resolve(args["goals-root"]);
const workdir = args.workdir ? resolve(args.workdir) : null;
if (!isAbsolute(configPath) || !isAbsolute(inventoryDir) || !isAbsolute(goalsRoot) || (workdir && !isAbsolute(workdir))) fail("all paths must be absolute");
assertOwnedRegular(configPath, 0o600, "config");
assertOwnedDirectory(inventoryDir, 0o700, "inventory directory");
if (workdir) assertOwnedDirectory(workdir, 0o700, "node workdir");

const cfg = safeJson(configPath);
const nodeId = String(cfg.node_id || "");
if (!/^n_[A-Za-z0-9]+$/.test(nodeId)) fail("config node_id is missing or unsafe");
if (!cfg.token || typeof cfg.token !== "string") fail("config token is missing");
if (cfg.runtime !== "codex-app-server") fail(`runtime must be codex-app-server, got ${JSON.stringify(cfg.runtime)}`);
const currentModel = typeof cfg.model === "string" ? cfg.model : typeof cfg.flags?.model === "string" ? cfg.flags.model : null;
const targetModel = args.model || currentModel;
if (!targetModel || !/^[A-Za-z0-9._-]+$/.test(targetModel)) fail("an explicit safe --model is required when config has no model");
if (cfg.model && cfg.flags?.model && cfg.model !== cfg.flags.model) fail("config model and flags.model conflict");
if (existsSync(goalsRoot)) assertOwnedDirectory(goalsRoot, 0o700, "goals root");

const desired = join(goalsRoot, nodeId, "goals.json");
const rel = relative(goalsRoot, desired);
if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail("derived goalsPath escapes the allowed root");
const inventory = [];
for (const name of readdirSync(inventoryDir)) {
  if (!name.endsWith("-bridge-config.json")) continue;
  const path = join(inventoryDir, name);
  assertOwnedRegular(path, 0o600, `inventory config ${name}`);
  const item = safeJson(path);
  const effective = item.goalsPath || item.flags?.goalsPath || join(dirname(path), "goals.json");
  inventory.push({ path, nodeId: String(item.node_id || ""), threadId: String(item.codexThreadId || ""), effective: resolve(effective) });
}
if (!inventory.some((entry) => entry.path === configPath)) fail("selected config is not in inventory directory");
const collisions = inventory.filter((entry) => entry.path !== configPath && entry.effective === desired);
if (collisions.length) fail(`desired goalsPath collides with ${collisions.map((x) => basename(x.path)).join(", ")}`);
const duplicateNodeIds = inventory.filter((entry) => entry.path !== configPath && entry.nodeId === nodeId);
if (duplicateNodeIds.length) fail(`node_id is duplicated by ${duplicateNodeIds.map((x) => basename(x.path)).join(", ")}`);
const threadId = String(cfg.codexThreadId || "");
if (!/^[A-Za-z0-9_-]{8,128}$/.test(threadId)) fail("config codexThreadId is missing or unsafe");
const duplicateThreads = inventory.filter((entry) => entry.path !== configPath && entry.threadId === threadId);
if (duplicateThreads.length) fail(`codexThreadId is duplicated by ${duplicateThreads.map((x) => basename(x.path)).join(", ")}`);
if (existsSync(desired)) assertOwnedRegular(desired, 0o600, "goals file");
if (cfg.goalsPath && resolve(cfg.goalsPath) !== desired) fail(`existing goalsPath differs from canonical path: ${cfg.goalsPath}`);
if (cfg.flags?.goalsPath && resolve(cfg.flags.goalsPath) !== desired) fail(`existing flags.goalsPath differs from canonical path: ${cfg.flags.goalsPath}`);

if (args.mode === "prepare-permissions") {
  for (const repair of permissionRepairs) chmodSync(repair.path, Number.parseInt(repair.to, 8));
  console.log(JSON.stringify({ ok: true, mode: args.mode, config: configPath, inventoryCount: inventory.length,
    workdir, permissionRepairs, contentMutated: false }));
  process.exit(0);
}

if (args.mode === "apply" && permissionRepairs.length) {
  fail(`permission repairs required before single-node apply; run --mode prepare-permissions after reviewing plan (${permissionRepairs.length} paths)`);
}

if (args.mode === "apply") {
  if (!existsSync(goalsRoot)) {
    mkdirSync(goalsRoot, { recursive: true, mode: 0o700 }); chmodSync(goalsRoot, 0o700);
    assertOwnedDirectory(goalsRoot, 0o700, "goals root");
  }
  const nodeDir = dirname(desired);
  if (!existsSync(nodeDir)) mkdirSync(nodeDir, { recursive: false, mode: 0o700 });
  assertOwnedDirectory(nodeDir, 0o700, "node goals directory", true);
  const updated = { ...cfg, model: targetModel, goalsPath: desired };
  if (updated.flags && Object.prototype.hasOwnProperty.call(updated.flags, "goalsPath")) {
    updated.flags = { ...updated.flags }; delete updated.flags.goalsPath;
  }
  if (updated.flags && Object.prototype.hasOwnProperty.call(updated.flags, "model")) {
    updated.flags = { ...updated.flags }; delete updated.flags.model;
  }
  const tmp = `${configPath}.normalize.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600); renameSync(tmp, configPath); chmodSync(configPath, 0o600);
}
console.log(JSON.stringify({ ok: true, mode: args.mode, config: configPath, node_id: nodeId,
  modelFrom: currentModel, modelTo: targetModel, workdir, goalsPath: desired, inventoryCount: inventory.length,
  goalsFile: existsSync(desired) ? "present-mode-600" : "absent-no-migration",
  permissionRepairs }));
