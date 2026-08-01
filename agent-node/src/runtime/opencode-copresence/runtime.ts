import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { randomBytes } from "crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { join } from "path";
import { resolve } from "path";
import {
  buildOpencodeChildEnv,
  cleanupOpencodeChildEnv,
  discardUnspawnedOpencodeChildEnv,
  revalidateOpencodeChildLaunch,
} from "../opencode-acp/child-env";
import {
  discoverOpencodeForbiddenRoots,
  revalidatePinnedOpencodeBinary,
  resolvePinnedOpencodeBinaryAttestation,
  type PinnedOpencodeBinaryAttestation,
} from "../opencode-acp/binary";
import {
  linuxProcessGroupIsGone,
  readLinuxProcessGroupIdentity,
  signalExactLinuxProcessGroup,
  type LinuxProcessGroupIdentity,
} from "./process-group";

const USERNAME = "opencode";
const OUTPUT_LIMIT = 64 * 1024;

export interface OpenCodeCopresenceSubmitResult {
  replyText: string;
  stdout: string;
}

export interface OpenCodeCopresenceSession {
  readonly url: string;
  readonly sessionId: string;
  readonly attachScriptPath: string;
  readonly isRunning: boolean;
  notify(message: string, timeoutMs?: number): Promise<void>;
  submit(prompt: string, timeoutMs?: number): Promise<OpenCodeCopresenceSubmitResult>;
  close(): Promise<void>;
}

export interface OpenVettedOpenCodeCopresenceOptions {
  binary: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  workDir: string;
  model?: string;
  title?: string;
  startupTimeoutMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface OpenOpenCodeCopresenceOptions {
  cwd: string;
  workDir: string;
  model?: string;
  unsafeTools?: boolean;
  binary?: string;
  expectedVersion?: string;
  binarySearchPath?: string;
  launchBase?: string;
  title?: string;
  startupTimeoutMs?: number;
  onSession?: (sessionId: string) => void | Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function basicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`${USERNAME}:${password}`).toString("base64")}`;
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-OUTPUT_LIMIT);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve an OpenCode loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function fetchJson(
  url: string,
  password: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<any> {
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      authorization: basicAuthorization(password),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenCode ${init.method ?? "GET"} ${path} returned HTTP ${response.status}`);
  }
  return text ? JSON.parse(text) : null;
}

