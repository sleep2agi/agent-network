import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionSideThreadNode } from "./production";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class StubCodex extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  threads = new Map<string, any>([["source", { id: "source", turns: [{ id: "source-turn" }] }]]);
  async request<T>(method: string, params: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "thread/list") return { data: [...this.threads.values()], nextCursor: null } as T;
    if (method === "thread/read") return { thread: this.threads.get(params.threadId) } as T;
    if (method === "thread/fork") {
      const thread = { id: "derived", forkedFromId: params.threadId, turns: [{ id: params.lastTurnId }] };
      this.threads.set(thread.id, thread); return { thread } as T;
    }
    if (method === "turn/start") {
      const turnId = params.threadId === "source" ? "bring-back-turn" : "derived-turn";
      if (params.clientUserMessageId?.startsWith("anet-side:")) await new Promise<void>((resolve) => queueMicrotask(() => {
        this.emit("item/started", {
          threadId: params.threadId, turnId,
          item: { type: "userMessage", clientId: params.clientUserMessageId },
        });
        resolve();
      }));
      return { turn: { id: turnId } } as T;
    }
    return {} as T;
  }
}

const base = (kind: string, payload: any, attemptId: string | null = null) => ({
  protocol: "side_thread.command.v1", commandId: `cmd-${kind}`, operationId: `op-${kind}`,
  requestKey: `request-${kind}`, nodeId: "node-1", sideThreadId: "side-1", attemptId, kind, payload,
});

describe("production SideThread node wiring", () => {
  test("real startup consumer uses only dedicated outbox and executes fork/start/bring-back", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "side-prod-")); roots.push(codexHome);
    const client = new StubCodex();
    const image = Buffer.from("real image bytes");
    const imageSha = createHash("sha256").update(image).digest("hex");
    const commands = [
      base("fork", { sourceThreadId: "source", boundary: { kind: "through", turnId: "source-turn" } }),
      base("start", { threadId: "derived", question: "side question", attachments: [{
        fileId: "file12345678", grantId: "grant-1", sha256: imageSha, size: image.length, mediaType: "image/png",
      }] }, "attempt-1"),
      base("bring-back", { sourceThreadId: "derived", sourceTurnId: "derived-turn", destinationThreadId: "source", text: "side answer" }, "attempt-1"),
    ];
    const requests: Array<{ url: string; method: string; body?: any }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });
      if (url.endsWith("/api/side-thread/attachment-grants/grant-1")) return new Response(image, {
        headers: { "Content-Type": "image/png", "Content-Length": String(image.length) },
      });
      if (url.endsWith("/pending")) return Response.json({ ok: true, command: commands.shift() ?? null });
      if (url.endsWith("/ack")) return Response.json({ ok: true });
      if (url.endsWith("/terminals")) return Response.json({ ok: true });
      return Response.json({ ok: false }, { status: 404 });
    };
    const runtime = createProductionSideThreadNode({
      enabled: true, client, hubUrl: "https://hub.invalid", nodeId: "node-1", token: "ntok_bound",
      codexHome, runtimeVersion: "0.148.0", topology: "owned-stdio", experimentalApi: false,
      pollMs: 5, fetchImpl: fetchImpl as typeof fetch,
    });
    try {
      for (let n = 0; n < 100 && requests.filter((x) => x.url.endsWith("/ack")).length < 3; n++) await Bun.sleep(5);
      expect(runtime.capability).toMatchObject({ supported: true, exactBoundary: { through: true, before: false } });
      expect(requests.filter((x) => x.url.endsWith("/ack")).map((x) => x.body.state)).toEqual(["accepted", "accepted", "accepted"]);
      expect(requests.every((x) => x.url.includes("/side-thread-commands") || x.url.includes("/side-thread/attachment-grants/"))).toBe(true);
      expect(client.calls.filter((x) => x.method === "thread/fork")).toHaveLength(1);
      expect(client.calls.filter((x) => x.method === "turn/start")).toHaveLength(2);
      const sideStart = client.calls.find((x) => x.params.clientUserMessageId?.startsWith("anet-side:"));
      expect(sideStart?.params.input[0]).toEqual({ type: "text", text: "side question" });
      expect(sideStart?.params.input[1]).toMatchObject({ type: "localImage" });
      expect(sideStart?.params.input[1].path.startsWith(join(codexHome, "agent-network-side-threads", "node-1", "attachments"))).toBe(true);
      expect(statSync(sideStart?.params.input[1].path).mode & 0o777).toBe(0o600);
      expect(client.calls.find((x) => x.params.clientUserMessageId?.startsWith("anet-btw-bring-back:"))?.params.input[0].text)
        .toBe("[BTW bring-back]\nside answer");
    } finally { runtime.close(); }
  });

  test("shared remote topology fails closed before polling or mutation", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "side-prod-shared-")); roots.push(codexHome);
    const client = new StubCodex(); let fetches = 0;
    const runtime = createProductionSideThreadNode({
      enabled: true, client, hubUrl: "https://hub.invalid", nodeId: "node-1", token: "ntok_bound",
      codexHome, runtimeVersion: "0.148.0", topology: "shared-websocket", experimentalApi: true,
      fetchImpl: (async () => { fetches++; return Response.json({ ok: true, command: null }); }) as typeof fetch,
    });
    expect(runtime).toMatchObject({ enabled: false, capability: { supported: false, reason: "topology" } });
    await Bun.sleep(5);
    expect(fetches).toBe(0); expect(client.calls).toHaveLength(0);
  });
});
