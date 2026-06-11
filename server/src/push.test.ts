import { afterEach, expect, test } from "bun:test";
import { eventBus } from "./event_bus";
import { __resetSSEClientsForTest, createSSEStream, getSSEStats } from "./push";

afterEach(() => {
  __resetSSEClientsForTest();
});

test("rename-committed rekeys existing SSE clients from old alias to new alias (case 8)", async () => {
  const res = createSSEStream("old-agent", "net-rekey-8");
  const reader = res.body!.getReader();

  expect(getSSEStats().sessions["net-rekey-8:old-agent"]).toBe(1);
  eventBus.emit("rename-committed", {
    networkId: "net-rekey-8",
    old_alias: "old-agent",
    new_alias: "new-agent",
    node_id: "node-8",
  });

  const stats = getSSEStats().sessions;
  expect(stats["net-rekey-8:old-agent"]).toBeUndefined();
  expect(stats["net-rekey-8:new-agent"]).toBe(1);
  await reader.cancel();
});

test("rename-committed merges old and new SSE client buckets without dropping clients (case 11)", async () => {
  const oldRes = createSSEStream("old-agent", "net-rekey-11");
  const newRes = createSSEStream("new-agent", "net-rekey-11");
  const oldReader = oldRes.body!.getReader();
  const newReader = newRes.body!.getReader();

  expect(getSSEStats().sessions["net-rekey-11:old-agent"]).toBe(1);
  expect(getSSEStats().sessions["net-rekey-11:new-agent"]).toBe(1);
  eventBus.emit("rename-committed", {
    networkId: "net-rekey-11",
    old_alias: "old-agent",
    new_alias: "new-agent",
    node_id: "node-11",
  });

  const stats = getSSEStats().sessions;
  expect(stats["net-rekey-11:old-agent"]).toBeUndefined();
  expect(stats["net-rekey-11:new-agent"]).toBe(2);
  await oldReader.cancel();
  await newReader.cancel();
});
