import { describe, expect, test } from "bun:test";
import {
  ACTIVE_NETWORK_TASK_MAX_AGE_MS,
  clampOutboundPriority,
  decideOutboundRewrite,
  parseActiveNetworkTask,
} from "./active-network-task.js";

const NOW = 1_800_000_000_000;
const marker = JSON.stringify({ taskId: "5844f347", from: "通信龙", startedAt: NOW - 5_000 });

describe("parseActiveNetworkTask", () => {
  test("reads a fresh marker", () => {
    expect(parseActiveNetworkTask(marker, NOW)).toEqual({ taskId: "5844f347", from: "通信龙", startedAt: NOW - 5_000 });
  });
  test("missing, empty, malformed and shape-less inputs all mean no active task", () => {
    expect(parseActiveNetworkTask(undefined, NOW)).toBeNull();
    expect(parseActiveNetworkTask("", NOW)).toBeNull();
    expect(parseActiveNetworkTask("{not json", NOW)).toBeNull();
    expect(parseActiveNetworkTask("[]", NOW)).toBeNull();
    expect(parseActiveNetworkTask(JSON.stringify({ taskId: "x" }), NOW)).toBeNull();
    expect(parseActiveNetworkTask(JSON.stringify({ taskId: "x", from: " ", startedAt: NOW }), NOW)).toBeNull();
  });
  test("a stale marker (runtime died before clearing it) is ignored", () => {
    const old = JSON.stringify({ taskId: "t", from: "a", startedAt: NOW - ACTIVE_NETWORK_TASK_MAX_AGE_MS - 1 });
    expect(parseActiveNetworkTask(old, NOW)).toBeNull();
    const edge = JSON.stringify({ taskId: "t", from: "a", startedAt: NOW - ACTIVE_NETWORK_TASK_MAX_AGE_MS });
    expect(parseActiveNetworkTask(edge, NOW)).not.toBeNull();
  });
});

describe("decideOutboundRewrite", () => {
  const active = { taskId: "5844f347", from: "通信龙", startedAt: NOW };
  test("send_task / send_message aimed at the originator become progress of the active task", () => {
    expect(decideOutboundRewrite("commhub_send_task", { alias: "通信龙", task: "PING-c2e1 已收到" }, active))
      .toEqual({ kind: "progress_of_active_task", taskId: "5844f347", from: "通信龙", text: "PING-c2e1 已收到" });
    expect(decideOutboundRewrite("commhub_send_message", { alias: " 通信龙 ", message: "收到" }, active))
      .toEqual({ kind: "progress_of_active_task", taskId: "5844f347", from: "通信龙", text: "收到" });
  });
  test("dispatching to anyone else passes through untouched", () => {
    expect(decideOutboundRewrite("commhub_send_task", { alias: "Mac打包牛", task: "帮我打包" }, active)).toEqual({ kind: "pass" });
  });
  test("no active task means no rewrite even for the same alias", () => {
    expect(decideOutboundRewrite("commhub_send_message", { alias: "通信龙", message: "x" }, null)).toEqual({ kind: "pass" });
  });
  test("a missing alias never matches", () => {
    expect(decideOutboundRewrite("commhub_send_message", { message: "x" }, active)).toEqual({ kind: "pass" });
    expect(decideOutboundRewrite("commhub_send_message", null, active)).toEqual({ kind: "pass" });
  });
});

describe("clampOutboundPriority", () => {
  test("outbound-only demotes a model-chosen high to normal and leaves the rest", () => {
    expect(clampOutboundPriority("high", true)).toBe("normal");
    expect(clampOutboundPriority("low", true)).toBe("low");
    expect(clampOutboundPriority("normal", true)).toBe("normal");
    expect(clampOutboundPriority("urgent", true)).toBeUndefined();
  });
  test("full mode keeps high", () => {
    expect(clampOutboundPriority("high", false)).toBe("high");
  });
});
