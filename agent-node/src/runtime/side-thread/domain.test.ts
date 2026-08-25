import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  SideThreadConflictError, SideThreadService, SideThreadUnsupportedError,
  type SideThreadCapability, type SideThreadRuntimeAdapter, type SideThreadTerminalEvent,
} from "./domain";

class FakeAdapter extends EventEmitter implements SideThreadRuntimeAdapter {
  cap: SideThreadCapability = { supported: true, runtime: "fake", runtimeVersion: "1", mode: "native-exact-fork", exactBoundary: { through: true, before: true } };
  forks = 0; starts = 0; cancels: unknown[] = []; archives = 0; deletes = 0;
  terminalDuringStart = false;
  capability() { return this.cap; }
  async fork(input: { sideThreadId: string }) { this.forks++; return { derivedThreadId: `derived-${input.sideThreadId}` }; }
  async start(input: { sideThreadId: string; attemptId: string; derivedThreadId: string }) {
    this.starts++;
    const turnId = `turn-${input.attemptId}`;
    if (this.terminalDuringStart) this.terminal({
      sideThreadId: input.sideThreadId, attemptId: input.attemptId,
      threadId: input.derivedThreadId, turnId, status: "completed", text: "fast",
    });
    return { turnId };
  }
  async cancel(input: unknown) { this.cancels.push(input); }
  async archive() { this.archives++; }
  async delete() { this.deletes++; }
  subscribe(listener: (event: SideThreadTerminalEvent) => void) { this.on("terminal", listener); return () => this.off("terminal", listener); }
  terminal(event: SideThreadTerminalEvent) { this.emit("terminal", event); }
}

const ids = () => { let n = 0; return () => `id-${++n}`; };
const createInput = { requestKey: "create-key-0001", nodeId: "node-1", sourceThreadId: "source-1", boundary: { kind: "through", turnId: "main-turn-1" } as const };

