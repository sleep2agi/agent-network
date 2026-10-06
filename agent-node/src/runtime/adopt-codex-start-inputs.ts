import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AdoptionLocalIdentity } from "./adopt-local-identity.js";
import type { CodexAdoptionScope } from "./adopt-codex-evidence.js";
import { configHash } from "./adopt-launch-evidence.js";

/** Config-derived inputs captured AFTER live three-stage identity verification.
 * Not an executable command, observed argv, secret snapshot, or launch authority.
 * B must still prove the exact thread, executable and port ownership at runtime.
 */
export interface CodexStartInputs {
  version: 1;
  binding_request_id: string;
  node_id: string;
  config_hash: string;
  scope: CodexAdoptionScope;
  node_dir: string;
  project_dir: string;
  thread_id: string;
  appserver_url: string;
}
const fullThread = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codexStartInputs(identity: AdoptionLocalIdentity, scope: CodexAdoptionScope, requestId: string): CodexStartInputs {
  const cfg = identity.config;
  const thread = cfg.codexThreadId;
  if (typeof thread !== "string" || !fullThread.test(thread)) throw Error("adopt_codex_exact_thread_required");
  // Never resolve hostnames, accept credentials in a URL, or silently choose a port.
  const raw = cfg.codexAppServerUrl;
  if (typeof raw !== "string" || !/^ws:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/.test(raw))
    throw Error("adopt_codex_local_endpoint_required");
  let url: URL;
  try { url = new URL(raw); } catch { throw Error("adopt_codex_local_endpoint_required"); }
  if (!url.port || Number(url.port) > 65535) throw Error("adopt_codex_local_endpoint_required");
  const project = cfg.codexProjectDir === undefined || cfg.codexProjectDir === "" ? identity.workdir : cfg.codexProjectDir;
  if (typeof project !== "string" || !isAbsolute(project) || /[\0\r\n]/.test(project)) throw Error("adopt_codex_project_unproven");
  const rel = relative(identity.workdir, project);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw Error("adopt_codex_project_unproven");
  const st = lstatSync(project);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(project) !== project || st.uid !== scope.uid || (st.mode & 0o022))
    throw Error("adopt_codex_project_unproven");
  const env = cfg.env as Record<string, unknown> | undefined;
  if ((cfg.codexHome !== undefined && cfg.codexHome !== scope.codexHome) ||
      (env?.CODEX_HOME !== undefined && env.CODEX_HOME !== scope.codexHome)) throw Error("adopt_codex_home_unproven");
  if (!requestId || !identity.nodeId || scope.alias !== identity.alias || scope.workdir !== identity.workdir)
    throw Error("adopt_codex_start_inputs_invalid");
  return { version: 1, binding_request_id: requestId, node_id: identity.nodeId, config_hash: configHash(identity),
    scope: { ...scope }, node_dir: identity.nodeDir, project_dir: project, thread_id: thread, appserver_url: raw };
}

/** Missing start metadata must not turn safe stop-only adoption into refusal. */
export function optionalCodexStartInputs(identity: AdoptionLocalIdentity, scope: CodexAdoptionScope, requestId: string): CodexStartInputs | undefined {
  try { return codexStartInputs(identity, scope, requestId); } catch { return undefined; }
}

export function verifyCodexStartInputs(saved: unknown, identity: AdoptionLocalIdentity, scope: CodexAdoptionScope, requestId: string): CodexStartInputs {
  if (!saved) throw Error("adopt_codex_start_evidence_missing");
  const current = codexStartInputs(identity, scope, requestId);
  if (!isDeepStrictEqual(saved, current)) throw Error("adopt_codex_start_evidence_changed");
  return current;
}
