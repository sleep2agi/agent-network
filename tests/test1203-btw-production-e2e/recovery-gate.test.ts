import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateFileCommandReceiptStore } from "../../agent-node/src/runtime/side-thread/command-receipts";
import { SideThreadCommandConsumer } from "../../agent-node/src/runtime/side-thread/command-consumer";
import { SideThreadCommandExecutor, SIDE_THREAD_COMMAND_PROTOCOL } from "../../agent-node/src/runtime/side-thread/command-transport";
import { PrivateFileForkLeaseStore } from "../../agent-node/src/runtime/side-thread/fork-lease";
import { JournaledBringBackExecutor } from "../../agent-node/src/runtime/side-thread/bring-back-journal";
import { materializeCommandAttachment } from "../../agent-node/src/runtime/side-thread/materialize-command-attachment";
import { PrivateFileTerminalOutbox } from "../../agent-node/src/runtime/side-thread/terminal-outbox";
import type { SideThreadRuntimeAdapter } from "../../agent-node/src/runtime/side-thread/domain";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(join(tmpdir(), "btw-prod-gate-")); roots.push(value); return value; };
const command = (kind: string, payload: unknown, attemptId: string | null = null) => ({
  protocol: SIDE_THREAD_COMMAND_PROTOCOL, commandId: `cmd-${kind}`, operationId: `op-${kind}`,
  requestKey: `rk-${kind}`, nodeId: "node-e2e", sideThreadId: "side-e2e", attemptId, kind, payload,
});

function fixture(dir = root()) {
  let forks = 0; let starts = 0; let listener: (event: any) => void = () => {};
  const adapter: SideThreadRuntimeAdapter = {
    capability: () => ({ supported: true, runtime: "codex-app-server", runtimeVersion: "0.148.0", topology: "owned-stdio", evidenceRevision: "test1190-wire-v2", mode: "native-exact-fork", exactBoundary: { through: true, before: true } }),
    async fork() { forks++; return { derivedThreadId: "derived-e2e" }; },
    async start() { starts++; return { turnId: "turn-e2e" }; },
    async cancel() {}, async archive() {}, async delete() {},
    subscribe(fn) { listener = fn; return () => { listener = () => {}; }; },
  };
  const terminalOutbox = new PrivateFileTerminalOutbox(join(dir, "terminal-wal"));
  const options = { nodeId: "node-e2e", adapter, receipts: new PrivateFileCommandReceiptStore(join(dir, "receipts")),
    claimExecution: (x: any) => new PrivateFileForkLeaseStore(join(dir, "claims")).claimOperation(x.nodeId, x.sideThreadId, x.operationId), terminalOutbox };
  return { dir, adapter, options, terminalOutbox, emit: (x: any) => listener(x), counts: () => ({ forks, starts }) };
}

