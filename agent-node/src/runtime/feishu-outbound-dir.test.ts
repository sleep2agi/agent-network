import { describe, expect, test } from "bun:test";
import {
  buildFeishuWorkerArgs,
  resolveFeishuOutboundDir,
} from "./feishu-outbound-dir";

describe("Feishu legacy outbound directory", () => {
  test("prefers the canonical worker value verbatim", () => {
    expect(resolveFeishuOutboundDir(
      "/work/feishu-attachments/worker-binding/oc_worker/",
      "parent-binding",
      "oc_parent",
    )).toBe("/work/feishu-attachments/worker-binding/oc_worker/");
  });

  test("reconstructs a legacy envelope from the explicit channel binding", () => {
    expect(resolveFeishuOutboundDir(undefined, "binding-special", "oc_a/b:c"))
      .toBe("/work/feishu-attachments/binding-special/oc_a_b_c/");
  });

  test("does not consult a stale ambient node alias", () => {
    const before = process.env.ANET_NODE_ALIAS;
    process.env.ANET_NODE_ALIAS = "wrong-ambient-alias";
    try {
      expect(resolveFeishuOutboundDir(undefined, "binding-special", "oc_x"))
        .toBe("/work/feishu-attachments/binding-special/oc_x/");
    } finally {
      if (before === undefined) delete process.env.ANET_NODE_ALIAS;
      else process.env.ANET_NODE_ALIAS = before;
    }
  });

  test("passes the same explicit binding name to the worker", () => {
    expect(buildFeishuWorkerArgs("/pkg/worker.js", {
      dir: "/node/channels/feishu",
      connectionName: "binding-special",
    })).toEqual([
      "/pkg/worker.js",
      "--channel-dir",
      "/node/channels/feishu",
      "--node-alias",
      "binding-special",
    ]);
  });
});
