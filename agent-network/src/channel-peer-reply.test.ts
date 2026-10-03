import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { peerReplyFallbackReason, sendChannelPeerReply, validatePeerReplyInput } from "./channel-peer-reply";

type Call = { tool: string; args: Record<string, any> };

function fakeHub(responses: Record<string, any | ((args: any) => any)>) {
  const calls: Call[] = [];
  return {
    calls,
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args: args as any });
      const r = responses[tool];
      if (r === undefined) throw new Error(`unexpected tool ${tool}`);
      return typeof r === "function" ? r(args) : r;
    },
  };
}

const deps = (hub: ReturnType<typeof fakeHub>, extra: Record<string, unknown> = {}) => ({
  call: hub.call,
  fromAlias: "replier",
  originatorOf: (id: string) => (id === "inbox-1" ? "asker" : undefined),
  logicalTaskIdOf: (id: string) => (id === "inbox-1" ? "task-1" : undefined),
  ...extra,
});

describe("validatePeerReplyInput", () => {
  test("requires a single task id from the channel meta", () => {
    expect((validatePeerReplyInput({ text: "x" }) as any).error).toBe("task_id_required");
    expect((validatePeerReplyInput({ task_id: "  ", text: "x" }) as any).error).toBe("task_id_required");
    expect((validatePeerReplyInput({ task_id: "a b", text: "x" }) as any).error).toBe("task_id_invalid");
    expect((validatePeerReplyInput({ task_id: "hub", text: "x" }) as any).error).toBe("task_id_invalid");
    expect((validatePeerReplyInput({ task_id: "x".repeat(201), text: "x" }) as any).error).toBe("task_id_invalid");
    expect((validatePeerReplyInput({ task_id: 42 as any, text: "x" }) as any).error).toBe("task_id_required");
  });
  test("text and status", () => {
    expect((validatePeerReplyInput({ task_id: "t", text: " " }) as any).error).toBe("text_required");
    expect((validatePeerReplyInput({ task_id: "t", text: "x".repeat(10_001) }) as any).error).toBe("text_too_long");
    expect((validatePeerReplyInput({ task_id: "t", text: "x", status: "in_progress" }) as any).error).toBe("status_invalid");
    expect(validatePeerReplyInput({ task_id: "t", text: "x" })).toMatchObject({ ok: true, status: "completed" });
  });
  test("invalid input makes zero Hub calls", async () => {
    const hub = fakeHub({});
    const r = await sendChannelPeerReply({ text: "hi" }, deps(hub));
    expect(r).toMatchObject({ ok: false, closed: false, woke: false, error: "task_id_required" });
    expect(hub.calls).toEqual([]);
  });
});

describe("fallback classification", () => {
  test("capability rejections fall back; others do not", () => {
    for (const code of ["peer_reply_unsupported", "peer_reply_origin_not_node", "peer_reply_node_token_required", "reply_task_not_owned"]) {
      expect(peerReplyFallbackReason({ ok: false, error: code })).toBe(code);
    }
    expect(peerReplyFallbackReason({ ok: false, error: "MCP error -32602: Tool send_peer_reply not found" })).toBe("hub_without_send_peer_reply");
    for (const code of ["reply_task_terminal", "reply_task_not_found", "reply_target_mismatch", "init failed: 401", "MCP error -32602: bad text"]) {
      expect(peerReplyFallbackReason({ ok: false, error: code })).toBeNull();
    }
  });
});

