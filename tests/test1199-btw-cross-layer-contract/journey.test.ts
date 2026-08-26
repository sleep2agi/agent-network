import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { SQLiteAdapter } from "../../server/src/db-adapter.js";
import {
  SideThreadCoordinator,
  SideThreadStore,
  type SideThreadActor,
  type SideThreadExecutionPort,
  type SideThreadRuntimeEvent,
} from "../../server/src/side-thread.js";
import { handleSideThreadHttpRequest } from "../../server/src/side-thread-http.js";

// These canonical bytes are vendored unchanged by agent-network-app PR #177.
// run.sh pins their hashes, so an uncoordinated Hub edit fails this suite.
const appGolden = JSON.parse(readFileSync(new URL("../../contracts/side-thread/v1/golden.json", import.meta.url), "utf8"));
const owner: SideThreadActor = { userId: "usr_app", username: "app", tokenId: "tok_app", kind: "user" };

class DedicatedNodePort implements SideThreadExecutionPort {
  listeners = new Set<(event: SideThreadRuntimeEvent) => void>();
  calls = { fork: 0, start: 0, cancel: 0, archive: 0, purge: 0, bringBack: 0 };
  starts: Array<Parameters<SideThreadExecutionPort["start"]>[0]> = [];
  cancels: Array<Parameters<SideThreadExecutionPort["cancel"]>[0]> = [];
  mainTurn = { threadId: "source_thread", turnId: "source_turn", state: "running", steer: 0, interrupt: 0 };
  loseNextStartAck = false;

