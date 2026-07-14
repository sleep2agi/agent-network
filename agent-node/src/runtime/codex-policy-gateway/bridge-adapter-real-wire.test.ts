// RFC-030 Stage 2 — BridgeAdapter evidence against the generated Codex
// app-server 0.144 types. These fixtures intentionally use the generated
// nested `turn` shapes rather than the older flat fake-server convention.

import { EventEmitter } from "events";
import { describe, expect, test } from "bun:test";
import type { AgentMessageDeltaNotification } from "../../types/codex/v2/AgentMessageDeltaNotification";
import type { ItemCompletedNotification } from "../../types/codex/v2/ItemCompletedNotification";
import type { Turn } from "../../types/codex/v2/Turn";
import type { TurnCompletedNotification } from "../../types/codex/v2/TurnCompletedNotification";
import type { TurnStartedNotification } from "../../types/codex/v2/TurnStartedNotification";
import type { TurnStartResponse } from "../../types/codex/v2/TurnStartResponse";
import { asMessageId, asTaskId, type AuthenticatedSender } from "./contract";
import { BridgeAdapter, type UpstreamRpcLike } from "./bridge-adapter";
import { GatewayLedger } from "./ledger";
import { GatewayScheduler } from "./scheduler";
import { resolveSqliteDriver } from "./sqlite-driver";

const THREAD_ID = "thread-real-0144";

const SENDER: AuthenticatedSender = {
  alias: "reviewer",
  tokenId: "tok_real_wire_fixture",
  role: "member",
  networkId: "net_default",
};

function turn(
  id: string,
  status: Turn["status"] = "inProgress",
  error: Turn["error"] = null,
): Turn {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1_000,
  };
}

class FakeRpc extends EventEmitter implements UpstreamRpcLike {
  constructor(
    private readonly requestImpl: (
      method: string,
      params?: unknown,
      timeoutMs?: number,
    ) => Promise<unknown>,
  ) {
    super();
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.requestImpl(method, params, timeoutMs) as Promise<T>;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await tick();
  }
}