describe("sendChannelPeerReply", () => {
  test("atomic: one send_peer_reply on the LOGICAL task id, nothing else", async () => {
    const hub = fakeHub({ send_peer_reply: { ok: true, message_id: "m1" } });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: true, route: "atomic", closed: true, woke: true, task_id: "task-1" });
    expect(hub.calls).toEqual([{ tool: "send_peer_reply", args: { alias: "asker", text: "done", in_reply_to: "task-1", status: "replied", from_session: "replier" } }]);
  });

  test("status=failed maps to the Hub's failed outcome", async () => {
    const hub = fakeHub({ send_peer_reply: { ok: true } });
    await sendChannelPeerReply({ task_id: "inbox-1", text: "no", status: "failed" }, deps(hub));
    expect(hub.calls[0].args.status).toBe("failed");
  });

  test("peer not capable: wake via send_task FIRST, then terminal send_reply", async () => {
    const hub = fakeHub({
      send_peer_reply: { ok: false, error: "peer_reply_unsupported" },
      send_task: { ok: true, task_id: "wake-1" },
      send_reply: { ok: true, message_id: "r1" },
    });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: true, route: "wake-then-close", closed: true, woke: true, wake_task_id: "wake-1", fallback_reason: "peer_reply_unsupported" });
    expect(hub.calls.map((c) => c.tool)).toEqual(["send_peer_reply", "send_task", "send_reply"]);
    expect(hub.calls[1].args).toEqual({ alias: "asker", task: "done", priority: "normal", from_session: "replier" });
    expect(hub.calls[2].args).toMatchObject({ in_reply_to: "task-1", status: "replied" });
  });

  test("old Hub without the tool takes the same two-step route", async () => {
    const hub = fakeHub({
      send_peer_reply: { ok: false, error: "MCP error -32602: Tool send_peer_reply not found" },
      send_task: { ok: true, task_id: "wake-1" },
      send_reply: { ok: true },
    });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: true, route: "wake-then-close", fallback_reason: "hub_without_send_peer_reply" });
  });

  test("wake fails: the original is NOT closed", async () => {
    const hub = fakeHub({
      send_peer_reply: { ok: false, error: "peer_reply_unsupported" },
      send_task: { ok: false, error: "alias_not_found" },
      send_reply: { ok: true },
    });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: false, closed: false, woke: false, error: "alias_not_found" });
    expect(r.message).toContain("Nothing was closed");
    expect(hub.calls.map((c) => c.tool)).toEqual(["send_peer_reply", "send_task"]);
  });

  test("close fails after wake: reported explicitly, no resend advice", async () => {
    const hub = fakeHub({
      send_peer_reply: { ok: false, error: "peer_reply_unsupported" },
      send_task: { ok: true, task_id: "wake-1" },
      send_reply: { ok: false, error: "reply_task_terminal", message: "already terminal" },
    });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: false, woke: true, closed: false, wake_task_id: "wake-1", error: "close_failed_after_wake:reply_task_terminal" });
    expect(r.message).toContain("WAS woken");
    expect(r.message).toContain("Do not resend");
  });

  test("Dashboard/human origin: terminal reply only, never a send_task", async () => {
    const hub = fakeHub({
      send_peer_reply: { ok: false, error: "peer_reply_origin_not_node" },
      send_reply: { ok: true },
    });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: true, route: "reply-only", closed: true });
    expect(hub.calls.map((c) => c.tool)).toEqual(["send_peer_reply", "send_reply"]);
  });

  test("non-capability rejection: no further writes", async () => {
    const hub = fakeHub({ send_peer_reply: { ok: false, error: "reply_task_terminal", message: "already terminal" } });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: false, closed: false, woke: false, error: "reply_task_terminal" });
    expect(hub.calls).toHaveLength(1);
  });

  test("transport error on the atomic call never falls back (ambiguous)", async () => {
    const hub = fakeHub({ send_peer_reply: () => { throw new Error("ECONNRESET"); } });
    const r = await sendChannelPeerReply({ task_id: "inbox-1", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: false, error: "transport_error", closed: false, woke: false });
    expect(hub.calls).toHaveLength(1);
  });

  test("unknown originator after restart: asks for alias, sends nothing beyond the atomic try", async () => {
    const hub = fakeHub({ send_peer_reply: { ok: false, error: "peer_reply_unsupported" } });
    const r = await sendChannelPeerReply({ task_id: "inbox-unknown", text: "done" }, deps(hub));
    expect(r).toMatchObject({ ok: false, error: "peer_alias_unknown" });
    expect(hub.calls).toHaveLength(1);
    expect(hub.calls[0].args.alias).toBeUndefined();
    expect(hub.calls[0].args.in_reply_to).toBe("inbox-unknown");
  });

  test("explicit alias wins over the remembered originator", async () => {
    const hub = fakeHub({ send_peer_reply: { ok: true } });
    await sendChannelPeerReply({ task_id: "inbox-1", text: "done", alias: "other" }, deps(hub));
    expect(hub.calls[0].args.alias).toBe("other");
  });
});

describe("node-server wiring (source)", () => {
  const src = readFileSync(join(import.meta.dir, "node-server.ts"), "utf-8");
  test("tool is exposed in channel mode and NOT in outbound-only mode", () => {
    expect(src).toContain("name: PEER_REPLY_TOOL_NAME,");
    expect(src).toContain("if (name === PEER_REPLY_TOOL_NAME) {");
    const outbound = readFileSync(join(import.meta.dir, "outbound-tool-names.ts"), "utf-8");
    expect(outbound).not.toContain("commhub_send_peer_reply");
  });
  test("instructions point agent senders at the one-call tool", () => {
    expect(src).toContain('If the sender is another agent node: commhub_send_peer_reply(task_id=');
    expect(src).toContain("Only if commhub_send_peer_reply is missing from your tool list");
    expect(src).not.toContain("If your runtime has commhub_send_peer_reply");
  });
});