describe("/btw production recovery gate", () => {
  test("ACK loss plus process restart replays receipt, never native fork", async () => {
    const f = fixture(); const raw = command("fork", { sourceThreadId: "main", boundary: { kind: "through", turnId: "boundary" } });
    let posts = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/pending")) return Response.json({ ok: true, command: raw });
      if (url.endsWith("/ack")) return ++posts === 1 ? new Response("lost", { status: 503 }) : Response.json({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const make = () => new SideThreadCommandConsumer({ hubUrl: "https://hub.invalid", nodeId: "node-e2e", token: "ntok_e2e", executor: new SideThreadCommandExecutor({ ...f.options, receipts: new PrivateFileCommandReceiptStore(join(f.dir, "receipts")) }), terminalOutbox: f.terminalOutbox, fetchImpl });
    await expect(make().trigger()).rejects.toThrow("ACK failed");
    await make().trigger();
    expect(f.counts().forks).toBe(1); expect(posts).toBe(2);
  });

  test("terminal WAL drains after restart before another command is pulled", async () => {
    const f = fixture(); new SideThreadCommandExecutor(f.options);
    f.emit({ sideThreadId: "side-e2e", attemptId: "attempt-e2e", threadId: "derived-e2e", turnId: "turn-e2e", status: "completed", text: "done", identityBound: true });
    await Bun.sleep(0); expect(f.terminalOutbox.list()).toHaveLength(1);
    const order: string[] = []; let terminalPosts = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/terminals")) { order.push("terminal"); return ++terminalPosts === 1 ? new Response("lost", { status: 503 }) : Response.json({ ok: true, idempotent: true }); }
      if (url.endsWith("/pending")) { order.push("pending"); return Response.json({ ok: true, command: null }); }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const make = () => new SideThreadCommandConsumer({ hubUrl: "https://hub.invalid", nodeId: "node-e2e", token: "ntok_e2e", executor: new SideThreadCommandExecutor(f.options), terminalOutbox: new PrivateFileTerminalOutbox(join(f.dir, "terminal-wal")), fetchImpl });
    await expect(make().trigger()).rejects.toThrow("terminal POST failed");
    await make().trigger();
    expect(order).toEqual(["terminal", "terminal", "pending"]); expect(f.terminalOutbox.list()).toHaveLength(0);
  });

  test("bring-back is exactly once on accepted replay and fail-closed on lost response", async () => {
    const dir = root(); let sends = 0;
    const accepted = new JournaledBringBackExecutor(join(dir, "accepted"), async () => ({ destinationTurnId: `ordinary-main-turn-${++sends}` }));
    const input = { operationId: "bring-accepted", destinationThreadId: "main", text: "BTW result" };
    expect(await accepted.execute(input)).toEqual({ destinationTurnId: "ordinary-main-turn-1" });
    expect(await new JournaledBringBackExecutor(join(dir, "accepted"), async () => ({ destinationTurnId: `duplicate-${++sends}` })).execute(input)).toEqual({ destinationTurnId: "ordinary-main-turn-1" });
    expect(sends).toBe(1);
    const lostRoot = join(dir, "lost"); let lostSends = 0;
    await expect(new JournaledBringBackExecutor(lostRoot, async () => { lostSends++; throw new Error("response lost"); }).execute({ ...input, operationId: "bring-lost" })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    await expect(new JournaledBringBackExecutor(lostRoot, async () => ({ destinationTurnId: `duplicate-${++lostSends}` })).execute({ ...input, operationId: "bring-lost" })).rejects.toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
    expect(lostSends).toBe(1);
  });

  test("attachment grant materializes exact bytes privately and rejects digest drift", async () => {
    const bytes = new TextEncoder().encode("e2e-image-fixture"); const sha256 = createHash("sha256").update(bytes).digest("hex"); const cache = join(root(), "cache");
    const grant = { fileId: "file_fixture", grantId: "grant_fixture", sha256, size: bytes.byteLength, mediaType: "image/png" };
    const result = await materializeCommandAttachment(grant, { hubUrl: "https://hub.invalid", nodeToken: "ntok_e2e", cacheDir: cache, fetchImpl: (async (_u, init) => {
      expect((init?.headers as any).Authorization).toBe("Bearer ntok_e2e"); return new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });
    }) as typeof fetch });
    expect(readFileSync(result.path)).toEqual(Buffer.from(bytes)); expect(statSync(result.path).mode & 0o777).toBe(0o600);
    await expect(materializeCommandAttachment({ ...grant, grantId: "grant_bad", sha256: "0".repeat(64) }, { hubUrl: "https://hub.invalid", nodeToken: "ntok_e2e", cacheDir: cache, fetchImpl: (async () => new Response(bytes)) as typeof fetch })).rejects.toThrow("digest mismatch");
  });

  test("persisted receipt drops unknown prompt fields and contains no bearer or local path", async () => {
    const f = fixture(); const prompt = "TOP_SECRET_PROMPT";
    await new SideThreadCommandExecutor(f.options).execute(command("fork", { sourceThreadId: "123e4567-e89b-42d3-a456-426614174000", boundary: { kind: "through", turnId: "boundary" }, prompt }));
    const persisted = readFileSync(join(f.dir, "receipts", "cmd-fork.json"), "utf8");
    expect(persisted).not.toContain(prompt); expect(persisted).not.toContain("ntok_"); expect(persisted).not.toContain("/home/");
  });
});