  capability() {
    return { supported: true, mode: "native-exact-fork" as const, runtime: "codex", runtimeVersion: "0.148.0", topology: "owned-stdio", evidenceRevision: "reviewed", exactBoundary: { through: true, before: true } };
  }
  async fork(input: Parameters<SideThreadExecutionPort["fork"]>[0]) {
    this.calls.fork++;
    expect(input.sourceThreadId).toBe(this.mainTurn.threadId);
    expect(input.boundary).toEqual({ kind: "through", turnId: this.mainTurn.turnId });
    return { threadId: `derived_${input.sideChatId}` };
  }
  async start(input: Parameters<SideThreadExecutionPort["start"]>[0]) {
    this.calls.start++;
    this.starts.push(input);
    if (this.loseNextStartAck) {
      this.loseNextStartAck = false;
      throw Object.assign(new Error("ACK lost after runtime accepted"), { code: "SIDE_THREAD_RESPONSE_LOST" });
    }
    return { turnId: `turn_${input.attemptId}` };
  }
  async cancel(input: Parameters<SideThreadExecutionPort["cancel"]>[0]) { this.calls.cancel++; this.cancels.push(input); }
  async archive() { this.calls.archive++; }
  async purge() { this.calls.purge++; }
  async bringBack() { this.calls.bringBack++; return { destinationTurnId: `main_bring_${this.calls.bringBack}` }; }
  subscribe(listener: (event: SideThreadRuntimeEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  terminal(event: SideThreadRuntimeEvent) { for (const listener of this.listeners) listener(event); }
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function harness(port = new DedicatedNodePort()) {
  const raw = new Database(":memory:");
  const db = new SQLiteAdapter(raw);
  const store = new SideThreadStore(db);
  let serial = 0;
  const options = {
    enabled: true,
    authorizeNode: (actor: SideThreadActor, networkId: string, nodeId: string) => actor.userId === owner.userId && networkId === "net_a" && nodeId === "node_a",
    authorizeAttachment: (_actor: SideThreadActor, networkId: string, ref: { fileId: string }) => networkId === "net_a" && ref.fileId.startsWith("file_ref_"),
    now: () => 1_700_000_000_000 + serial,
    id: () => `e2e_${++serial}`,
  };
  const coordinator = new SideThreadCoordinator(store, port, options);
  cleanups.push(() => coordinator.close(), () => db.close());
  return { db, store, port, coordinator, options };
}

async function request(coordinator: SideThreadCoordinator, path: string, method = "GET", body?: unknown) {
  const req = new Request(`http://hub${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const response = await handleSideThreadHttpRequest({ req, url: new URL(req.url), actor: owner, coordinator });
  expect(response).not.toBeNull();
  return response!;
}

async function appCreate(coordinator: SideThreadCoordinator, overrides: Record<string, unknown> = {}) {
  const response = await request(coordinator, "/api/side-threads", "POST", { ...appGolden.requests.create, ...overrides });
  expect(response.status).toBe(201);
  return (await response.json() as any).sideThread;
}

describe("BTW App -> Hub -> dedicated node -> terminal -> App hydrate", () => {
  test("full create journey preserves exact boundary and attachment while the main turn is untouched", async () => {
    const h = harness();
    const created = await appCreate(h.coordinator);
    expect(h.port.starts).toHaveLength(1);
    expect(h.port.starts[0]).toMatchObject({
      prompt: appGolden.requests.create.question,
      attachments: appGolden.requests.create.attachments,
      threadId: created.threadId,
    });
    expect(h.port.mainTurn).toEqual({ threadId: "source_thread", turnId: "source_turn", state: "running", steer: 0, interrupt: 0 });

    const attempt = created.attempts[0];
    h.port.terminal({ sideChatId: created.sideThreadId, attemptId: attempt.attemptId, threadId: created.threadId, turnId: attempt.turnId, status: "completed", text: "side answer" });
    const hydrated = await request(h.coordinator, `/api/side-threads/${created.sideThreadId}`);
    expect((await hydrated.json() as any).sideThread).toMatchObject({ state: "completed", attempts: [{ state: "completed", result: "side answer" }] });
    expect(h.coordinator.listEvents(owner, created.sideThreadId).map(event => event.type)).toContain("attempt.terminal");
    expect(h.port.mainTurn.interrupt).toBe(0);
  });

  test("two BTW answers arriving out of order remain identity-isolated and cancel is local", async () => {
    const h = harness();
    const a = await appCreate(h.coordinator, { requestKey: "app:create:A", question: "question A", attachments: [] });
    const b = await appCreate(h.coordinator, { requestKey: "app:create:B", question: "question B", attachments: [] });
    h.port.terminal({ sideChatId: b.sideThreadId, attemptId: b.attempts[0].attemptId, threadId: b.threadId, turnId: b.attempts[0].turnId, status: "completed", text: "answer B first" });
    const cancel = await request(h.coordinator, `/api/side-threads/${a.sideThreadId}/cancel`, "POST", { requestKey: "app:cancel:A" });
    expect((await cancel.json() as any).sideThread.state).toBe("cancelled");
    const list = await request(h.coordinator, "/api/side-threads?network_id=net_a&node_id=node_a");
    const byId = new Map((await list.json() as any).sideThreads.map((record: any) => [record.sideThreadId, record]));
    expect(byId.get(a.sideThreadId)).toMatchObject({ question: "question A", state: "cancelled" });
    expect(byId.get(b.sideThreadId)).toMatchObject({ question: "question B", state: "completed", attempts: [{ result: "answer B first" }] });
    expect(h.port.cancels).toHaveLength(1);
    expect(h.port.cancels[0].sideChatId).toBe(a.sideThreadId);
    expect(h.port.mainTurn.interrupt).toBe(0);
  });

  test("lost start ACK survives coordinator restart and authoritative terminal reconciles without duplicate start", async () => {
    const h = harness();
    h.port.loseNextStartAck = true;
    const response = await request(h.coordinator, "/api/side-threads", "POST", { ...appGolden.requests.create, requestKey: "app:create:ack-loss", attachments: [] });
    expect(response.status).toBe(202);
    const ambiguous = await response.json() as any;
    expect(ambiguous.error).toBe("SIDE_THREAD_AMBIGUOUS");
    const accepted = h.port.starts[0];
    h.coordinator.close();
    const reopened = new SideThreadCoordinator(h.store, h.port, h.options);
    cleanups.push(() => reopened.close());

    const replay = await request(reopened, "/api/side-threads", "POST", { ...appGolden.requests.create, requestKey: "app:create:ack-loss", attachments: [] });
    expect(replay.status).toBe(201);
    expect((await replay.json() as any).sideThread.state).toBe("ambiguous");
    expect(h.port.calls.start).toBe(1);
    h.port.terminal({ sideChatId: accepted.sideChatId, attemptId: accepted.attemptId, threadId: accepted.threadId, turnId: "runtime_authoritative_turn", status: "completed", text: "recovered" });
    expect(reopened.get(owner, accepted.sideChatId)).toMatchObject({ state: "completed", attempts: [{ result: "recovered" }] });
    expect(h.port.calls.start).toBe(1);
  });

  test("bring-back is completed-only and exactly once across different request keys", async () => {
    const h = harness();
    const created = await appCreate(h.coordinator, { requestKey: "app:create:bring", attachments: [] });
    const attempt = created.attempts[0];
    h.port.terminal({ sideChatId: created.sideThreadId, attemptId: attempt.attemptId, threadId: created.threadId, turnId: attempt.turnId, status: "completed", text: "bring this" });
    const one = await request(h.coordinator, `/api/side-threads/${created.sideThreadId}/bring-back`, "POST", { requestKey: "app:bring:1", attemptId: attempt.attemptId, destinationThreadId: "source_thread" });
    expect(one.status).toBe(200);
    const first = await one.json();
    const replay = await request(h.coordinator, `/api/side-threads/${created.sideThreadId}/bring-back`, "POST", { requestKey: "app:bring:2", attemptId: attempt.attemptId, destinationThreadId: "source_thread" });
    expect(await replay.json()).toEqual(first);
    expect(h.port.calls.bringBack).toBe(1);
    expect(h.port.mainTurn.interrupt).toBe(0);
  });
});
