import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { SQLiteAdapter } from "./db-adapter.js";
import {
  SideThreadCoordinator,
  SideThreadError,
  SideThreadStore,
  UnsupportedSideThreadPort,
  type SideThreadActor,
  type SideThreadExecutionPort,
  type SideThreadRuntimeEvent,
} from "./side-thread.js";
import { handleSideThreadHttpRequest } from "./side-thread-http.js";

const contractGolden = JSON.parse(
  readFileSync(
    new URL("../../contracts/side-thread/v1/golden.json", import.meta.url),
    "utf8",
  ),
);
const contractSchema = JSON.parse(
  readFileSync(
    new URL("../../contracts/side-thread/v1/schema.json", import.meta.url),
    "utf8",
  ),
);

function jsonShape(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(jsonShape);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        jsonShape(entry),
      ]),
    );
  return typeof value;
}

const owner: SideThreadActor = {
  userId: "usr_owner",
  username: "owner",
  tokenId: "tok_owner_1",
  kind: "user",
};
const stranger: SideThreadActor = {
  userId: "usr_other",
  username: "other",
  tokenId: "tok_other_1",
  kind: "user",
};
const nodeActor: SideThreadActor = {
  userId: "usr_owner",
  username: "owner",
  tokenId: "tok_node_1",
  kind: "node",
  boundNetworkId: "net_a",
  boundNodeId: "node_a",
};

