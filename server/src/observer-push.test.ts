// #461 — unit tests for the network observer SSE channel (push.ts).
//
// These tests read REAL bytes off the observer stream, so they are a
// live gate: stub pushNetworkObserverEvent out to a no-op and every
// "receives …" test below times out red. (Per 通信龙 2026-07-28 rule:
// a test that stays green when the core function is emptied is a fake
// gate.)

import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetSSEClientsForTest,
  createNetworkObserverStream,
  createSSEStream,
  createUserEventStream,
  pushEvent,
  pushNetworkObserverEvent,
  pushUserEvent,
} from "./push";

afterEach(() => {
  __resetSSEClientsForTest();
});

type Frame = Record<string, any>;

/** Read the next SSE data frame (skipping keepalive comments), with a
 *  hard timeout so a silent stream fails the test instead of hanging. */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2_000,
): Promise<Frame> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`no SSE frame within ${timeoutMs}ms`)), remaining),
      ),
    ]);
    if (result.done) throw new Error("stream ended before a data frame arrived");
    buf += decoder.decode(result.value, { stream: true });
    const sep = buf.indexOf("\n\n");
    if (sep === -1) continue;
    const rawFrame = buf.slice(0, sep);
    buf = buf.slice(sep + 2);
    const dataLine = rawFrame.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue; // keepalive comment frame — keep reading
    return JSON.parse(dataLine.slice(6));
  }
  throw new Error(`no SSE frame within ${timeoutMs}ms`);
}

describe("#461 network observer stream", () => {
  test("observer receives connected frame, then new_task summary with metadata only", async () => {
    const res = createNetworkObserverStream("net_obs_a");
    const reader = res.body!.getReader();

    const connected = await readFrame(reader);
    expect(connected.type).toBe("connected");
    expect(connected.observer).toBe(true);
    expect(connected.network_id).toBe("net_obs_a");

    pushNetworkObserverEvent("net_obs_a", {
      type: "new_task",
      task_id: "task-123",
      from: "sender-agent",
      to: "receiver-agent",
      status: "delivered",
      priority: "high",
    });

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_task");
    expect(evt.task_id).toBe("task-123");
    expect(evt.from).toBe("sender-agent");
    expect(evt.to).toBe("receiver-agent");
    expect(evt.status).toBe("delivered");
    expect(evt.priority).toBe("high");
    expect(evt.network_id).toBe("net_obs_a");
    expect(evt.scope).toBe("network");
    // Summary contract: NO content field, ever.
    expect("content" in evt).toBe(false);
    expect("task" in evt).toBe(false);
    await reader.cancel();
  });

  test("observer receives new_reply summary", async () => {
    const res = createNetworkObserverStream("net_obs_reply");
    const reader = res.body!.getReader();
    await readFrame(reader); // connected

    pushNetworkObserverEvent("net_obs_reply", {
      type: "new_reply",
      task_id: "parent-task",
      message_id: "msg-9",
      from: "worker",
      to: "boss",
      status: "completed",
    });

    const evt = await readFrame(reader);
    expect(evt.type).toBe("new_reply");
    expect(evt.task_id).toBe("parent-task");
    expect(evt.message_id).toBe("msg-9");
    expect(evt.status).toBe("completed");
    expect("content" in evt).toBe(false);
    expect("text" in evt).toBe(false);
    await reader.cancel();
  });

  test("events are network-isolated: observer on net B never sees net A traffic", async () => {
    const resB = createNetworkObserverStream("net_obs_b");
    const readerB = resB.body!.getReader();
    await readFrame(readerB); // connected

    // Push to A first, then a marker to B. Delivery per key is
    // synchronous and ordered, so if B's next frame is the marker,
    // the A event provably never reached B.
    pushNetworkObserverEvent("net_obs_a2", { type: "new_task", task_id: "leaked" });
    pushNetworkObserverEvent("net_obs_b", { type: "new_task", task_id: "marker-b" });

    const evt = await readFrame(readerB);
    expect(evt.task_id).toBe("marker-b");
    await readerB.cancel();
  });

  test("observer stream is isolated from session channels (both directions)", async () => {
    const sessionRes = createSSEStream("agent-x", "net_obs_c");
    const sessionReader = sessionRes.body!.getReader();
    await readFrame(sessionReader); // connected

    const obsRes = createNetworkObserverStream("net_obs_c");
    const obsReader = obsRes.body!.getReader();
    await readFrame(obsReader); // connected

    // Session push must NOT hit the observer; observer push must NOT
    // hit the session. Marker technique as above.
    pushEvent("agent-x", { type: "new_task", inbox_count: 1, marker: "to-session" }, "net_obs_c");
    pushNetworkObserverEvent("net_obs_c", { type: "new_task", task_id: "to-observer" });

    const sessionEvt = await readFrame(sessionReader);
    expect(sessionEvt.marker).toBe("to-session");
    expect("task_id" in sessionEvt).toBe(false);

    const obsEvt = await readFrame(obsReader);
    expect(obsEvt.task_id).toBe("to-observer");
    expect("marker" in obsEvt).toBe(false);

    await sessionReader.cancel();
    await obsReader.cancel();
  });

  test("null / undefined networkId is a silent no-op", () => {
    // Must not throw — legacy null-network traffic has no observer
    // stream by design (documented in #461 / the PR).
    expect(() => pushNetworkObserverEvent(null, { type: "new_task" })).not.toThrow();
    expect(() => pushNetworkObserverEvent(undefined, { type: "new_task" })).not.toThrow();
  });

  test("multiple observers on the same network all receive the event", async () => {
    const r1 = createNetworkObserverStream("net_obs_multi");
    const r2 = createNetworkObserverStream("net_obs_multi");
    const reader1 = r1.body!.getReader();
    const reader2 = r2.body!.getReader();
    await readFrame(reader1);
    await readFrame(reader2);

    pushNetworkObserverEvent("net_obs_multi", { type: "new_task", task_id: "fanout" });

    expect((await readFrame(reader1)).task_id).toBe("fanout");
    expect((await readFrame(reader2)).task_id).toBe("fanout");
    await reader1.cancel();
    await reader2.cancel();
  });
});

