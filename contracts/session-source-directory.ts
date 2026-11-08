export const SOURCE_DIRECTORY_CAPABILITY = "source-directory-read-v1-opencode-2.0.22";
export type SourceDirectorySelection = { network_id: string; source_node_id: string; daemon_node_id: string };
export type SourceDirectoryRequest = SourceDirectorySelection & ({ server_id?: never; selection_scope?: never }
  | { server_id: string; selection_scope: string });
export type SourceDirectoryReceipt = SourceDirectoryTask & { ok: true; status: "pending" | "claimed" | "ready" | "failed";
  snapshot?: SourceDirectorySnapshot; error?: "directory_read_failed" };
export type SourceDirectoryTask = { request_id: string; network_id: string; source_node_id: string; daemon_node_id: string;
  server_id?: string; expires_at: number };
export type SourceDirectorySnapshot = { snapshot_id: string; expires_at: number; selection_expires_at?: number; lease_kind: "process_local";
  servers: { server_id: string; title: string }[];
  projects: { project_id: string; server_id: string; title: string }[];
  sessions: { session_id: string; project_id: string; title: string; activity: "running" | "unknown"; binding: "unknown"; attach_authorized: false }[];
  completeness: "authorized_scope_only" };
const id = (v: unknown, prefix: string) => typeof v === "string" && new RegExp(`^${prefix}_[a-f0-9-]{36}$`).test(v);
export const isDirectoryRequestId = (v: unknown) => id(v, "srcdir");
export const isDirectoryServerId = (v: unknown) => id(v, "osrv");
export function directoryTitle(v: unknown, fallback: "Project" | "Session" | "Server"): string {
  if (typeof v !== "string" || !v.trim() || v.length > 120
    || /[\x00-\x1f\x7f/\\:]|(?:ntok_|atok_|sk-|Bearer|password|token|gh[pousr]_|github_pat_|xox[baprs]-|AKIA|AIza|ya29\.|glpat-)|\b[A-Za-z0-9_=-]{28,}\b/i.test(v)) return fallback;
  return v;
}
// Exact key-set comparison as arrays, never a joined string: a key name that
// contained the separator could otherwise hide an extra key (keyset-join gate).
const keysAreExactly = (v: unknown, expected: readonly string[]): boolean => {
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return keys.length === expected.length && keys.every((k, i) => k === expected[i]);
};
const SNAPSHOT_KEYS = ["completeness", "expires_at", "lease_kind", "projects", "servers", "sessions", "snapshot_id"] as const;
const SNAPSHOT_KEYS_WITH_SELECTION = ["completeness", "expires_at", "lease_kind", "projects", "selection_expires_at", "servers", "sessions", "snapshot_id"] as const;
export function isSourceDirectorySnapshot(v: any, expires: number): v is SourceDirectorySnapshot {
  if (!v || !(keysAreExactly(v, SNAPSHOT_KEYS) || keysAreExactly(v, SNAPSHOT_KEYS_WITH_SELECTION))
    || !id(v.snapshot_id, "snap") || v.expires_at !== expires || v.lease_kind !== "process_local" || v.completeness !== "authorized_scope_only"
    || (v.selection_expires_at !== undefined && v.selection_expires_at !== expires + 600000)
    || !Array.isArray(v.servers) || v.servers.length > 16 || !Array.isArray(v.projects) || v.projects.length > 16
    || !Array.isArray(v.sessions) || v.sessions.length > 100) return false;
  const servers = new Set<string>(), projects = new Set<string>(), sessions = new Set<string>();
  for (const s of v.servers) {
    if (!s || !keysAreExactly(s, ["server_id", "title"]) || !isDirectoryServerId(s.server_id) || servers.has(s.server_id)
      || directoryTitle(s.title, "Server") !== s.title) return false;
    servers.add(s.server_id);
  }
  for (const p of v.projects) {
    if (!p || !keysAreExactly(p, ["project_id", "server_id", "title"]) || !id(p.project_id, "oprj") || projects.has(p.project_id)
      || !servers.has(p.server_id) || directoryTitle(p.title, "Project") !== p.title) return false;
    projects.add(p.project_id);
  }
  for (const s of v.sessions) {
    if (!s || !keysAreExactly(s, ["activity", "attach_authorized", "binding", "project_id", "session_id", "title"]) || !id(s.session_id, "oses") || sessions.has(s.session_id)
      || !projects.has(s.project_id) || directoryTitle(s.title, "Session") !== s.title || !["running", "unknown"].includes(s.activity)
      || s.binding !== "unknown" || s.attach_authorized !== false) return false;
    sessions.add(s.session_id);
  }
  return true;
}
