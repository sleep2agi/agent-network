// Hub #938 — daemon side of clone_node. Sibling of handleCreateNodeDoorbell:
// the hub mints a new ntok_ and doorbells `clone_node`; this process reads
// the source child's config on disk, writes a new node, and starts it.
//
// Workdir (see server/src/clone-node.ts for the same contract):
//   new_empty (default) — empty directory beside the source, same parent.
//     Source that still lives in the daemon cwd (no project workdir) is
//     placed at `<daemon cwd>/clone-work/<folder>` instead. That is the
//     only case that is not a sibling of the source.
//   share_source — explicit. Clone cwd is the source workdir.
//
// Session copy is per runtime and honest. A session id is written only
// when resume/continue can see the copied state:
//   Claude / Codex / Grok — id + the vendor file(s), or neither.
//   OpenCode — id only, labeled id_aliased (server-side session, not a fork).
// auth.json, secrets.env, and the source ntok_ are never copied.

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { childDirNameForCreate, resolveChildDirName } from "./child-dir-name.js";
import { childWorkDirFor, prepareChildWorkdir, recordChildWorkdir, WorkdirError } from "./child-workdir.js";
import { atomicWriteJson } from "./config-apply.js";
import { findCodexRolloutFile } from "./codex-thread-size-check.js";
import { writeCopresenceYoloToCodexHome } from "./codex-copresence-yolo.js";
import {
  ensureGlobalAnetConfig,
  getAnetBinAbs,
  minimalEnv,
  resolveChildHome,
  writeChildSecretsEnv,
  type CreateNodeDeps,
} from "./create-node-daemon.js";
import { writeCreatedOpencodeProfile } from "./opencode-create-profile.js";

/** Same rule as agent-network/src/project-key.ts encodeCwd (claude-code's project dir). */
export function encodeCwd(cwd: string): string {
  const t = cwd.replace(/[^a-zA-Z0-9\-_]/g, "-");
  return t === "" ? "unknown" : t;
}

const SECRET_KEY_RX = /(_TOKEN|_KEY|_SECRET|AUTH|PASSWORD)$/i;
const SECRET_VALUE_RX = /^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i;
const COPY_FIELDS = [
  "anet_version", "runtime", "model", "tools", "hub", "systemPrompt", "team",
  "codexBin", "codexCopresence", "codexCopresenceFullAccess",
  "opencodeGeneration", "opencodeMode", "grokCopresence",
] as const;

export type SessionCapability = "files_copied" | "id_aliased" | "unsupported" | "skipped";

export interface SessionCopyOutcome {
  capability: SessionCapability;
  field?: string;
  sessionId?: string;
  reason: string;
}

export interface CloneDiskPlan {
  workdir: string;
  /** Why this path, including the daemon-cwd fallback. */
  workdirReason: string;
}

export function cloneNodeIdFromRequest(requestId: string): string {
  return `node_${requestId.replace(/^cr_/, "")}`;
}

export function planCloneWorkdir(input: {
  policy: "new_empty" | "share_source";
  sourceWorkdir: string;
  daemonWorkdir: string;
  newName: string;
}): CloneDiskPlan {
  const source = resolve(input.sourceWorkdir);
  const daemon = resolve(input.daemonWorkdir);
  if (input.policy === "share_source") {
    return { workdir: source, workdirReason: "share_source: clone cwd is the source workdir" };
  }
  const folder = childDirNameForCreate(input.newName);
  if (source === daemon) {
    return {
      workdir: join(daemon, "clone-work", folder),
      workdirReason: "new_empty: source has no project workdir (it lives in the daemon cwd), so the clone is a new empty directory under <daemon cwd>/clone-work",
    };
  }
  return {
    workdir: join(dirname(source), folder),
    workdirReason: "new_empty: empty sibling under the source workdir's parent (same root); source contents are not copied",
  };
}

function sessionField(runtime: string, source: Record<string, unknown>): { field: string; id: string } | null {
  const pick = (field: string): { field: string; id: string } | null => {
    const v = source[field];
    if (typeof v !== "string" || !v.trim() || /[\\/\0]/.test(v)) return null;
    return { field, id: v };
  };
  if (runtime === "grok-build-cli") return pick("grokCliSession") ?? pick("session");
  if (runtime === "grok-build-acp") return pick("grokSession") ?? pick("session") ?? pick("sessionId");
  if (runtime === "codex-sdk" || runtime === "codex-app-server") return pick("codexThreadId") ?? pick("session");
  if (runtime === "claude-agent-sdk" || runtime === "claude-code-cli" || runtime === "opencode-cli") {
    return pick("session") ?? pick("resume") ?? pick("sessionId");
  }
  return pick("session");
}

