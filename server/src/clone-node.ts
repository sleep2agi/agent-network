// Hub #938 — clone a daemon child into a new node on the SAME daemon.
//
// Contract (also what `clone_node` returns as `contract`):
//
//   Identity     new node_id (minted like create_node: `node_<request id>`),
//                new alias, new ntok_. The source token is never copied and
//                never placed in the env blob.
//   Copied       runtime, model / provider ref (the model string, including
//                `provider/model`), flags that pass the create_node flag
//                checks, and commhub channel specs (string entries that are
//                the network itself). Secret-looking flag values are dropped.
//   Not copied   token, secrets.env, inline secret env values (key names may
//                remain as env refs with no value), non-commhub channel
//                specs (those carry per-node bot credentials).
//   Session      `copy_session` defaults to true. What that can actually do
//                depends on the runtime — see `sessionContractForRuntime`.
//                The daemon performs the copy; this module only states the
//                capability so the caller is not told a deep copy happened
//                when the vendor store cannot be forked.
//   Workdir      `new_empty` (default) or `share_source`. The daemon chooses
//                the path; this module only records the policy.
//
// Workdir policy, decided on the daemon because only it knows the source
// directory:
//
//   new_empty (default)
//     A new empty directory under the same parent as the source workdir:
//     `dirname(sourceWorkdir)/<ascii folder>`. The folder name is the new
//     alias when that alias is already an ASCII directory name, otherwise
//     the usual `node-<hash>` slug. Nothing inside the source workdir is
//     copied (no rules file, no checkout).
//     When the source has no project workdir of its own — it was created
//     in the daemon cwd — there is no sibling project to sit beside. The
//     clone is then placed at `<daemon cwd>/clone-work/<ascii folder>`,
//     still a new empty directory under the daemon root. That is the only
//     case that does not use the source's parent.
//
//   share_source
//     Explicit opt-in. The clone's cwd is the source workdir. Two nodes
//     share that checkout. The token is still new. Session files that are
//     keyed by cwd do not need to be relocated.
//
// Cross-daemon: the clone is dispatched only to the daemon that created
// the source (`node_create_requests.daemon_node_id` of the succeeded row).
// Passing a different `daemon_node_id` is `cross_daemon_refused`. A node
// with no succeeded create row on a daemon is `source_not_daemon_child`.

import {
  FLAG_KEYS,
  validateFlagValue,
  validateFlagsForRuntime,
  validateModel,
  validateName,
  validateRuntime,
  ValidationError,
} from "./create-node-validate.js";

export const CLONE_WORKDIR_POLICIES = ["new_empty", "share_source"] as const;
export type CloneWorkdirPolicy = typeof CLONE_WORKDIR_POLICIES[number];

const SECRET_VALUE_RX = /^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i;

export interface CloneSourceFacts {
  nodeId: string;
  alias: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  flags: Record<string, unknown>;
  channels: unknown;
  /** Daemon that owns the succeeded create row, or null if this node is not a daemon child. */
  owningDaemonId: string | null;
  /** Aliases / node names already present in the network. */
  existingNames: readonly string[];
  /** child_name values with a pending/delivered create on the owning daemon. */
  inflightNames: readonly string[];
}

export interface CloneAsk {
  newName: string;
  copySession: boolean;
  workdirPolicy: CloneWorkdirPolicy;
  /** When set, must equal the owning daemon. */
  requestedDaemonId: string | null;
}

export interface SessionContract {
  /** Stable code. Not a claim that a private transcript fork already exists. */
  mode: "transcript_when_present" | "id_aliased" | "unsupported";
  runtime: string;
  /** What resume/continue will do, in one sentence the caller can show. */
  detail: string;
}

export type CloneDecision =
  | { ok: false; error: string; detail?: Record<string, unknown> }
  | {
      ok: true;
      daemonNodeId: string;
      name: string;
      runtime: string;
      model: string | null;
      flags: Record<string, unknown>;
      channels: string[];
      droppedChannels: string[];
      copySession: boolean;
      workdirPolicy: CloneWorkdirPolicy;
      sessionContract: SessionContract;
    };

export function sessionContractForRuntime(runtime: string): SessionContract {
  if (runtime === "claude-agent-sdk" || runtime === "claude-code-cli") {
    return {
      mode: "transcript_when_present",
      runtime,
      detail: "Claude resume is the session id plus ~/.claude/projects/<cwd>/<id>.jsonl. The daemon copies that file into the clone's cwd key and writes the same session id. If the file is not on disk, the id is not copied: a bare id would bind an empty session, not continue the old one.",
    };
  }
  if (runtime === "codex-sdk" || runtime === "codex-app-server") {
    return {
      mode: "transcript_when_present",
      runtime,
      detail: "Codex resume needs the rollout file under the new node's CODEX_HOME. The daemon copies that rollout and keeps the thread id when the file is present. auth.json is not copied. If there is no rollout, the thread id is not copied. This is not `anet node codex fork` (that rewrites a new thread id).",
    };
  }
  if (runtime === "grok-build-acp" || runtime === "grok-build-cli") {
    return {
      mode: "transcript_when_present",
      runtime,
      detail: "Grok resume needs the session directory under the grok home, keyed by cwd. The daemon copies that directory and keeps the session id when it exists. If it does not, the id is not copied: grok refuses to resume a missing directory.",
    };
  }
  if (runtime === "opencode-cli") {
    return {
      mode: "id_aliased",
      runtime,
      detail: "OpenCode sessions live in the OpenCode server, not in the node directory. The daemon copies the session id so session/load addresses that same server session. That is not a private deep copy: both nodes share one server-side transcript. There is no local transcript to fork.",
    };
  }
  return {
    mode: "unsupported",
    runtime,
    detail: "This runtime has no clone session copy. The new node starts without a session id.",
  };
}

