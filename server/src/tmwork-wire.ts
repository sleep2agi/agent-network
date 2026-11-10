// TMWork protocol v1 / wire v0.3. Pure validators only: no route, runtime,
// capability or authorization is enabled by importing this module.
export const TMWORK_RUNTIME = "tmwork-session" as const;
export const TMWORK_LIMITS = {
  directoryRequestMs: 60_000, snapshotMs: 300_000, maxBytes: 65_536,
  maxProjects: 16, maxSessionsPerProject: 50, maxSessionsTotal: 100, maxChildren: 20,
} as const;
export type TmworkMode = "bind" | "new" | "fork";
type CommonSelection = { protocol: 1; instance_id: string; snapshot_id: string; intent_id: string };
export type TmworkSelection = CommonSelection & (
  | { mode: "new"; project_ref: string; session_ref?: never }
  | { mode: "bind" | "fork"; session_ref: string; project_ref?: never }
);
export type TmworkCreateSpec = {
  name: string; runtime: typeof TMWORK_RUNTIME; flags: { tmwork: TmworkSelection };
};
export type TmworkCapability = {
  protocol: 1; app_version: string; instance_id: string; session_modes: TmworkMode[];
  directory: { version: 1; on_demand: true };
};

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export function isTmworkRef(v: unknown, prefix: "tmi" | "tdir" | "tsnap" | "tprj" | "tses" | "tbind"): v is string {
  return typeof v === "string" && new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(v);
}
export function isTmworkIntent(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{32}$/.test(v);
}
export function isTmworkSelection(v: unknown): v is TmworkSelection {
  if (!record(v) || v.protocol !== 1 || !isTmworkRef(v.instance_id, "tmi")
    || !isTmworkRef(v.snapshot_id, "tsnap") || !isTmworkIntent(v.intent_id)) return false;
  const common = ["protocol", "instance_id", "snapshot_id", "intent_id", "mode"];
  if (v.mode === "new") return exact(v, [...common, "project_ref"]) && isTmworkRef(v.project_ref, "tprj");
  return (v.mode === "bind" || v.mode === "fork") && exact(v, [...common, "session_ref"])
    && isTmworkRef(v.session_ref, "tses");
}
/** Shape only. The lane must separately use shared validateName and real DB authorization. */
export function isTmworkCreateSpec(v: unknown): v is TmworkCreateSpec {
  return record(v) && exact(v, ["name", "runtime", "flags"])
    && typeof v.name === "string" && v.runtime === TMWORK_RUNTIME
    && record(v.flags) && exact(v.flags, ["tmwork"]) && isTmworkSelection(v.flags.tmwork);
}
export function isTmworkCapability(v: unknown): v is TmworkCapability {
  return record(v) && exact(v, ["protocol", "app_version", "instance_id", "session_modes", "directory"])
    && v.protocol === 1 && typeof v.app_version === "string" && v.app_version.length >= 1
    && v.app_version.length <= 64 && !/\p{Cc}/u.test(v.app_version)
    && isTmworkRef(v.instance_id, "tmi") && Array.isArray(v.session_modes)
    && v.session_modes.length >= 1 && v.session_modes.length <= 3
    && new Set(v.session_modes).size === v.session_modes.length
    && v.session_modes.every(m => m === "bind" || m === "new" || m === "fork")
    && record(v.directory) && exact(v.directory, ["version", "on_demand"])
    && v.directory.version === 1 && v.directory.on_demand === true;
}