describe("BridgeAdapter — real Codex 0.144 wire", () => {
  test("nested response + early real notifications preserve final_answer", async () => {
    let resolveStart!: (value: TurnStartResponse) => void;
    const startResponse = new Promise<TurnStartResponse>((resolve) => {
      resolveStart = resolve;
    });
    const rpc = new FakeRpc(async (method) => {
      expect(method).toBe("turn/start");
      return startResponse;
    });
    const finished: Array<{
      submissionId: string;
      result: { ok: true; replyText: string } | { ok: false; error: string };
    }> = [];
    const adapter = new BridgeAdapter({ client: rpc, threadId: THREAD_ID });
    adapter.bindScheduler({
      onAgentTurnFinished: (submissionId: string, result: typeof finished[number]["result"]) => {
        finished.push({ submissionId, result });
      },
    } as unknown as GatewayScheduler);

    const dispatch = adapter.startTurn({
      submissionId: "submission-real-1",
      taskId: "task-real-1",
      text: "work",
      fromAlias: "reviewer",
      clientUserMessageId: "anet:message-real-1",
    });
    await tick();

    const started: TurnStartedNotification = {
      threadId: THREAD_ID,
      turn: turn("turn-real-1"),
    };
    const delta: AgentMessageDeltaNotification = {
      threadId: THREAD_ID,
      turnId: "turn-real-1",
      itemId: "agent-item-real-1",
      delta: "draft text that must lose to final_answer",
    };
    const itemCompleted: ItemCompletedNotification = {
      threadId: THREAD_ID,
      turnId: "turn-real-1",
      completedAtMs: 2_000,
      item: {
        type: "agentMessage",
        id: "agent-item-real-1",
        text: "authoritative final answer",
        phase: "final_answer",
        memoryCitation: null,
      },
    };
    const completed: TurnCompletedNotification = {
      threadId: THREAD_ID,
      turn: turn("turn-real-1", "completed"),
    };

    // Notifications may beat the request response. They are buffered, but
    // cannot settle acceptance without the matching response's nested id.
    rpc.emit("turn/started", started);
    rpc.emit("item/agentMessage/delta", delta);
    rpc.emit("item/completed", itemCompleted);
    rpc.emit("turn/completed", completed);
    expect(finished).toHaveLength(0);

    resolveStart({ turn: turn("turn-real-1") });
    expect(await dispatch).toEqual({ kind: "accepted", turnId: "turn-real-1" });
    await tick();
    expect(finished).toEqual([
      {
        submissionId: "submission-real-1",
        result: { ok: true, replyText: "authoritative final answer" },
      },
    ]);
  });

  test("plain-string deltas are the fallback when no final_answer item arrives", async () => {
    const rpc = new FakeRpc(async () => ({ turn: turn("turn-real-2") } satisfies TurnStartResponse));
    const finished: Array<{ ok: true; replyText: string } | { ok: false; error: string }> = [];
    const adapter = new BridgeAdapter({ client: rpc, threadId: THREAD_ID });
    adapter.bindScheduler({
      onAgentTurnFinished: (_submissionId: string, result: typeof finished[number]) => {
        finished.push(result);
      },
    } as unknown as GatewayScheduler);

    expect(
      await adapter.startTurn({
        submissionId: "submission-real-2",
        taskId: "task-real-2",
        text: "work",
        fromAlias: "reviewer",
        clientUserMessageId: "anet:message-real-2",
      }),
    ).toEqual({ kind: "accepted", turnId: "turn-real-2" });
    rpc.emit("turn/started", {
      threadId: THREAD_ID,
      turn: turn("turn-real-2"),
    } satisfies TurnStartedNotification);
    rpc.emit("item/agentMessage/delta", {
      threadId: THREAD_ID,
      turnId: "turn-real-2",
      itemId: "agent-item-real-2",
      delta: "hello ",
    } satisfies AgentMessageDeltaNotification);
    rpc.emit("item/agentMessage/delta", {
      threadId: THREAD_ID,
      turnId: "turn-real-2",
      itemId: "agent-item-real-2",
      delta: "world",
    } satisfies AgentMessageDeltaNotification);
    rpc.emit("turn/completed", {
      threadId: THREAD_ID,
      turn: turn("turn-real-2", "completed"),
    } satisfies TurnCompletedNotification);

    expect(finished).toEqual([{ ok: true, replyText: "hello world" }]);
  });

  test("malformed nested response fails closed instead of trusting a flat fallback", async () => {
    const rpc = new FakeRpc(async () => ({
      turn: { id: "" },
      turnId: "attacker-controlled-flat-id",
    }));
    const adapter = new BridgeAdapter({ client: rpc, threadId: THREAD_ID });

    expect(
      await adapter.startTurn({
        submissionId: "submission-malformed",
        taskId: "task-malformed",
        text: "work",
        fromAlias: "reviewer",
        clientUserMessageId: "anet:message-malformed",
      }),
    ).toEqual({ kind: "failed", error: "turn/start response missing turn.id" });
  });

  test("R2 canary: turn error detail reaches neither log, ledger, nor client state", async () => {
    const canaryMessage = "R2_CANARY_message_ntok_deadbeef_/private/path";
    const canaryData = "R2_CANARY_data_super_secret";
    const logs: string[] = [];
    const rpc = new FakeRpc(async () => ({ turn: turn("turn-r2") } satisfies TurnStartResponse));
    const adapter = new BridgeAdapter({
      client: rpc,
      threadId: THREAD_ID,
      log: (line) => logs.push(line),
    });
    const ledger = new GatewayLedger(resolveSqliteDriver(":memory:").driver);
    const scheduler = new GatewayScheduler({
      ledger,
      dispatcher: adapter,
      ownerAttached: () => true,
    });
    adapter.bindScheduler(scheduler);

    await scheduler.enqueueTask({
      taskId: asTaskId("task-r2"),
      messageId: asMessageId("message-r2"),
      authenticatedSender: SENDER,
      text: "trigger upstream failure",
    });
    await waitFor(() => ledger.getLatestByTaskId("task-r2")?.state === "accepted");

    rpc.emit("turn/completed", {
      threadId: THREAD_ID,
      turn: {
        ...turn("turn-r2", "failed"),
        error: {
          message: canaryMessage,
          additionalDetails: canaryData,
          codexErrorInfo: { type: "Other", data: canaryData },
        },
      },
    });

    const row = ledger.getLatestByTaskId("task-r2");
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe("Gateway could not complete this task.");
    const clientState = await scheduler.getTaskState(asTaskId("task-r2"));
    const exposed = JSON.stringify({ logs, row, clientState });
    expect(exposed).not.toContain(canaryMessage);
    expect(exposed).not.toContain(canaryData);
    expect(exposed).not.toContain("ntok_deadbeef");
    expect(logs).toEqual([
      "[adapter] upstream failure cx-1 op=turn/completed class=upstream_turn_failed",
    ]);
  });
});