function safeFlags(runtime: string, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(FLAG_KEYS as readonly string[]).includes(k)) continue;
    if (typeof v === "string" && SECRET_VALUE_RX.test(v)) continue;
    try {
      validateFlagValue(k, v);
    } catch {
      continue;
    }
    out[k] = v;
  }
  validateFlagsForRuntime(runtime, out);
  return out;
}

/** Commhub channel specs only. Anything else can carry a bot credential. */
export function safeChannels(raw: unknown): { kept: string[]; dropped: string[] } {
  if (!Array.isArray(raw)) return { kept: [], dropped: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const ch of raw) {
    if (typeof ch !== "string") {
      dropped.push(typeof ch);
      continue;
    }
    if (ch.includes("commhub") || ch.startsWith("server:")) kept.push(ch);
    else dropped.push(ch.slice(0, 80));
  }
  return { kept, dropped };
}

function readRole(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const role = (snapshot as { role?: unknown }).role;
  return typeof role === "string" ? role : null;
}

export function factsFromRows(input: {
  node: { node_id: string; alias: string | null; node_name?: string | null; runtime?: string | null; model?: string | null; channels?: string | null; config_snapshot?: string | null };
  createRow: { daemon_node_id: string; runtime: string; model: string | null; flags_json: string; child_name: string } | null;
  existingNames: readonly string[];
  inflightNames: readonly string[];
}): CloneSourceFacts {
  let snap: Record<string, unknown> = {};
  try {
    const parsed = input.node.config_snapshot ? JSON.parse(input.node.config_snapshot) : null;
    if (parsed && typeof parsed === "object") snap = parsed as Record<string, unknown>;
  } catch { /* snapshot is display state; the create row still stands */ }
  let createFlags: Record<string, unknown> = {};
  try {
    const parsed = input.createRow ? JSON.parse(input.createRow.flags_json) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) createFlags = parsed as Record<string, unknown>;
  } catch { /* ignore */ }
  const snapFlags = snap.flags && typeof snap.flags === "object" && !Array.isArray(snap.flags)
    ? snap.flags as Record<string, unknown>
    : {};
  const runtime = (typeof snap.runtime === "string" && snap.runtime) ? snap.runtime
    : (input.node.runtime || input.createRow?.runtime || null);
  const model = (typeof snap.model === "string" || snap.model === null) ? (snap.model as string | null)
    : (input.node.model ?? input.createRow?.model ?? null);
  const channels = Array.isArray(snap.channels) ? snap.channels
    : (input.node.channels ? safeParseArray(input.node.channels) : []);
  return {
    nodeId: input.node.node_id,
    alias: input.node.alias || input.node.node_name || input.createRow?.child_name || "",
    role: readRole(snap),
    runtime,
    model,
    flags: { ...createFlags, ...snapFlags },
    channels,
    owningDaemonId: input.createRow?.daemon_node_id ?? null,
    existingNames: input.existingNames,
    inflightNames: input.inflightNames,
  };
}

function safeParseArray(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Pure. Throws ValidationError for a bad new name, model, or runtime. */
export function decideClone(source: CloneSourceFacts, ask: CloneAsk): CloneDecision {
  if (!source.alias) {
    return { ok: false, error: "source_alias_missing", detail: { source_node_id: source.nodeId } };
  }
  if (source.role === "host_supervisor") {
    return { ok: false, error: "cannot_clone_daemon", detail: { source_node_id: source.nodeId } };
  }
  if (!source.owningDaemonId) {
    return { ok: false, error: "source_not_daemon_child", detail: { source_node_id: source.nodeId } };
  }
  if (ask.requestedDaemonId && ask.requestedDaemonId !== source.owningDaemonId) {
    return {
      ok: false,
      error: "cross_daemon_refused",
      detail: { source_daemon_node_id: source.owningDaemonId, requested_daemon_node_id: ask.requestedDaemonId },
    };
  }
  const name = validateName(ask.newName);
  if (name === source.alias) {
    return { ok: false, error: "node_name_conflict", detail: { name, reason: "same_as_source" } };
  }
  if (source.existingNames.includes(name)) {
    return { ok: false, error: "node_name_conflict", detail: { name, reason: "alias_taken" } };
  }
  if (source.inflightNames.includes(name)) {
    return { ok: false, error: "node_name_conflict", detail: { name, reason: "inflight_create" } };
  }
  if (!source.runtime) {
    return { ok: false, error: "source_runtime_unknown", detail: { source_node_id: source.nodeId } };
  }
  validateRuntime(source.runtime);
  validateModel(source.model);
  const flags = safeFlags(source.runtime, source.flags);
  const channels = safeChannels(source.channels);
  return {
    ok: true,
    daemonNodeId: source.owningDaemonId,
    name,
    runtime: source.runtime,
    model: source.model ?? null,
    flags,
    channels: channels.kept,
    droppedChannels: channels.dropped,
    copySession: ask.copySession,
    workdirPolicy: ask.workdirPolicy,
    sessionContract: sessionContractForRuntime(source.runtime),
  };
}

export function parseWorkdirPolicy(raw: unknown): CloneWorkdirPolicy {
  if (raw === undefined || raw === null || raw === "") return "new_empty";
  if (raw === "new_empty" || raw === "share_source") return raw;
  throw new ValidationError("workdir_policy_invalid", { value: typeof raw === "string" ? raw.slice(0, 40) : typeof raw, allowed: [...CLONE_WORKDIR_POLICIES] });
}

export { ValidationError };