describe("SideThreadService", () => {
  test("fails closed before fork for unsupported capability", async () => {
    const adapter = new FakeAdapter();
    adapter.cap = { supported: false, runtime: "claude", runtimeVersion: "x", reason: "runtime" };
    const service = new SideThreadService({ adapter, id: ids() });
    await expect(service.create(createInput)).rejects.toBeInstanceOf(SideThreadUnsupportedError);
    expect(adapter.forks).toBe(0);
  });

  test("concurrent create and attempt request keys are idempotent", async () => {
    const adapter = new FakeAdapter();
    const service = new SideThreadService({ adapter, id: ids() });
    const [a, b] = await Promise.all([service.create(createInput), service.create(createInput)]);
    expect(a.id).toBe(b.id);
    expect(adapter.forks).toBe(1);
    const [x, y] = await Promise.all([
      service.startAttempt({ sideThreadId: a.id, requestKey: "attempt-key-0001", prompt: "secret prompt" }),
      service.startAttempt({ sideThreadId: a.id, requestKey: "attempt-key-0001", prompt: "secret prompt" }),
    ]);
    expect(x.id).toBe(y.id);
    expect(adapter.starts).toBe(1);
    await expect(service.create({ ...createInput, sourceThreadId: "different" }))
      .rejects.toThrow("idempotency key reused");
    await expect(service.startAttempt({ sideThreadId: a.id, requestKey: "attempt-key-0001", prompt: "different" }))
      .rejects.toThrow("idempotency key reused");
  });

  test("boundary-specific capability rejects before without blocking through", async () => {
    const adapter = new FakeAdapter();
    adapter.cap.exactBoundary = { through: true, before: false };
    const service = new SideThreadService({ adapter, id: ids() });
    await expect(service.create({ ...createInput, boundary: { kind: "before", turnId: "active" } }))
      .rejects.toMatchObject({ code: "SIDE_THREAD_UNSUPPORTED", reason: "experimental-api" });
    expect(adapter.forks).toBe(0);
    await expect(service.create(createInput)).resolves.toMatchObject({ sourceThreadId: "source-1" });
  });

  test("cancel uses exact derived thread and active turn", async () => {
    const adapter = new FakeAdapter();
    const service = new SideThreadService({ adapter, id: ids() });
    const side = await service.create(createInput);
    const attempt = await service.startAttempt({ sideThreadId: side.id, requestKey: "attempt-key-0002", prompt: "question" });
    await service.cancel(side.id);
    expect(adapter.cancels).toEqual([{ derivedThreadId: side.derivedThreadId, turnId: attempt.turnId }]);
    expect(adapter.cancels).not.toContainEqual(expect.objectContaining({ derivedThreadId: side.sourceThreadId }));
  });

  test("drops mismatched and stale terminal events without settling current attempt", async () => {
    const adapter = new FakeAdapter();
    const audit: any[] = [];
    const service = new SideThreadService({ adapter, id: ids(), audit: (e) => audit.push(e) });
    const side = await service.create(createInput);
    const first = await service.startAttempt({ sideThreadId: side.id, requestKey: "attempt-key-0003", prompt: "one" });
    adapter.terminal({ sideThreadId: side.id, attemptId: first.id, threadId: side.derivedThreadId, turnId: first.turnId!, status: "completed", text: "one" });
    const second = await service.startAttempt({ sideThreadId: side.id, requestKey: "attempt-key-0004", prompt: "two" });
    adapter.terminal({ sideThreadId: side.id, attemptId: first.id, threadId: side.derivedThreadId, turnId: first.turnId!, status: "completed", text: "late" });
    adapter.terminal({ sideThreadId: side.id, attemptId: second.id, threadId: side.sourceThreadId, turnId: second.turnId!, status: "completed", text: "wrong thread" });
    expect(service.get(side.id)?.activeAttemptId).toBe(second.id);
    expect(audit.filter((x) => x.action === "event_dropped")).toHaveLength(2);
    adapter.terminal({ sideThreadId: side.id, attemptId: second.id, threadId: side.derivedThreadId, turnId: second.turnId!, status: "completed", text: "two" });
    expect(service.get(side.id)?.state).toBe("completed");
  });

  test("terminal racing start return settles the same attempt once", async () => {
    const adapter = new FakeAdapter(); adapter.terminalDuringStart = true;
    const service = new SideThreadService({ adapter, id: ids() });
    const side = await service.create(createInput);
    const attempt = await service.startAttempt({ sideThreadId: side.id, requestKey: "attempt-key-fast", prompt: "fast" });
    expect(attempt).toMatchObject({ state: "completed", result: "fast" });
    expect(service.get(side.id)).toMatchObject({ state: "completed", activeAttemptId: undefined });
  });

  test("archive is idempotent, purge is owned and refuses running turns", async () => {
    const adapter = new FakeAdapter();
    const service = new SideThreadService({ adapter, id: ids() });
    const side = await service.create(createInput);
    const attempt = await service.startAttempt({ sideThreadId: side.id, requestKey: "attempt-key-0005", prompt: "one" });
    await expect(service.purge(side.id)).rejects.toBeInstanceOf(SideThreadConflictError);
    adapter.terminal({ sideThreadId: side.id, attemptId: attempt.id, threadId: side.derivedThreadId, turnId: attempt.turnId!, status: "completed" });
    await service.archive(side.id); await service.archive(side.id);
    expect(adapter.archives).toBe(1);
    await service.purge(side.id); await service.purge(side.id);
    expect(adapter.deletes).toBe(1);
  });

  test("audit is field-minimized and never contains prompt", async () => {
    const adapter = new FakeAdapter();
    const audit: any[] = [];
    const service = new SideThreadService({ adapter, id: ids(), audit: (e) => audit.push(e) });
    const side = await service.create(createInput);
    await service.startAttempt({ sideThreadId: side.id, requestKey: "attempt-key-0006", prompt: "TOP-SECRET-PROMPT" });
    expect(JSON.stringify(audit)).not.toContain("TOP-SECRET-PROMPT");
    expect(audit.every((x) => !Object.hasOwn(x, "prompt") && !Object.hasOwn(x, "result"))).toBe(true);
  });

  test("close removes subscription and refuses new mutations", async () => {
    const adapter = new FakeAdapter();
    const service = new SideThreadService({ adapter, id: ids() });
    expect(adapter.listenerCount("terminal")).toBe(1);
    service.close(); service.close();
    expect(adapter.listenerCount("terminal")).toBe(0);
    await expect(service.create(createInput)).rejects.toThrow("service is closed");
  });
});
