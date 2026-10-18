import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createV1SharedReadClient, validateV1SharedBinding, type V1SharedServer, type V1SharedSessionBinding } from "./v1-shared-read";
import { readPrivateV1HostFile, validatePrivateV1HostDirectory } from "./v1-host-registry";

export class V1ScopedMcpError extends Error {
  readonly code = "opencode_v1_scoped_mcp_refused";
  constructor(reason: string) { super(`OpenCode V1 scoped MCP refused: ${reason}`); this.name = "V1ScopedMcpError"; }
}
function refuse(reason: string): never { throw new V1ScopedMcpError(reason); }
function object(value: any): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (e: any) { if (e?.code === "ENOENT") return false; throw e; }
}
type File = { path: string; dev: number; ino: number; bytes: Buffer };
function put(path: string, bytes: Buffer): File {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); const s = lstatSync(path);
  return { path, bytes, dev: s.dev, ino: s.ino };
}
function same(file: File): boolean {
  try {
    const s = lstatSync(file.path);
    return !s.isSymbolicLink() && s.dev === file.dev && s.ino === file.ino
      && readPrivateV1HostFile(file.path, process.getuid!(), 1024 * 1024).equals(file.bytes);
  } catch { return false; }
}
function remove(file: File): boolean {
  if (!exists(file.path)) return true;
  if (!same(file)) return false;
  unlinkSync(file.path); return true;
}

export interface OpenV1ScopedMcpOptions {
  /** Independently selected complete identity, never filled from model/tool arguments. */
  readonly expected: V1SharedSessionBinding;
  /** Reload original node's saved binding and admitted Host descriptor on every request. */
  readonly readBinding: () => V1SharedSessionBinding;
  readonly readServer: () => V1SharedServer;
  readonly alias: string;
  readonly hubMcpUrl: string;
  readonly hubToken: string;
  /** Existing private per-node state directory, separate from the project. */
  readonly stateRoot: string;
  /** Borrowed admission uses an unpredictable name in this reserved V1 flat namespace. */
  readonly registrationName?: string;
}

/** Separate from the Node runtime seam: no spawn, Host stop, session mutation,
 * directory dispose, retry or adoption. MCP supplies no trustworthy session ID;
 * its capability is associated with a uniquely leased project and exact saved
 * binding, not proof of which human/agent turn issued an upstream tool call. */