class FakePort implements SideThreadExecutionPort {
  listeners = new Set<(event: SideThreadRuntimeEvent) => void>();
  calls = { fork: 0, start: 0, cancel: 0, archive: 0, purge: 0, bringBack: 0 };
  turn = 0;
  onStart?: (
    input: Parameters<SideThreadExecutionPort["start"]>[0],
    turnId: string,
  ) => void;
  capability() {
    return {
      supported: true,
      mode: "native-exact-fork" as const,
      runtime: "codex",
      runtimeVersion: "0.148.0",
      topology: "owned-stdio",
      evidenceRevision: "reviewed",
      exactBoundary: { through: true, before: true },
    };
  }
  async fork(input: Parameters<SideThreadExecutionPort["fork"]>[0]) {
    this.calls.fork++;
    return { threadId: `derived_${input.sideChatId}` };
  }
  async start(input: Parameters<SideThreadExecutionPort["start"]>[0]) {
    this.calls.start++;
    const turnId = `turn_${++this.turn}`;
    this.onStart?.(input, turnId);
    return { turnId };
  }
  async cancel() {
    this.calls.cancel++;
  }
  async archive() {
    this.calls.archive++;
  }
  async purge() {
    this.calls.purge++;
  }
  async bringBack() {
    this.calls.bringBack++;
    return { destinationTurnId: `destination_${this.calls.bringBack}` };
  }
  subscribe(listener: (event: SideThreadRuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: SideThreadRuntimeEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function fixture(
  options: {
    enabled?: boolean;
    port?: SideThreadExecutionPort;
    attachment?: (fileId: string) => boolean;
  } = {},
) {
  const raw = new Database(":memory:");
  const db = new SQLiteAdapter(raw);
  const store = new SideThreadStore(db);
  const port = options.port ?? new FakePort();
  let serial = 0;
  const coordinator = new SideThreadCoordinator(store, port, {
    enabled: options.enabled ?? true,
    authorizeNode: (actor, networkId, nodeId) =>
      actor.userId === owner.userId &&
      networkId === "net_a" &&
      nodeId === "node_a" &&
      (actor.kind !== "node" || actor.boundNodeId === nodeId),
    authorizeAttachment: (_actor, networkId, ref) =>
      networkId === "net_a" && (options.attachment?.(ref.fileId) ?? true),
    now: () => 1_700_000_000_000 + serial,
    id: () => `id${++serial}`,
  });
  closers.push(
    () => coordinator.close(),
    () => db.close(),
  );
  return { db, store, port: port as FakePort, coordinator };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    requestKey: "create-key-0001",
    networkId: "net_a",
    nodeId: "node_a",
    sourceThreadId: "source_thread",
    boundary: { kind: "through" as const, turnId: "source_turn_5" },
    prompt: "原问题第一行\n完整问题必须跨窗口保留",
    attachments: [{ fileId: "file_ref_0001" }],
    ...overrides,
  };
}

describe("SideThread Hub contract", () => {
  test("feature flag and missing runtime adapter fail closed without a FIFO fallback", async () => {
    const disabled = fixture({ enabled: false });
    await expect(
      disabled.coordinator.create(owner, createInput()),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_DISABLED", status: 404 });
    expect(disabled.port.calls.fork).toBe(0);

    const unsupported = fixture({ port: new UnsupportedSideThreadPort() });
    await expect(
      unsupported.coordinator.create(owner, createInput()),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_UNSUPPORTED", status: 501 });
    expect(
      unsupported.db.get<{ n: number }>("SELECT COUNT(*) n FROM side_chats")?.n,
    ).toBe(0);

    const unverified = new FakePort();
    unverified.capability = () => ({
      supported: true,
      runtime: "codex",
      runtimeVersion: "unknown",
      topology: "shared",
      evidenceRevision: "unreviewed",
      exactBoundary: { through: true, before: true },
    });
    const unverifiedFixture = fixture({ port: unverified });
    await expect(
      unverifiedFixture.coordinator.create(owner, createInput()),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_UNSUPPORTED", status: 501 });
    expect(unverified.calls.fork).toBe(0);
  });

  test("create is payload-bound idempotent and stores exact four-part ownership", async () => {
    const f = fixture();
    const first = await f.coordinator.create(owner, createInput());
    const replay = await f.coordinator.create(owner, createInput());
    expect(replay.sideChatId).toBe(first.sideChatId);
    expect(f.port.calls).toMatchObject({ fork: 1, start: 1 });
    expect(first.state).toBe("running");
    expect(first.attempts[0]).toMatchObject({
      attemptId: first.activeAttemptId,
      threadId: first.threadId,
      turnId: "turn_1",
      state: "running",
    });
    await expect(
      f.coordinator.create(owner, createInput({ prompt: "different" })),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_CONFLICT" });
  });

  test("cross-window hydration returns the complete owner question and cross-owner reads are opaque", async () => {
    const f = fixture();
    const created = await f.coordinator.create(owner, createInput());
    f.coordinator.close();
    const reopened = new SideThreadCoordinator(
      new SideThreadStore(f.db),
      f.port,
      {
        enabled: true,
        authorizeNode: (actor, networkId, nodeId) =>
          actor.userId === owner.userId &&
          networkId === "net_a" &&
          nodeId === "node_a",
        authorizeAttachment: () => true,
      },
    );
    closers.push(() => reopened.close());
    expect(reopened.get(owner, created.sideChatId).question).toBe(
      createInput().prompt,
    );
    expect(() => reopened.get(stranger, created.sideChatId)).toThrow(
      new SideThreadError("SIDE_THREAD_NOT_FOUND", "side chat not found", 404),
    );
    expect(() =>
      reopened.get({ ...nodeActor, boundNodeId: "node_b" }, created.sideChatId),
    ).toThrow();
  });

  test("attachments accept authorized fileId references only", async () => {
    const f = fixture({ attachment: (id) => id === "file_ref_0001" });
    await f.coordinator.create(owner, createInput());
    await expect(
      f.coordinator.create(
        owner,
        createInput({
          requestKey: "create-key-0002",
          attachments: [{ fileId: "file_missing_01" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_ATTACHMENT_NOT_FOUND" });
    await expect(
      f.coordinator.create(
        owner,
        createInput({
          requestKey: "create-key-0003",
          attachments: [{ fileId: "file_ref_0001", path: "/etc/passwd" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_CONFLICT" });
  });

  test("terminal events require sideChatId + attemptId + threadId + turnId", async () => {
    const f = fixture();
    const r = await f.coordinator.create(owner, createInput());
    const a = r.attempts[0];
    f.port.emit({
      sideChatId: r.sideChatId,
      attemptId: a.attemptId,
      threadId: r.sourceThreadId,
      turnId: a.turnId!,
      status: "completed",
      text: "wrong source",
    });
    expect(f.coordinator.get(owner, r.sideChatId).state).toBe("running");
    f.port.emit({
      sideChatId: r.sideChatId,
      attemptId: a.attemptId,
      threadId: r.threadId!,
      turnId: "turn_sibling",
      status: "completed",
      text: "wrong turn",
    });
    expect(f.coordinator.get(owner, r.sideChatId).state).toBe("running");
    f.port.emit({
      sideChatId: r.sideChatId,
      attemptId: a.attemptId,
      threadId: r.threadId!,
      turnId: a.turnId!,
      status: "completed",
      text: "answer",
    });
    expect(f.coordinator.get(owner, r.sideChatId)).toMatchObject({
      state: "completed",
      activeAttemptId: undefined,
      attempts: [{ state: "completed", result: "answer" }],
    });
    f.port.emit({
      sideChatId: r.sideChatId,
      attemptId: a.attemptId,
      threadId: r.threadId!,
      turnId: a.turnId!,
      status: "failed",
      error: "late",
    });
    expect(f.coordinator.get(owner, r.sideChatId).state).toBe("completed");
    expect(
      f.coordinator
        .listEvents(owner, r.sideChatId)
        .filter((e) => e.type === "runtime_event.dropped"),
    ).toHaveLength(3);
  });

  test("a terminal event arriving before start returns settles once", async () => {
    const f = fixture();
    f.port.onStart = (input, turnId) =>
      f.port.emit({
        sideChatId: input.sideChatId,
        attemptId: input.attemptId,
        threadId: input.threadId,
        turnId,
        status: "completed",
        text: "fast",
      });
    const r = await f.coordinator.create(owner, createInput());
    expect(r).toMatchObject({
      state: "completed",
      activeAttemptId: undefined,
      attempts: [{ state: "completed", turnId: "turn_1", result: "fast" }],
    });
    expect(
      f.coordinator
        .listEvents(owner, r.sideChatId)
        .filter((e) => e.type === "attempt.terminal"),
    ).toHaveLength(1);
    expect(
      f.coordinator
        .listEvents(owner, r.sideChatId)
        .filter((e) => e.type === "attempt.running"),
    ).toHaveLength(0);
  });

  test("cancel is exact and cannot regress a terminal race", async () => {
    const f = fixture();
    const r = await f.coordinator.create(owner, createInput());
    const a = r.attempts[0];
    f.port.cancel = async () => {
      f.port.calls.cancel++;
      f.port.emit({
        sideChatId: r.sideChatId,
        attemptId: a.attemptId,
        threadId: r.threadId!,
        turnId: a.turnId!,
        status: "completed",
        text: "won race",
      });
    };
    const after = await f.coordinator.cancel(owner, r.sideChatId);
    expect(after.state).toBe("completed");
    expect(after.attempts[0].result).toBe("won race");
    expect(
      f.coordinator
        .listEvents(owner, r.sideChatId)
        .filter((e) => e.type === "attempt.cancelled"),
    ).toHaveLength(0);
  });

  test("cross-coordinator create and cancel claims execute the runtime once", async () => {
    const f = fixture();
    let forkEntered!: () => void;
    const entered = new Promise<void>((resolve) => (forkEntered = resolve));
    let releaseFork!: () => void;
    const forkGate = new Promise<void>((resolve) => (releaseFork = resolve));
    f.port.fork = async (input) => {
      f.port.calls.fork++;
      forkEntered();
      await forkGate;
      return { threadId: `derived_${input.sideChatId}` };
    };
    const second = new SideThreadCoordinator(f.store, f.port, {
      enabled: true,
      authorizeNode: (actor, networkId, nodeId) =>
        actor.userId === owner.userId &&
        networkId === "net_a" &&
        nodeId === "node_a",
      authorizeAttachment: () => true,
    });
    closers.push(() => second.close());
    const firstCreate = f.coordinator.create(owner, createInput());
    await entered;
    const replay = await second.create(owner, createInput());
    expect(replay.state).toBe("creating");
    releaseFork();
    const created = await firstCreate;
    expect(f.port.calls.fork).toBe(1);

    let cancelEntered!: () => void;
    const cancelStarted = new Promise<void>(
      (resolve) => (cancelEntered = resolve),
    );
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>(
      (resolve) => (releaseCancel = resolve),
    );
    f.port.cancel = async () => {
      f.port.calls.cancel++;
      cancelEntered();
      await cancelGate;
    };
    const firstCancel = f.coordinator.cancel(owner, created.sideChatId);
    await cancelStarted;
    const concurrent = await second.cancel(owner, created.sideChatId);
    expect(concurrent.state).toBe("running");
    expect(f.port.calls.cancel).toBe(1);
    releaseCancel();
    expect((await firstCancel).state).toBe("cancelled");

    let archiveEntered!: () => void;
    const archiveStarted = new Promise<void>(
      (resolve) => (archiveEntered = resolve),
    );
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>(
      (resolve) => (releaseArchive = resolve),
    );
    f.port.archive = async () => {
      f.port.calls.archive++;
      archiveEntered();
      await archiveGate;
    };
    const firstArchive = f.coordinator.archive(owner, created.sideChatId);
    await archiveStarted;
    await expect(
      second.archive(owner, created.sideChatId),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_CONFLICT" });
    expect(f.port.calls.archive).toBe(1);
    releaseArchive();
    expect((await firstArchive).state).toBe("archived");
  });

  test("retry persists parent attempt lineage and blocks concurrent active retries", async () => {
    const f = fixture();
    const r = await f.coordinator.create(owner, createInput());
    const first = r.attempts[0];
    f.port.emit({
      sideChatId: r.sideChatId,
      attemptId: first.attemptId,
      threadId: r.threadId!,
      turnId: first.turnId!,
      status: "failed",
      error: "boom",
    });
    const retried = await f.coordinator.retry(owner, r.sideChatId, {
      requestKey: "retry-key-0001",
      prompt: "try again",
    });
    expect(retried.attempts[1]).toMatchObject({
      parentAttemptId: first.attemptId,
      state: "running",
      threadId: r.threadId,
      turnId: "turn_2",
    });
    await expect(
      f.coordinator.retry(owner, r.sideChatId, {
        requestKey: "retry-key-0002",
        prompt: "parallel",
      }),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_CONFLICT" });
    const replay = await f.coordinator.retry(owner, r.sideChatId, {
      requestKey: "retry-key-0001",
      prompt: "try again",
    });
    expect(replay.attempts).toHaveLength(2);
    expect(f.port.calls.start).toBe(2);
  });

  test("archive/purge are terminal-safe and idempotent", async () => {
    const f = fixture();
    const r = await f.coordinator.create(owner, createInput());
    const a = r.attempts[0];
    await expect(
      f.coordinator.archive(owner, r.sideChatId),
    ).rejects.toMatchObject({
      code: "SIDE_THREAD_CONFLICT",
    });
    f.port.emit({
      sideChatId: r.sideChatId,
      attemptId: a.attemptId,
      threadId: r.threadId!,
      turnId: a.turnId!,
      status: "completed",
      text: "done",
    });
    expect((await f.coordinator.archive(owner, r.sideChatId)).state).toBe(
      "archived",
    );
    expect((await f.coordinator.archive(owner, r.sideChatId)).state).toBe(
      "archived",
    );
    expect((await f.coordinator.purge(owner, r.sideChatId)).state).toBe(
      "purged",
    );
    const purged = f.coordinator.get(owner, r.sideChatId);
    expect(purged.question).toBe("");
    expect(purged.attachments).toEqual([]);
    expect(purged.attempts[0].result).toBeUndefined();
    expect(f.port.calls).toMatchObject({ archive: 1, purge: 1 });
  });

  test("bring-back is completed-attempt-only and payload-bound idempotent", async () => {
    const f = fixture();
    const r = await f.coordinator.create(owner, createInput());
    const a = r.attempts[0];
    await expect(
      f.coordinator.bringBack(owner, r.sideChatId, {
        requestKey: "bring-key-0001",
        destinationThreadId: "source_thread",
      }),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_CONFLICT" });
    f.port.emit({
      sideChatId: r.sideChatId,
      attemptId: a.attemptId,
      threadId: r.threadId!,
      turnId: a.turnId!,
      status: "completed",
      text: "answer",
    });
    const one = await f.coordinator.bringBack(owner, r.sideChatId, {
      requestKey: "bring-key-0001",
      destinationThreadId: "source_thread",
    });
    const replay = await f.coordinator.bringBack(owner, r.sideChatId, {
      requestKey: "bring-key-0001",
      destinationThreadId: "source_thread",
    });
    expect(replay).toEqual(one);
    expect(f.port.calls.bringBack).toBe(1);
    const differentRequest = await f.coordinator.bringBack(
      owner,
      r.sideChatId,
      {
        requestKey: "bring-key-0002",
        destinationThreadId: "source_thread",
      },
    );
    expect(differentRequest).toEqual(one);
    expect(f.port.calls.bringBack).toBe(1);
    await expect(
      f.coordinator.bringBack(owner, r.sideChatId, {
        requestKey: "bring-key-0003",
        destinationThreadId: "other_thread",
      }),
    ).rejects.toMatchObject({ code: "SIDE_THREAD_CONFLICT" });

    f.coordinator.close();
    const reopened = new SideThreadCoordinator(f.store, f.port, {
      enabled: true,
      authorizeNode: (actor, networkId, nodeId) =>
        actor.userId === owner.userId &&
        networkId === "net_a" &&
        nodeId === "node_a",
      authorizeAttachment: () => true,
    });
    closers.push(() => reopened.close());
    const hydrated = reopened.get(owner, r.sideChatId);
    expect(hydrated.bringBacks).toHaveLength(1);
    expect(hydrated.bringBacks[0]).toMatchObject({
      attemptId: a.attemptId,
      destinationThreadId: "source_thread",
      destinationTurnId: one.destinationTurnId,
      requestKey: "bring-key-0001",
      state: "completed",
    });
    expect(hydrated.bringBacks[0].completedAt).toBeNumber();
    expect(reopened.list(owner)).toHaveLength(1);
    expect(reopened.list(stranger)).toHaveLength(0);
  });

  test("response loss is durable ambiguous and reconciles without a second start RPC", async () => {
    const port = new FakePort();
    let accepted: Parameters<SideThreadExecutionPort["start"]>[0] | undefined;
    port.start = async (input) => {
      port.calls.start++;
      accepted = input;
      throw Object.assign(new Error("secret transport detail"), {
        code: "SIDE_THREAD_RESPONSE_LOST",
      });
    };
    const f = fixture({ port });
    await expect(
      f.coordinator.create(owner, createInput()),
    ).rejects.toMatchObject({
      code: "SIDE_THREAD_AMBIGUOUS",
      operationId: expect.stringMatching(/^sop_/),
    });
    const ambiguous = f.store.getByCreateKey(owner, "create-key-0001")!.record;
    const startOperation = ambiguous.operations.find(
      (operation) => operation.kind === "start",
    )!;
    expect(ambiguous).toMatchObject({
      requestKey: "create-key-0001",
      state: "ambiguous",
      attempts: [{ state: "ambiguous" }],
    });
    expect(startOperation).toMatchObject({
      operationId: accepted!.operationId,
      state: "ambiguous",
      errorCode: "SIDE_THREAD_RESPONSE_LOST",
    });
    expect(await f.coordinator.create(owner, createInput())).toMatchObject({
      sideChatId: ambiguous.sideChatId,
      state: "ambiguous",
    });
    expect(port.calls).toMatchObject({ fork: 1, start: 1 });

    f.coordinator.close();
    const reopened = new SideThreadCoordinator(f.store, port, {
      enabled: true,
      authorizeNode: (actor, networkId, nodeId) =>
        actor.userId === owner.userId &&
        networkId === "net_a" &&
        nodeId === "node_a",
    });
    closers.push(() => reopened.close());
    port.emit({
      sideChatId: ambiguous.sideChatId,
      attemptId: accepted!.attemptId,
      threadId: accepted!.threadId,
      turnId: "turn_authoritative",
      status: "completed",
      text: "authoritative answer",
    });
    const reconciled = reopened.get(owner, ambiguous.sideChatId);
    expect(reconciled).toMatchObject({
      state: "completed",
      attempts: [{ state: "completed", result: "authoritative answer" }],
    });
    expect(
      reconciled.operations.find((operation) => operation.kind === "start"),
    ).toMatchObject({ state: "completed", turnId: "turn_authoritative" });
    expect(port.calls.start).toBe(1);
    expect(
      JSON.stringify(reopened.listEvents(owner, ambiguous.sideChatId)),
    ).not.toContain("secret transport detail");
  });

  test("ambiguous cancel/archive/purge keep stable claims and never issue a second RPC", async () => {
    const lose = () =>
      Object.assign(new Error("accepted but ACK lost"), {
        code: "SIDE_THREAD_RESPONSE_LOST",
      });

    const cancelPort = new FakePort();
    cancelPort.cancel = async () => {
      cancelPort.calls.cancel++;
      throw lose();
    };
    const cancelFixture = fixture({ port: cancelPort });
    const running = await cancelFixture.coordinator.create(
      owner,
      createInput(),
    );
    let cancelOperationId = "";
    try {
      await cancelFixture.coordinator.cancel(owner, running.sideChatId);
    } catch (error) {
      expect(error).toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
      cancelOperationId = (error as SideThreadError).operationId!;
    }
    await expect(
      cancelFixture.coordinator.cancel(owner, running.sideChatId),
    ).rejects.toMatchObject({
      code: "SIDE_THREAD_AMBIGUOUS",
      operationId: cancelOperationId,
    });
    expect(cancelPort.calls.cancel).toBe(1);

    for (const action of ["archive", "purge"] as const) {
      const port = new FakePort();
      port[action] = async () => {
        port.calls[action]++;
        throw lose();
      };
      const current = fixture({ port });
      const record = await current.coordinator.create(
        owner,
        createInput({ requestKey: `create-key-${action}` }),
      );
      const attempt = record.attempts[0];
      port.emit({
        sideChatId: record.sideChatId,
        attemptId: attempt.attemptId,
        threadId: record.threadId!,
        turnId: attempt.turnId!,
        status: "completed",
        text: "done",
      });
      let operationId = "";
      try {
        await current.coordinator[action](owner, record.sideChatId);
      } catch (error) {
        operationId = (error as SideThreadError).operationId!;
        expect(error).toMatchObject({ code: "SIDE_THREAD_AMBIGUOUS" });
      }
      await expect(
        current.coordinator[action](owner, record.sideChatId),
      ).rejects.toMatchObject({
        code: "SIDE_THREAD_AMBIGUOUS",
        operationId,
      });
      expect(port.calls[action]).toBe(1);
    }
  });
});

describe("SideThread HTTP contract", () => {
  test("authoritative vendorable golden fixtures cannot drift from HTTP projection", async () => {
    expect(Object.keys(contractSchema.$defs).sort()).toEqual(
      [
        "attachment",
        "attempt",
        "boundary",
        "bringBack",
        "bringBackRequest",
        "bringBackResponse",
        "capabilityResponse",
        "createRequest",
        "error",
        "operation",
        "recordCapability",
        "retryRequest",
        "sideThread",
        "sideThreadResponse",
        "sideThreadsResponse",
        "sseEvent",
      ].sort(),
    );
    const f = fixture();
    const capabilityReq = new Request(
      "http://hub/api/side-threads/capability?alias=node-a&networkId=net_a&sourceThreadId=source_thread&boundaryKind=through&boundaryTurnId=source_turn",
    );
    const capability = await handleSideThreadHttpRequest({
      req: capabilityReq,
      url: new URL(capabilityReq.url),
      actor: owner,
      coordinator: f.coordinator,
      resolveCapabilityTarget: () => ({ nodeId: "node_a", networkId: "net_a" }),
    });
    expect(await capability!.json()).toEqual(contractGolden.capabilityResponse);

    const request = new Request("http://hub/api/side-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contractGolden.requests.create),
    });
    const created = await handleSideThreadHttpRequest({
      req: request,
      url: new URL(request.url),
      actor: owner,
      coordinator: f.coordinator,
    });
    expect(jsonShape(await created!.json())).toEqual(
      jsonShape(contractGolden.sideThreadEnvelope),
    );
    const empty = fixture();
    const listReq = new Request("http://hub/api/side-threads");
    const listed = await handleSideThreadHttpRequest({
      req: listReq,
      url: new URL(listReq.url),
      actor: owner,
      coordinator: empty.coordinator,
    });
    expect(await listed!.json()).toEqual(contractGolden.listResponse);
  });

  test("routes use the stable REST shape and return owner-readable question", async () => {
    const f = fixture();
    const req = new Request("http://hub/api/side-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestKey: "create-key-http1",
        networkId: "net_a",
        nodeId: "node_a",
        sourceThreadId: "source_thread",
        boundary: { kind: "through", turnId: "source_turn" },
        prompt: "full question",
        attachments: [{ fileId: "file_ref_0001" }],
      }),
    });
    const created = await handleSideThreadHttpRequest({
      req,
      url: new URL(req.url),
      actor: owner,
      coordinator: f.coordinator,
    });
    expect(created?.status).toBe(201);
    const body = (await created!.json()) as any;
    expect(body.sideThread).toMatchObject({
      requestKey: "create-key-http1",
      question: "full question",
      title: "full question",
      state: "running",
    });
    const getReq = new Request(
      `http://hub/api/side-threads/${body.sideThread.sideThreadId}`,
    );
    const got = await handleSideThreadHttpRequest({
      req: getReq,
      url: new URL(getReq.url),
      actor: owner,
      coordinator: f.coordinator,
    });
    expect(((await got!.json()) as any).sideThread.question).toBe(
      "full question",
    );
    const listReq = new Request("http://hub/api/side-threads?network_id=net_a");
    const listed = await handleSideThreadHttpRequest({
      req: listReq,
      url: new URL(listReq.url),
      actor: owner,
      coordinator: f.coordinator,
    });
    expect((await listed!.json()) as any).toMatchObject({
      count: 1,
      sideThreads: [
        {
          question: "full question",
          bringBacks: [],
          operations: expect.any(Array),
        },
      ],
    });
    const denied = await handleSideThreadHttpRequest({
      req: getReq,
      url: new URL(getReq.url),
      actor: stranger,
      coordinator: f.coordinator,
    });
    expect(denied?.status).toBe(404);
  });

  test("disabled surface is 404 before auth and unsupported adapter is typed 501", async () => {
    const off = fixture({ enabled: false });
    const getReq = new Request("http://hub/api/side-threads/anything");
    expect(
      (
        await handleSideThreadHttpRequest({
          req: getReq,
          url: new URL(getReq.url),
          actor: null,
          coordinator: off.coordinator,
        })
      )?.status,
    ).toBe(404);
    const unsupported = fixture({ port: new UnsupportedSideThreadPort() });
    const req = new Request("http://hub/api/side-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_key: "create-key-http2",
        network_id: "net_a",
        node_id: "node_a",
        source_thread_id: "source_thread",
        boundary: { kind: "through", turn_id: "source_turn" },
        prompt: "question",
      }),
    });
    const response = await handleSideThreadHttpRequest({
      req,
      url: new URL(req.url),
      actor: owner,
      coordinator: unsupported.coordinator,
    });
    expect(response?.status).toBe(501);
    expect(await response!.json()).toMatchObject({
      error: "SIDE_THREAD_UNSUPPORTED",
    });
  });

  test("capability flips and ambiguous runtime identities are typed failures", async () => {
    const flippedPort = new FakePort();
    flippedPort.fork = async () => {
      const error = new Error("capability disappeared");
      (error as any).code = "SIDE_THREAD_UNSUPPORTED";
      throw error;
    };
    const flipped = fixture({ port: flippedPort });
    const flipReq = new Request("http://hub/api/side-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_key: "create-key-flip1",
        network_id: "net_a",
        node_id: "node_a",
        source_thread_id: "source_thread",
        boundary: { kind: "through", turn_id: "source_turn" },
        prompt: "flip",
      }),
    });
    const flipResponse = await handleSideThreadHttpRequest({
      req: flipReq,
      url: new URL(flipReq.url),
      actor: owner,
      coordinator: flipped.coordinator,
    });
    expect(flipResponse?.status).toBe(501);
    expect(await flipResponse!.json()).toMatchObject({
      error: "SIDE_THREAD_UNSUPPORTED",
    });

    const ambiguousPort = new FakePort();
    ambiguousPort.fork = async () => ({ threadId: undefined as any });
    const ambiguous = fixture({ port: ambiguousPort });
    const ambiguousReq = new Request("http://hub/api/side-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_key: "create-key-ambig1",
        network_id: "net_a",
        node_id: "node_a",
        source_thread_id: "source_thread",
        boundary: { kind: "through", turn_id: "source_turn" },
        prompt: "ambiguous",
      }),
    });
    const ambiguousResponse = await handleSideThreadHttpRequest({
      req: ambiguousReq,
      url: new URL(ambiguousReq.url),
      actor: owner,
      coordinator: ambiguous.coordinator,
    });
    expect(ambiguousResponse?.status).toBe(202);
    expect(await ambiguousResponse!.json()).toMatchObject({
      error: "SIDE_THREAD_AMBIGUOUS",
      operationId: expect.stringMatching(/^sop_/),
      sideThreadId: expect.stringMatching(/^sch_/),
      attemptId: expect.stringMatching(/^sat_/),
    });
    expect(
      ambiguous.store.getByCreateKey(owner, "create-key-ambig1")?.record.state,
    ).toBe("ambiguous");
  });
});
