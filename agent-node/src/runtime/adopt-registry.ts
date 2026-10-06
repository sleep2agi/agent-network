import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./config-apply.js";
import type { CodexStartInputs } from "./adopt-codex-start-inputs.js";

export interface AdoptedChild {
  adopted: true;
  request_id: string;
  node_id: string;
  workdir: string;
  nodeDir: string;
  launch_mode: "bare" | "tmux";
  codex_v2?: { version: 1; layout: "native" | "external-appserver"; socket: string; marker: string; config_hash: string; start_inputs?: CodexStartInputs };
  launch_evidence?: { mode: "bare" | "tmux"; config_hash: string; socket?: string; session?: string; pane?: string };
}
export function readWorkdirRegistry(root: string): Record<string, unknown> {
  const path = join(root, ".anet", "child-workdirs.json");
  if (!existsSync(path)) return Object.create(null);
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o022) || st.uid !== process.getuid?.()) throw Error("adopt_registry_unsafe");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("adopt_registry_invalid");
  return Object.assign(Object.create(null), value);
}
export function adoptedChild(root: string, alias: string): AdoptedChild | null {
  const entry = readWorkdirRegistry(root)[alias] as Partial<AdoptedChild> | undefined;
  if (!entry || typeof entry !== "object" || entry.adopted !== true) return null;
  if (typeof entry.node_id !== "string" || typeof entry.workdir !== "string" || typeof entry.nodeDir !== "string" ||
      typeof entry.request_id !== "string" || !["bare", "tmux"].includes(entry.launch_mode || "")) throw Error("adopt_registry_entry_invalid");
  return entry as AdoptedChild;
}
export function writeAdoptedChild(root: string, alias: string, entry: AdoptedChild): void {
  const path = join(root, ".anet");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) || st.uid !== process.getuid?.()) throw Error("adopt_registry_unsafe");
  const entries = readWorkdirRegistry(root);
  const prior = entries[alias] as any;
  if (prior !== undefined && (prior?.adopted !== true || prior.request_id !== entry.request_id)) throw Error("adopt_registry_conflict");
  entries[alias] = entry;
  atomicWriteJson(join(path, "child-workdirs.json"), entries);
}
export function forgetAdoptedChild(root: string, alias: string, requestId: string): void {
  const entries = readWorkdirRegistry(root);
  const entry = entries[alias] as any;
  if (entry?.adopted !== true || entry.request_id !== requestId) return;
  delete entries[alias];
  atomicWriteJson(join(root, ".anet", "child-workdirs.json"), entries);
}
/** Update evidence only for a still-current adoption; never resurrect a revoke. */
export function refreshAdoptedChild(root: string, alias: string, entry: AdoptedChild): void {
  if (adoptedChild(root, alias)?.request_id !== entry.request_id) throw Error("adopt_binding_revoked_during_start");
  writeAdoptedChild(root, alias, entry);
}