export async function openV1ScopedCommhubMcp(options: OpenV1ScopedMcpOptions) {
  const binding = Object.freeze({ ...options.expected });
  const registrationName = options.registrationName ?? "commhub";
  if (!/^(commhub|commhub_[a-f0-9]{32})$/.test(registrationName)) refuse("invalid scoped registration name");
  validateV1SharedBinding(binding, options.readBinding());
  const initialServer = Object.freeze({ ...options.readServer() });
  createV1SharedReadClient(initialServer, binding, binding);
  const uid = process.getuid?.();
  if (uid === undefined || process.platform === "win32") refuse("POSIX private-file semantics required");
  validatePrivateV1HostDirectory(options.stateRoot, uid);
  if (options.stateRoot === binding.directory) refuse("separate node state root required");
  let upstream: URL;
  try { upstream = new URL(options.hubMcpUrl); } catch { return refuse("invalid Hub MCP URL"); }
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password
    || upstream.search || upstream.hash || !upstream.pathname.endsWith("/mcp")) refuse("credential-free Hub MCP URL required");
  if (!options.hubToken || /[\r\n]/.test(options.hubToken) || !options.alias.trim() || /[\r\n]/.test(options.alias)) refuse("node identity/token required");
  // Snapshot credentials and alias; mutable caller objects cannot swap authorities.
  const hubToken = options.hubToken, alias = options.alias;
  const nonce = randomBytes(32).toString("hex"), authorization = Buffer.from(`Bearer ${nonce}`);
  const configPath = join(binding.directory, "opencode.json");
  if (exists(join(binding.directory, "opencode.jsonc"))) refuse("JSONC project config requires explicit preparation; preserve it");
  const original = exists(configPath) ? readPrivateV1HostFile(configPath, uid, 1024 * 1024) : undefined;
  let config: any;
  try { config = original ? JSON.parse(original.toString("utf8")) : {}; } catch { return refuse("project config is not plain JSON; preserve it"); }
  if (!object(config) || (config.mcp !== undefined && !object(config.mcp))
    || Object.keys(config.mcp ?? {}).some(name => name === "commhub" || name.startsWith("commhub_"))
    || config.mcp?.servers !== undefined) refuse("existing or non-V1 CommHub MCP config; preserve it");
  if ((config.tools !== undefined && !object(config.tools)) || (config.permission !== undefined && !object(config.permission))
    || (config.instructions !== undefined && !Array.isArray(config.instructions))) refuse("unsupported project policy/instructions; preserve it");
  if (config.permission?.["*"] === "deny") refuse("project wildcard denies MCP; explicit policy selection required");
  const lock = put(join(binding.directory, ".anet-v1-mcp.lock"), Buffer.from(JSON.stringify({ schema: 1, lease: nonce, ...binding })));
  const backupPath = join(options.stateRoot, `v1-mcp-${nonce}.original`);
  const instructionPath = join(options.stateRoot, `v1-mcp-${nonce}.md`);
  let backup: File | undefined, instructions: File | undefined, installed: File | undefined;
  let active = true;
  const pending = new Set<ClientRequest>();
  async function checkScope() {
    if (!active) refuse("revoked capability");
    const saved = options.readBinding(), server = options.readServer();
    validateV1SharedBinding(binding, saved);
    for (const key of ["identity", "generation", "packageName", "version", "url", "password"] as const) {
      if (server[key] !== initialServer[key]) refuse("changed Host authority");
    }
    await createV1SharedReadClient(server, binding, saved).readSession();
    if (!active) refuse("revoked capability");
    validateV1SharedBinding(binding, options.readBinding());
    const current = options.readServer();
    for (const key of ["identity", "generation", "packageName", "version", "url", "password"] as const) {
      if (current[key] !== initialServer[key]) refuse("changed Host authority");
    }
    if (!same(lock) || (installed && !same(installed))) refuse("changed project lease/config");
  }
  const proxy = createServer(async (incoming, outgoing) => {
    if (!active) { outgoing.writeHead(403).end(); return; }
    if (incoming.url !== "/mcp") { outgoing.writeHead(404).end(); return; }
    const supplied = Buffer.from(incoming.headers.authorization ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) { outgoing.writeHead(401).end(); return; }
    if (!["POST", "GET", "DELETE"].includes(incoming.method ?? "")) { outgoing.writeHead(405).end(); return; }
    let body = Buffer.alloc(0);
    try {
      if (incoming.method === "POST") {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of incoming) { size += chunk.length; if (size > 1024 * 1024) { outgoing.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
        let message: any;
        try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { outgoing.writeHead(400).end(); return; }
        if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") { outgoing.writeHead(400).end(); return; }
        if (message.method === "tools/call") {
          const args = message.params?.arguments;
          if (!object(message.params) || typeof message.params.name !== "string" || (args !== undefined && !object(args))) { outgoing.writeHead(400).end(); return; }
          if (args?.network_id !== undefined && args.network_id !== binding.networkId) { outgoing.writeHead(403).end(); return; }
          // Original Hub token establishes caller node; network and sender cannot
          // be replaced by a model-provided alias/network argument.
          message.params.arguments = { ...(args ?? {}) };
          if (["send_task", "send_message", "send_reply"].includes(message.params.name)) {
            message.params.arguments.network_id = binding.networkId;
            message.params.arguments.from_session = alias;
          }
        }
        body = Buffer.from(JSON.stringify(message));
      }
      await checkScope();
    } catch { outgoing.writeHead(403).end("V1 MCP binding unavailable"); return; }
    if (!active || incoming.destroyed && incoming.method !== "POST") { outgoing.writeHead(403).end(); return; }
    const headers: Record<string, string> = { authorization: `Bearer ${hubToken}` };
    for (const name of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
      const value = incoming.headers[name]; if (typeof value === "string") headers[name] = value;
    }
    if (incoming.method === "POST") headers["content-length"] = String(body.length);
    const target = (upstream.protocol === "https:" ? httpsRequest : httpRequest)(upstream, { method: incoming.method, headers }, response => {
      const responseHeaders: Record<string, string> = {};
      for (const name of ["content-type", "mcp-session-id", "mcp-protocol-version"]) {
        const value = response.headers[name]; if (typeof value === "string") responseHeaders[name] = value;
      }
      outgoing.writeHead(response.statusCode ?? 502, responseHeaders); response.pipe(outgoing);
    });
    pending.add(target); target.once("close", () => pending.delete(target));
    target.setTimeout(30000, () => target.destroy());
    target.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end("V1 MCP upstream unavailable"); });
    outgoing.once("close", () => target.destroy()); target.end(body);
  });
  let closePromise: Promise<void> | undefined;
  let revokePromise: Promise<void> | undefined;
  function revoke(): Promise<void> {
    return revokePromise ??= (async () => {
      active = false; for (const request of pending) request.destroy();
      await new Promise<void>(resolve => { proxy.close(() => resolve()); proxy.closeAllConnections(); });
    })();
  }
  async function close() {
    return closePromise ??= (async () => {
      await revoke();
      if (installed && !same(installed)) refuse("edited config retained with recovery files; capability revoked");
      if (!same(lock) || (backup && !same(backup)) || (instructions && !same(instructions))) refuse("edited recovery files retained; capability revoked");
      if (installed) {
        if (original) {
          const restore = put(`${configPath}.restore-${nonce}`, original);
          if (!same(installed)) { remove(restore); refuse("config changed before restore; preserve it"); }
          renameSync(restore.path, configPath);
        } else { remove(installed); }
      }
      if (backup) remove(backup); if (instructions) remove(instructions); remove(lock);
    })();
  }
  try {
    backup = put(backupPath, original ?? Buffer.from("\n"));
    instructions = put(instructionPath, Buffer.from(`CommHub MCP belongs to ${alias}; network ${binding.networkId}, node ${binding.nodeId}.\nUse this node's CommHub connection. Directory and exact session are checked by its bridge, not selected by prompts.\n`));
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const address = proxy.address(); if (!address || typeof address === "string") refuse("loopback proxy bind failed");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const mcpConfig = Object.freeze({ type: "remote", url, enabled: true, oauth: false, headers: Object.freeze({ Authorization: authorization.toString() }) });
    config.mcp = { ...(config.mcp ?? {}), [registrationName]: mcpConfig };
    config.tools = { ...(config.tools ?? {}), "commhub_*": true };
    config.permission = { ...(config.permission ?? {}), "commhub_*": "allow" };
    config.instructions = [...(config.instructions ?? []), instructionPath];
    const staged = put(`${configPath}.stage-${nonce}`, Buffer.from(`${JSON.stringify(config, null, 2)}\n`));
    if (original) {
      if (!readPrivateV1HostFile(configPath, uid, 1024 * 1024).equals(original)) { remove(staged); refuse("project edited before install"); }
      renameSync(staged.path, configPath);
    } else {
      // Exclusive original creation; never replace a concurrent new file.
      try { put(configPath, staged.bytes); } finally { remove(staged); }
    }
    const stat = lstatSync(configPath); installed = { path: configPath, dev: stat.dev, ino: stat.ino, bytes: staged.bytes };
    return Object.freeze({ url, mcpConfig, binding, registrationName, verify: checkScope, revoke, close });
  } catch (error) { await close(); throw error; }
}
