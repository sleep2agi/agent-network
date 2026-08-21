import { describe, expect, test } from "bun:test";
import { inboundChannelMeta } from "./channel-meta.js";

// The row shape get_inbox actually returns (commhub-server 0.9.0-preview.29,
// tools.ts: SELECT id, type, priority, content, context, from_session,
// created_at, network_id, meta_json, … FROM inbox WHERE acked = 0).
const row = {
  id: "f34a68a5-4506-4c3c-95d2-6484e9798a23",
  from_session: "TMCode负责人",
  priority: "high",
  created_at: "2026-08-19 19:45:13",
};

describe("inbound channel meta", () => {
  test("carries the Hub-side creation time", () => {
    // Without this the receiver cannot tell a 30-hour-old unacked row from a
    // message sent one second ago: both arrive with the same attribute set.
    expect(inboundChannelMeta(row).ts).toBe("2026-08-19 19:45:13");
  });

  test("task_id carries the inbox ROW id, which is what discriminates re-queue from re-read", () => {
    // retry_task inserts a new inbox row (fresh uuid, same logical task_id), so
    // a Hub re-queue changes this value while a node re-read does not. A row
    // that also carried a differing logical task_id must not shadow it.
    expect(inboundChannelMeta({ ...row, task_id: "some-logical-task-id" } as any).task_id)
      .toBe("f34a68a5-4506-4c3c-95d2-6484e9798a23");
  });

  test("a row with no created_at degrades to empty, never to the string 'undefined'", () => {
    // "undefined" would render as a plausible-looking attribute value and be
    // parsed as a real timestamp by anything downstream.
    expect(inboundChannelMeta({ id: "x" }).ts).toBe("");
  });

  test("keeps the attributes send_reply routing already depends on", () => {
    const m = inboundChannelMeta(row);
    expect(m.sender).toBe("TMCode负责人");
    expect(m.sender_id).toBe("commhub");
    expect(m.user).toBe("TMCode负责人");
    expect(m.priority).toBe("high");
  });
});
