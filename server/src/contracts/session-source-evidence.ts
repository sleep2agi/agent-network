// Read-only wire contract. No URL/auth/path input and no create-node directive.
export type SourceReadChallenge = {
  request_id: string; challenge: string; network_id: string; daemon_node_id: string;
  source_node_id: string; alias: string; session_id: string; expires_at: number;
  user_id: string; requester_token_id: string; mode: "attach_existing" | "fork_independent";
};
export type SourceReadEvidence = {
  request: SourceReadChallenge;
  kind: "process_local_lease"; lease_id: string; api_version: "2.0.22" | "2.0.22-anet-test.29040e2";
  canonical_directory: string; directory: { dev: string; ino: string; uid: number };
  // OS observation, not caller strings or a binary-version attestation.
  server: { pid: number; start_ticks: string; listen_inode: string };
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, any>, names: string[]) => Object.keys(v).length === names.length && names.every(k => k in v);
const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const decimal = (v: unknown) => typeof v === "string" && /^\d{1,30}$/.test(v);
export function isSourceReadChallenge(v: unknown): v is SourceReadChallenge {
  return object(v) && keys(v, ["request_id", "challenge", "network_id", "daemon_node_id", "source_node_id", "alias", "session_id", "expires_at", "user_id", "requester_token_id", "mode"])
    && typeof v.request_id === "string" && /^srcq_[A-Za-z0-9_-]{1,100}$/.test(v.request_id)
    && typeof v.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(v.challenge)
    && [v.network_id, v.daemon_node_id, v.source_node_id, v.user_id, v.requester_token_id].every(id)
    && (v.mode === "attach_existing" || v.mode === "fork_independent")
    && typeof v.alias === "string" && v.alias.length > 0 && v.alias.length <= 256 && !/[\x00-\x1f\x7f/\\]/.test(v.alias)
    && typeof v.session_id === "string" && /^ses_[A-Za-z0-9]{1,190}$/.test(v.session_id)
    && Number.isSafeInteger(v.expires_at) && v.expires_at > 0;
}
export function isSourceReadEvidence(v: unknown): v is SourceReadEvidence {
  return object(v) && keys(v, ["request", "kind", "lease_id", "api_version", "canonical_directory", "directory", "server"])
    && isSourceReadChallenge(v.request) && v.kind === "process_local_lease" && ["2.0.22", "2.0.22-anet-test.29040e2"].includes(v.api_version)
    && typeof v.lease_id === "string" && /^srcl_[A-Za-z0-9_-]{36}$/.test(v.lease_id)
    && typeof v.canonical_directory === "string" && v.canonical_directory.startsWith("/")
    && v.canonical_directory.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v.canonical_directory)
    && object(v.directory) && keys(v.directory, ["dev", "ino", "uid"]) && decimal(v.directory.dev) && decimal(v.directory.ino)
    && Number.isSafeInteger(v.directory.uid) && v.directory.uid >= 0
    && object(v.server) && keys(v.server, ["pid", "start_ticks", "listen_inode"])
    && Number.isSafeInteger(v.server.pid) && v.server.pid > 1 && decimal(v.server.start_ticks) && decimal(v.server.listen_inode);
}
export function sameSourceChallenge(a: SourceReadChallenge, b: SourceReadChallenge): boolean {
  return (Object.keys(a) as (keyof SourceReadChallenge)[]).every(k => a[k] === b[k]);
}

export type SourceLeaseRecheck = {
  request_id: string; challenge: string; evidence: SourceReadEvidence;
  intent_id: string; child_name: string; expires_at: number;
};
export type SourceLeaseConfirmation = {
  request: SourceLeaseRecheck; outcome: "lease_current";
  execution: "daemon_recheck_in_execution_context_required";
};
export function isSourceLeaseRecheck(v: unknown): v is SourceLeaseRecheck {
  return object(v) && keys(v, ["request_id", "challenge", "evidence", "intent_id", "child_name", "expires_at"])
    && typeof v.request_id === "string" && /^srcr_[A-Za-z0-9_-]{36}$/.test(v.request_id)
    && typeof v.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(v.challenge)
    && isSourceReadEvidence(v.evidence) && id(v.intent_id)
    && typeof v.child_name === "string" && v.child_name.length > 0 && v.child_name.length <= 256
    && Number.isSafeInteger(v.expires_at) && v.expires_at > 0 && v.expires_at <= v.evidence.request.expires_at;
}
export function sameSourceEvidence(a: SourceReadEvidence, b: SourceReadEvidence): boolean {
  return sameSourceChallenge(a.request, b.request) && a.kind === b.kind && a.lease_id === b.lease_id && a.api_version === b.api_version
    && a.canonical_directory === b.canonical_directory && a.directory.dev === b.directory.dev && a.directory.ino === b.directory.ino
    && a.directory.uid === b.directory.uid && a.server.pid === b.server.pid && a.server.start_ticks === b.server.start_ticks
    && a.server.listen_inode === b.server.listen_inode;
}
export function sameSourceRecheck(a: SourceLeaseRecheck, b: SourceLeaseRecheck): boolean {
  return a.request_id === b.request_id && a.challenge === b.challenge && a.intent_id === b.intent_id
    && a.child_name === b.child_name && a.expires_at === b.expires_at && sameSourceEvidence(a.evidence, b.evidence);
}
export function isSourceLeaseConfirmation(v: unknown): v is SourceLeaseConfirmation {
  return object(v) && keys(v, ["request", "outcome", "execution"]) && isSourceLeaseRecheck(v.request)
    && v.outcome === "lease_current" && v.execution === "daemon_recheck_in_execution_context_required";
}