async function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  url: string,
  password: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("OpenCode serve exited before readiness");
    }
    try {
      const health = await fetchJson(url, password, "/global/health", {}, 300);
      if (health?.healthy === true) {
        const unauthenticated = await fetch(`${url}/global/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (unauthenticated.status !== 401) {
          throw new Error(`OpenCode serve authentication gate returned HTTP ${unauthenticated.status}`);
        }
        return;
      }
    } catch (error: any) {
      if (/authentication gate/.test(error?.message ?? "")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`OpenCode serve readiness timed out after ${timeoutMs}ms`);
}

async function waitUntilSessionIdle(
  url: string,
  password: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statuses = await fetchJson(url, password, "/session/status", {}, 2_000);
    const state = statuses?.[sessionId];
    if (state === undefined || state?.type === "idle") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`OpenCode session remained busy for ${timeoutMs}ms`);
}

function parseMessageReply(message: any): string {
  const parts: string[] = [];
  for (const part of message?.parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("").trim();
}

function parseModelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`OpenCode model must use provider/model form (got ${JSON.stringify(model)})`);
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
}

async function stopProcessGroup(
  child: ChildProcessWithoutNullStreams,
  identity: LinuxProcessGroupIdentity,
): Promise<void> {
  if (linuxProcessGroupIsGone(identity)) return;
  if (!signalExactLinuxProcessGroup(identity, "SIGTERM")) {
    throw new Error("refusing to stop OpenCode process group after identity mismatch");
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !linuxProcessGroupIsGone(identity)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!linuxProcessGroupIsGone(identity)) {
    if (!signalExactLinuxProcessGroup(identity, "SIGKILL")) {
      throw new Error("refusing to force-stop OpenCode process group after identity mismatch");
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

function writeAttachScript(
  path: string,
  binary: string,
  env: NodeJS.ProcessEnv,
  url: string,
  password: string,
  sessionId: string,
  cwd: string,
): void {
  const exported = Object.entries({
    ...env,
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const lines = [
    "#!/usr/bin/env bash",
    "set -eu",
    ...exported.map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `cd ${shellQuote(cwd)}`,
    `exec ${shellQuote(binary)} attach ${shellQuote(url)} --session ${shellQuote(sessionId)} --dir ${shellQuote(cwd)} --pure`,
    "",
  ];
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  writeFileSync(temporary, lines.join("\n"), { mode: 0o700, flag: "wx" });
  chmodSync(temporary, 0o700);
  renameSync(temporary, path);
  chmodSync(path, 0o700);
}

/**
 * Start an already-vetted OpenCode binary in native serve+attach mode.
 * Binary/package attestation and launch-scoped credential preparation remain
 * the caller's responsibility; this core owns HTTP authentication, the shared
 * session, FIFO network turns, and exact process-group teardown.
 */
export async function openVettedOpenCodeCopresence(
  opts: OpenVettedOpenCodeCopresenceOptions,
): Promise<OpenCodeCopresenceSession> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const port = await reserveLoopbackPort();
  const url = `http://127.0.0.1:${port}`;
  const password = randomBytes(32).toString("base64url");
  const childEnv: NodeJS.ProcessEnv = {
    ...opts.env,
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
  };
  const child = spawn(opts.binary, [
    "serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure",
  ], {
    cwd: opts.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform === "linux",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let startupOutput = "";
  child.stdout.on("data", (chunk: string) => { startupOutput = appendBounded(startupOutput, chunk); });
  child.stderr.on("data", (chunk: string) => { startupOutput = appendBounded(startupOutput, chunk); });

  if (!child.pid) throw new Error("OpenCode serve spawn returned no pid");
  const identity = readLinuxProcessGroupIdentity(child.pid);
  if (process.platform === "linux" && (!identity || identity.pgrp !== child.pid)) {
    try { child.kill("SIGKILL"); } catch {}
    throw new Error("OpenCode serve failed the detached process-group identity handshake");
  }

  let closed = false;
  let queue = Promise.resolve();
  const attachScriptPath = join(opts.workDir, "opencode-attach.sh");

  try {
    await waitForHealth(child, url, password, opts.startupTimeoutMs ?? 20_000);
    const created = await fetchJson(url, password, "/session", {
      method: "POST",
      body: JSON.stringify({ title: opts.title ?? "Agent Network shared TUI" }),
    });
    if (typeof created?.id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(created.id)) {
      throw new Error("OpenCode POST /session returned an invalid session id");
    }
    writeAttachScript(
      attachScriptPath,
      opts.binary,
      opts.env,
      url,
      password,
      created.id,
      opts.cwd,
    );
    log(`[opencode-copresence] ready session=${created.id.slice(0, 12)} attach=${attachScriptPath}`);

    const session: OpenCodeCopresenceSession = {
      url,
      sessionId: created.id,
      attachScriptPath,
      get isRunning() {
        return !closed && child.exitCode === null && child.signalCode === null;
      },
      notify(message: string, timeoutMs = 30_000) {
        return (async () => {
          if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
          await fetchJson(url, password, "/tui/show-toast", {
            method: "POST",
            // CommHub send_message is informational and does not request a
            // response. Use OpenCode's TUI notification channel instead of a
            // noReply user message: noReply leaves an unanswered user turn in
            // history, which the next real task can accidentally answer.
            body: JSON.stringify({
              title: "Agent Network message",
              message,
              variant: "info",
              duration: 15_000,
            }),
          }, timeoutMs);
        })();
      },
      submit(prompt: string, timeoutMs = 300_000) {
        const operation = queue.then(async () => {
          if (!session.isRunning) throw new Error("OpenCode copresence server is not running");
          await waitUntilSessionIdle(url, password, created.id, timeoutMs);
          // The server REST endpoint is the canonical network-side transport
          // in RFC-029. `opencode run --attach --session` is intentionally not
          // used here: in 1.18.1 it can wait before submitting when the same
          // session already has a full attach TUI, leaving a live-looking
          // process with no message in the shared session.
          const model = parseModelRef(opts.model);
          const message = await fetchJson(url, password, `/session/${created.id}/message`, {
            method: "POST",
            body: JSON.stringify({
              ...(model ? { model } : {}),
              parts: [{ type: "text", text: prompt }],
            }),
          }, timeoutMs);
          const replyText = parseMessageReply(message);
          if (!replyText) {
            throw new Error("OpenCode POST /session/:id/message returned no assistant text");
          }
          return {
            replyText,
            stdout: JSON.stringify(message),
          };
        });
        queue = operation.then(() => undefined, () => undefined);
        return operation;
      },
      async close() {
        if (closed) return;
        closed = true;
        rmSync(attachScriptPath, { force: true });
        if (identity) await stopProcessGroup(child, identity);
        else try { child.kill("SIGKILL"); } catch {}
      },
    };
    child.once("exit", (code, signal) => {
      if (!closed) warn(`[opencode-copresence] serve exited code=${code} signal=${signal}; next task must reopen`);
    });
    return session;
  } catch (error) {
    rmSync(attachScriptPath, { force: true });
    if (identity) await stopProcessGroup(child, identity).catch(() => {});
    else try { child.kill("SIGKILL"); } catch {}
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      startupOutput: startupOutput.slice(-1_000),
    });
  }
}

/**
 * Full production entry: perform the same credential-free exact-package probe
 * and launch-scoped env preparation as the ACP runtime, then open the native
 * serve+attach topology. No rejected executable receives provider auth.
 */
export async function openOpenCodeCopresenceRuntime(
  opts: OpenOpenCodeCopresenceOptions,
): Promise<OpenCodeCopresenceSession> {
  const workDir = resolve(opts.workDir);
  const projectCwd = resolve(opts.cwd);
  const unsafeTools = opts.unsafeTools === true;
  const forbiddenRoots = [workDir, ...discoverOpencodeForbiddenRoots(projectCwd)];
  const probeEnv = buildOpencodeChildEnv({
    workDir,
    cwd: projectCwd,
    unsafeTools: false,
    launchBase: opts.launchBase,
    credentialMode: "probe",
    managedPolicyMode: "redirect-only",
  });
  let binaryAttestation: PinnedOpencodeBinaryAttestation | undefined;
  try {
    const probeCwd = revalidateOpencodeChildLaunch(workDir, probeEnv);
    binaryAttestation = resolvePinnedOpencodeBinaryAttestation({
      requestedBinary: opts.binary,
      expectedVersion: opts.expectedVersion,
      searchPath: opts.binarySearchPath,
      probeEnv,
      probeCwd,
      forbiddenRoots,
    });
  } finally {
    if (!discardUnspawnedOpencodeChildEnv(workDir, probeEnv)) {
      throw new Error("opencode copresence failed to discard credential-free version-probe root");
    }
  }
  if (!binaryAttestation) throw new Error("opencode copresence version probe returned no accepted binary");

  const childEnv = buildOpencodeChildEnv({
    workDir,
    cwd: projectCwd,
    unsafeTools,
    launchBase: opts.launchBase,
    credentialMode: "runtime",
  });
  let core: OpenCodeCopresenceSession | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return true;
    const removed = cleanupOpencodeChildEnv(workDir, childEnv);
    if (removed) cleaned = true;
    return removed;
  };
  try {
    const effectiveCwd = revalidateOpencodeChildLaunch(workDir, childEnv);
    const binary = revalidatePinnedOpencodeBinary(binaryAttestation, {
      expectedVersion: opts.expectedVersion,
      forbiddenRoots,
    });
    core = await openVettedOpenCodeCopresence({
      binary,
      env: childEnv,
      cwd: effectiveCwd,
      workDir,
      model: opts.model,
      title: opts.title,
      startupTimeoutMs: opts.startupTimeoutMs,
      log: opts.log,
      warn: opts.warn,
    });
    await opts.onSession?.(core.sessionId);
    const wrapped: OpenCodeCopresenceSession = {
      get url() { return core!.url; },
      get sessionId() { return core!.sessionId; },
      get attachScriptPath() { return core!.attachScriptPath; },
      get isRunning() { return core!.isRunning; },
      notify: (message, timeoutMs) => core!.notify(message, timeoutMs),
      submit: (prompt, timeoutMs) => core!.submit(prompt, timeoutMs),
      async close() {
        await core!.close();
        if (!cleanup()) {
          opts.warn?.("[opencode-copresence] launch-root cleanup deferred; a live descendant still references it");
        }
      },
    };
    return wrapped;
  } catch (error) {
    await core?.close().catch(() => {});
    cleanup();
    throw error;
  }
}
