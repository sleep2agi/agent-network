import { realpathSync } from "node:fs";
import { isAcceptedOpencodeVersionFor } from "../opencode-versions";
import { fetchOpenCodeJson } from "./http";

/** The supervisor's generation-specific identity is supplied by the caller.
 * Health/version cannot attest a host identity. This is a cooperative cohort,
 * not authorization against a peer holding the shared Server password. */
export interface V1SharedServer {
  readonly identity: string;
  readonly generation: "v1";
  readonly packageName: "opencode-ai";
  readonly version: string;
  readonly url: string;
  readonly password: string;
}

export interface V1SharedSessionBinding {
  readonly networkId: string;
  readonly nodeId: string;
  readonly serverIdentity: string;
  readonly directory: string;
  readonly sessionId: string;
}

export class V1SharedBindingError extends Error {
  readonly code = "opencode_v1_shared_binding_refused";
  constructor(reason: string) {
    super(`OpenCode V1 shared binding refused: ${reason}`);
    this.name = "V1SharedBindingError";
  }
}

function refuse(reason: string): never { throw new V1SharedBindingError(reason); }

function canonicalDirectory(directory: string): string {
  try {
    if (realpathSync(directory) === directory) return directory;
  } catch { /* Missing/unreadable directories cannot establish scope. */ }
  return refuse("directory is not a readable canonical path");
}

/** Compare persisted binding against the node's independently selected exact
 * identity. Never adopt fields from an upstream session/list/latest response. */
export function validateV1SharedBinding(
  expected: V1SharedSessionBinding,
  saved: V1SharedSessionBinding,
): void {
  for (const key of ["networkId", "nodeId", "serverIdentity", "directory", "sessionId"] as const) {
    if (typeof expected[key] !== "string" || !expected[key].trim() || expected[key] !== saved[key]) {
      refuse(`mismatched ${key}`);
    }
  }
  if (!/^ses_[A-Za-z0-9_-]+$/.test(expected.sessionId)) refuse("invalid exact session ID");
  canonicalDirectory(expected.directory);
}

/** First shared-runtime primitive: read-only, exact session. It deliberately
 * has no create/fork/latest, prompt, abort, global dispose or process cleanup.
 * The owned runtime continues to use fetchOpenCodeJson without a directory. */
export function createV1SharedReadClient(
  descriptor: V1SharedServer,
  expected: V1SharedSessionBinding,
  saved: V1SharedSessionBinding,
) {
  validateV1SharedBinding(expected, saved);
  const server = Object.freeze({ ...descriptor });
  const binding = Object.freeze({ ...expected });
  if (server.generation !== "v1" || server.packageName !== "opencode-ai"
    || !isAcceptedOpencodeVersionFor("v1", server.version)) refuse("unsupported generation/package/version");
  if (server.identity !== binding.serverIdentity) refuse("mismatched Server identity");
  let url: URL;
  try { url = new URL(server.url); } catch { return refuse("invalid Server URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    refuse("Server URL must be credential-free loopback origin");
  }
  if (typeof server.password !== "string" || !server.password) refuse("missing Server password");
  const origin = url.origin;
  const path = `/session/${encodeURIComponent(binding.sessionId)}`;
  async function read(route: string): Promise<any> {
    canonicalDirectory(binding.directory);
    return fetchOpenCodeJson(origin, server.password, route, {
      headers: { "x-opencode-directory": encodeURIComponent(binding.directory) },
      redirect: "error",
    });
  }
  async function readSession(): Promise<any> {
    const health = await read("/global/health");
    if (health?.healthy !== true || health?.version !== server.version) refuse("health/version mismatch");
    const info = await read(path);
    // #1194: V1 returns foreign sessions with HTTP 200 despite the directory
    // selector. Compare both fields before exposing history to the bridge.
    if (info?.id !== binding.sessionId || info?.directory !== binding.directory) {
      refuse("foreign session ID/directory");
    }
    return info;
  }
  async function readMessages(): Promise<any[]> {
    await readSession();
    const messages = await read(`${path}/message`);
    if (!Array.isArray(messages) || messages.some(message =>
      message?.info?.sessionID !== binding.sessionId || !Array.isArray(message.parts)
      || message.parts.some((part: any) => part?.sessionID !== binding.sessionId))) {
      refuse("foreign/malformed message history");
    }
    return messages;
  }
  return Object.freeze({ readSession, readMessages });
}