describe("Desktop user SSE stream", () => {
  test("user stream receives connected frame, then desktop_message", async () => {
    const res = createUserEventStream("net_user_a", "u_user_a");
    const reader = res.body!.getReader();

    const connected = await readFrame(reader);
    expect(connected.type).toBe("connected");
    expect(connected.user).toBe(true);
    expect(connected.network_id).toBe("net_user_a");
    expect(connected.user_id).toBe("u_user_a");

    pushUserEvent("net_user_a", "u_user_a", {
      type: "desktop_message",
      message_id: "dm_one",
      from: "agent-a",
      message: "hello",
    });

    const evt = await readFrame(reader);
    expect(evt.type).toBe("desktop_message");
    expect(evt.message_id).toBe("dm_one");
    expect(evt.from).toBe("agent-a");
    expect(evt.message).toBe("hello");
    expect(evt.network_id).toBe("net_user_a");
    expect(evt.user_id).toBe("u_user_a");
    expect(evt.scope).toBe("user");
    await reader.cancel();
  });

  test("user stream is isolated from alias and observer key spaces", async () => {
    const userRes = createUserEventStream("net_user_iso", "u_iso");
    const userReader = userRes.body!.getReader();
    await readFrame(userReader);

    const sessionRes = createSSEStream("u_iso", "net_user_iso");
    const sessionReader = sessionRes.body!.getReader();
    await readFrame(sessionReader);

    const observerRes = createNetworkObserverStream("net_user_iso");
    const observerReader = observerRes.body!.getReader();
    await readFrame(observerReader);

    pushEvent("u_iso", { type: "alias_marker", marker: "alias" }, "net_user_iso");
    pushNetworkObserverEvent("net_user_iso", { type: "observer_marker", marker: "observer" });
    pushUserEvent("net_user_iso", "u_iso", { type: "desktop_message", marker: "user" });

    expect((await readFrame(sessionReader)).marker).toBe("alias");
    expect((await readFrame(observerReader)).marker).toBe("observer");
    expect((await readFrame(userReader)).marker).toBe("user");

    await userReader.cancel();
    await sessionReader.cancel();
    await observerReader.cancel();
  });

  test("same user and network fan out to multiple live clients; cancelling one leaves the other live", async () => {
    const r1 = createUserEventStream("net_user_multi", "u_multi");
    const r2 = createUserEventStream("net_user_multi", "u_multi");
    const reader1 = r1.body!.getReader();
    const reader2 = r2.body!.getReader();
    await readFrame(reader1);
    await readFrame(reader2);

    pushUserEvent("net_user_multi", "u_multi", { type: "desktop_message", message_id: "dm_fanout_1" });
    expect((await readFrame(reader1)).message_id).toBe("dm_fanout_1");
    expect((await readFrame(reader2)).message_id).toBe("dm_fanout_1");

    await reader1.cancel();
    pushUserEvent("net_user_multi", "u_multi", { type: "desktop_message", message_id: "dm_fanout_2" });
    expect((await readFrame(reader2)).message_id).toBe("dm_fanout_2");
    await reader2.cancel();
  });
});