/** Pure. `transcriptFound` is false for OpenCode on purpose: there is nothing local to fork. */
export function planSessionCopy(input: {
  runtime: string;
  copySession: boolean;
  sessionId: string | null;
  transcriptFound: boolean;
  field: string | null;
}): SessionCopyOutcome {
  if (!input.copySession) {
    return { capability: "skipped", reason: "copy_session is false; the clone starts with no session id" };
  }
  const runtime = input.runtime;
  if (runtime === "opencode-cli") {
    if (!input.sessionId) {
      return { capability: "unsupported", reason: "OpenCode source has no session id to alias" };
    }
    return {
      capability: "id_aliased",
      field: input.field || "session",
      sessionId: input.sessionId,
      reason: "OpenCode cannot deep-copy a session. The id is copied so session/load continues the same server-side transcript. Both nodes share that transcript; it is not a private fork.",
    };
  }
  const fileRuntime = runtime === "claude-agent-sdk" || runtime === "claude-code-cli"
    || runtime === "codex-sdk" || runtime === "codex-app-server"
    || runtime === "grok-build-acp" || runtime === "grok-build-cli";
  if (!fileRuntime) {
    return { capability: "unsupported", reason: `no session copy for runtime ${runtime}` };
  }
  if (!input.sessionId) {
    return { capability: "unsupported", reason: "source config has no session id" };
  }
  if (!input.transcriptFound) {
    const why = runtime.startsWith("codex")
      ? "no Codex rollout file to copy into the new CODEX_HOME. The thread id is not written (resume would fail). This is not `anet node codex fork`."
      : runtime.startsWith("grok")
        ? "no Grok session directory to copy. The id is not written; grok refuses to resume a missing directory."
        : "no Claude transcript (~/.claude/projects/<cwd>/<id>.jsonl) to copy. The id is not written; a bare id would bind an empty session, not continue.";
    return { capability: "unsupported", reason: why };
  }
  return {
    capability: "files_copied",
    field: input.field || "session",
    sessionId: input.sessionId,
    reason: "session id copied together with the vendor transcript into the clone's cwd/CODEX_HOME",
  };
}

function safeEnv(src: Record<string, unknown>, skipped: string[]): Record<string, unknown> | undefined {
  if (!src.env || typeof src.env !== "object" || Array.isArray(src.env)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src.env as Record<string, unknown>)) {
    if (v && typeof v === "object" && typeof (v as { _envRef?: unknown })._envRef === "string") {
      out[k] = { _envRef: (v as { _envRef: string })._envRef };
      continue;
    }
    if (typeof v === "string" && (SECRET_KEY_RX.test(k) || SECRET_VALUE_RX.test(v))) {
      skipped.push(k);
      out[k] = { _envRef: k };
      continue;
    }
    if (typeof v === "string") out[k] = v;
    else skipped.push(k);
  }
  return out;
}

function safeChannels(raw: unknown, skipped: string[]): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kept: string[] = [];
  for (const ch of raw) {
    if (typeof ch === "string" && (ch.includes("commhub") || ch.startsWith("server:"))) kept.push(ch);
    else skipped.push(typeof ch === "string" ? `channel:${ch.slice(0, 40)}` : "channel");
  }
  return kept.length ? kept : undefined;
}

function safeFlags(raw: unknown, skipped: string[]): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && SECRET_VALUE_RX.test(v)) { skipped.push(`flags.${k}`); continue; }
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** New config. `token` is the hub-minted ntok_; the source token is never read into the result. */
export function buildClonedConfig(input: {
  source: Record<string, unknown>;
  name: string;
  nodeId: string;
  token: string;
  hubUrl: string;
  session: SessionCopyOutcome;
  targetWorkdir: string;
}): { config: Record<string, unknown>; skipped: string[] } {
  const src = input.source;
  const skipped: string[] = [];
  const config: Record<string, unknown> = {
    node_id: input.nodeId,
    node_name: input.name,
    alias: input.name,
    token: input.token,
    hub: input.hubUrl,
  };
  for (const f of COPY_FIELDS) {
    if (f === "hub") continue;
    const v = src[f];
    if (v === undefined || v === null || v === "") continue;
    config[f] = v;
  }
  if (typeof src.runtime === "string") config.runtime = src.runtime;
  const flags = safeFlags(src.flags, skipped);
  if (flags) config.flags = flags;
  const channels = safeChannels(src.channels, skipped);
  if (channels) config.channels = channels;
  const env = safeEnv(src, skipped);
  if (env && Object.keys(env).length) config.env = env;
  if (typeof src.codexProjectDir === "string" && src.codexProjectDir) {
    config.codexProjectDir = input.targetWorkdir;
  }
  if ((input.session.capability === "files_copied" || input.session.capability === "id_aliased") && input.session.sessionId && input.session.field) {
    config[input.session.field] = input.session.sessionId;
    if (input.session.field !== "session" && (input.session.capability === "files_copied")) {
      // Claude resume also reads config.session. Codex/grok use their own field.
    }
    if (src.runtime === "claude-agent-sdk" || src.runtime === "claude-code-cli" || src.runtime === "opencode-cli") {
      config.session = input.session.sessionId;
    }
  }
  return { config, skipped };
}

function copyFilePrivate(from: string, to: string): boolean {
  let st;
  try { st = lstatSync(from); } catch { return false; }
  if (!st.isFile() || st.isSymbolicLink()) return false;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
  return true;
}

function copyDirNoSymlink(from: string, to: string): number {
  let n = 0;
  let st;
  try { st = lstatSync(from); } catch { return 0; }
  if (!st.isDirectory() || st.isSymbolicLink()) return 0;
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(from)) {
    if (name === "auth.json" || name === ".anet-copresence.env") continue;
    const a = join(from, name);
    const b = join(to, name);
    let child;
    try { child = lstatSync(a); } catch { continue; }
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) n += copyDirNoSymlink(a, b);
    else if (child.isFile()) {
      copyFileSync(a, b);
      n += 1;
    }
  }
  return n;
}

export function claudeTranscriptPath(home: string, cwd: string, sessionId: string): string {
  return join(home, ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
}

/** Copy vendor session state. Returns whether a transcript was actually copied. */
export function copySessionTranscript(input: {
  runtime: string;
  sessionId: string;
  sourceWorkdir: string;
  targetWorkdir: string;
  sourceNodeDir: string;
  targetNodeDir: string;
  home: string;
}): boolean {
  const same = resolve(input.sourceWorkdir) === resolve(input.targetWorkdir);
  if (input.runtime === "claude-agent-sdk" || input.runtime === "claude-code-cli") {
    const from = claudeTranscriptPath(input.home, input.sourceWorkdir, input.sessionId);
    const to = claudeTranscriptPath(input.home, input.targetWorkdir, input.sessionId);
    if (same) return existsSync(from) && lstatSync(from).isFile();
    return copyFilePrivate(from, to);
  }
  if (input.runtime === "codex-sdk" || input.runtime === "codex-app-server") {
    const homes = [join(input.sourceNodeDir, "codex-home"), join(input.home, ".codex")];
    for (const home of homes) {
      const sessionsRoot = join(home, "sessions");
      const file = findCodexRolloutFile(sessionsRoot, input.sessionId);
      if (!file) continue;
      const rel = file.slice(sessionsRoot.length).replace(/^[/\\]+/, "");
      const destHome = join(input.targetNodeDir, "codex-home");
      return copyFilePrivate(file, join(destHome, "sessions", rel));
    }
    return false;
  }
  if (input.runtime === "grok-build-acp" || input.runtime === "grok-build-cli") {
    const from = join(input.home, ".grok", "sessions", encodeURIComponent(resolve(input.sourceWorkdir)), input.sessionId);
    const to = join(input.home, ".grok", "sessions", encodeURIComponent(resolve(input.targetWorkdir)), input.sessionId);
    if (same) {
      try { return lstatSync(from).isDirectory() && !lstatSync(from).isSymbolicLink(); } catch { return false; }
    }
    return copyDirNoSymlink(from, to) > 0;
  }
  return false;
}

export interface CloneRequestBody {
  source_node_id?: string;
  source_alias?: string;
  copy_session?: boolean;
  workdir_policy?: string;
  channels?: unknown;
}

interface ClonePull {
  ok?: boolean;
  error?: string;
  node_spec?: { name?: string; runtime?: string; model?: string | null };
  child_token?: string;
  env_blob?: Record<string, string>;
  clone?: CloneRequestBody;
}

export async function handleCloneNodeDoorbell(
  event: { request_id: string },
  deps: CreateNodeDeps,
): Promise<void> {
  const { request_id } = event;
  const req = await deps.callCommHub("get_create_request", { request_id, expect_clone: true }) as ClonePull;
  if (!req?.ok || !req.node_spec?.name || !req.child_token || !req.clone?.source_alias) {
    deps.warn(`[clone-node] get_create_request failed: ${req?.error || "unknown"}`);
    if (req?.error !== "clone_request") {
      await deps.callCommHub("ack_create_request", {
        request_id, status: "failed", error: req?.error || "get_failed",
      }).catch(() => {});
    }
    return;
  }

  const alias = req.clone.source_alias;
  const policy = req.clone.workdir_policy === "share_source" ? "share_source" : "new_empty";
  const copySession = req.clone.copy_session !== false;
  const sourceWorkdir = childWorkDirFor(deps.workDir, alias);
  const nodesRoot = join(sourceWorkdir, ".anet", "nodes");
  const sourceDirName = resolveChildDirName(nodesRoot, alias);
  const sourceNodeDir = sourceDirName ? join(nodesRoot, sourceDirName) : "";
  const sourceCfgPath = sourceNodeDir ? join(sourceNodeDir, "config.json") : "";
  let source: Record<string, unknown> = {};
  try {
    source = JSON.parse(readFileSync(sourceCfgPath, "utf-8"));
  } catch (e: any) {
    const msg = `source_config_missing:${alias}`;
    deps.warn(`[clone-node] ${msg} (${e?.message || e})`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: msg,
    }).catch(() => {});
    return;
  }
  if (source.role === "host_supervisor") {
    await deps.callCommHub("ack_create_request", {
      request_id, status: "rejected", error: "cannot_clone_daemon",
    }).catch(() => {});
    return;
  }
  const runtime = typeof source.runtime === "string" ? source.runtime : (req.node_spec.runtime || "");
  if (deps.allowedRuntimes && deps.allowedRuntimes.length > 0 && !deps.allowedRuntimes.includes(runtime)) {
    await deps.callCommHub("ack_create_request", {
      request_id, status: "rejected", error: `runtime_not_in_local_allowlist: ${runtime}`,
    }).catch(() => {});
    return;
  }

  const disk = planCloneWorkdir({
    policy, sourceWorkdir, daemonWorkdir: deps.workDir, newName: req.node_spec.name,
  });
  let childWorkDir = disk.workdir;
  const childDirName = childDirNameForCreate(req.node_spec.name, policy === "new_empty" ? childWorkDir : sourceWorkdir);
  if (policy === "new_empty") {
    try {
      childWorkDir = prepareChildWorkdir(disk.workdir, childDirName, {
        home: resolveChildHome(process.env, process.platform),
        platform: process.platform,
      });
    } catch (e: any) {
      const msg = e instanceof WorkdirError ? e.message : `workdir_invalid:${e?.message || e}`;
      deps.warn(`[clone-node] ${msg} (${disk.workdirReason})`);
      await deps.callCommHub("ack_create_request", {
        request_id, status: "rejected", error: `validate: ${msg}`.slice(0, 800),
      }).catch(() => {});
      return;
    }
  }
  deps.log(`[clone-node] workdir ${childWorkDir} — ${disk.workdirReason}`);

  const childDir = join(childWorkDir, ".anet", "nodes", childDirName);
  try {
    const prev = JSON.parse(readFileSync(join(childDir, "config.json"), "utf-8"));
    const existingAlias = prev?.alias ?? prev?.node_name;
    if (existingAlias !== undefined && existingAlias !== req.node_spec.name) {
      const msg = `node_name_conflict: ${childDirName} already holds "${String(existingAlias).slice(0, 80)}"`;
      await deps.callCommHub("ack_create_request", {
        request_id, status: "rejected", error: msg.slice(0, 800),
      }).catch(() => {});
      return;
    }
  } catch { /* no config yet */ }

  const picked = sessionField(runtime, source);
  const home = resolveChildHome(process.env, process.platform);
  const nodeId = cloneNodeIdFromRequest(request_id);
  let transcriptFound = false;
  if (copySession && picked && runtime !== "opencode-cli") {
    transcriptFound = copySessionTranscript({
      runtime,
      sessionId: picked.id,
      sourceWorkdir,
      targetWorkdir: childWorkDir,
      sourceNodeDir,
      targetNodeDir: childDir,
      home,
    });
  }
  const session = planSessionCopy({
    runtime,
    copySession,
    sessionId: picked?.id ?? null,
    transcriptFound: runtime === "opencode-cli" ? false : transcriptFound,
    field: picked?.field ?? null,
  });
  if (session.capability !== "files_copied" && runtime !== "opencode-cli") {
    // A failed or skipped copy must not leave a half-written transcript under the new cwd.
    if (picked && (runtime === "claude-agent-sdk" || runtime === "claude-code-cli")) {
      const stray = claudeTranscriptPath(home, childWorkDir, picked.id);
      if (resolve(stray) !== resolve(claudeTranscriptPath(home, sourceWorkdir, picked.id))) {
        try { rmSync(stray, { force: true }); } catch { /* ok */ }
      }
    }
  }
  const { config, skipped } = buildClonedConfig({
    source, name: req.node_spec.name, nodeId, token: req.child_token, hubUrl: deps.hubUrl,
    session, targetWorkdir: childWorkDir,
  });
  if (Array.isArray(req.clone.channels) && !config.channels) {
    const ch = safeChannels(req.clone.channels, skipped);
    if (ch) config.channels = ch;
  }
  if (config.token !== req.child_token || config.token === source.token) {
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: "refusing to write the source token",
    }).catch(() => {});
    return;
  }
  deps.log(`[clone-node] session ${session.capability}: ${session.reason}`);
  if (skipped.length) deps.log(`[clone-node] skipped secrets/channels: ${skipped.join(", ")}`);

  try { ensureGlobalAnetConfig(home, deps.hubUrl); }
  catch (e: any) { deps.warn(`[clone-node] global config write failed (continuing): ${e?.message || e}`); }

  const childCfgPath = join(childDir, "config.json");
  try {
    if (runtime === "opencode-cli") writeCreatedOpencodeProfile(childDir, config);
    else {
      mkdirSync(childDir, { recursive: true, mode: 0o700 });
      atomicWriteJson(childCfgPath, config);
    }
    if (config.codexCopresence === true && runtime === "codex-app-server") {
      try { writeCopresenceYoloToCodexHome(join(childDir, "codex-home")); } catch (e: any) {
        deps.warn(`[clone-node] codex-home yolo seed failed: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    deps.warn(`[clone-node] write config failed: ${e?.message || e}`);
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: `write_config: ${e?.message || e}`.slice(0, 800),
    }).catch(() => {});
    return;
  }
  try {
    recordChildWorkdir(deps.workDir, req.node_spec.name, childWorkDir);
  } catch (e: any) {
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: `workdir_registry: ${e?.message || e}`.slice(0, 800),
    }).catch(() => {});
    return;
  }
  if (req.env_blob && Object.keys(req.env_blob).length > 0) {
    try { writeChildSecretsEnv(childWorkDir, childDirName, req.env_blob, deps.serializeEnvLocal); }
    catch (e: any) { deps.warn(`[clone-node] secrets.env write failed: ${e?.message || e}`); }
  }

  let anetBin: string;
  try { anetBin = getAnetBinAbs(); }
  catch (e: any) {
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: `bin: ${e?.message || e}`.slice(0, 800),
    }).catch(() => {});
    return;
  }

  let childPid = -1;
  try {
    const launch = deps.spawnChild ?? ((bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) =>
      spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "ignore", "ignore"], detached: true }));
    const child = launch(anetBin, ["node", "start", childDirName], { cwd: childWorkDir, env: minimalEnv() });
    childPid = child.pid || -1;
    try { child.stdin?.destroy(); } catch { /* ok */ }
    try { child.stdout?.destroy(); } catch { /* ok */ }
    try { child.stderr?.destroy(); } catch { /* ok */ }
    child.unref();
    if (childPid > 0) process.kill(childPid, 0);
  } catch (e: any) {
    await deps.callCommHub("ack_create_request", {
      request_id, status: "failed", error: `fork_start: ${e?.message || e}`.slice(0, 800),
    }).catch(() => {});
    return;
  }
  if (childPid > 0) {
    try {
      const { recordSpawnedChild } = await import("./stop-daemon.js");
      recordSpawnedChild(nodeId, req.node_spec.name, childPid);
    } catch (e: any) {
      deps.warn(`[clone-node] childrenMap record failed: ${e?.message || e}`);
    }
  }
  const waitMs = deps.capabilityCheckMs ?? 5_000;
  if (waitMs > 0) await new Promise<void>((r) => setTimeout(r, waitMs));
  if (childPid > 0) {
    try { process.kill(childPid, 0); }
    catch {
      try {
        const { forgetSpawnedChild } = await import("./stop-daemon.js");
        forgetSpawnedChild(nodeId);
      } catch { /* ok */ }
      await deps.callCommHub("ack_create_request", {
        request_id, status: "runtime_capability_check_failed",
        error: `clone child died within ${waitMs}ms`, runtime,
      }).catch(() => {});
      return;
    }
  }
  await deps.callCommHub("ack_create_request", {
    request_id, status: "started", child_pid: childPid,
  }).catch((e: any) => deps.warn(`[clone-node] ack failed: ${e?.message || e}`));
}
