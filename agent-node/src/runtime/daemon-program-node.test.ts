import { describe, expect, test } from "bun:test";
import {
  HOST_SUPERVISOR_ROLE,
  daemonProgramReply,
  isDaemonPureProgramNode,
} from "./daemon-program-node";

// #1417 — de-LLM the daemon. These lock in the decision that keeps a
// host_supervisor daemon from ever running an LLM turn for a free-text task,
// plus the deterministic reply it sends instead.
describe("daemon-program-node (#1417)", () => {
  test("only an exact host_supervisor role is a pure-program node", () => {
    expect(isDaemonPureProgramNode("host_supervisor")).toBe(true);
    expect(isDaemonPureProgramNode(HOST_SUPERVISOR_ROLE)).toBe(true);
  });

  test("every other role falls through to the runtime path", () => {
    // Exact-value match only: agent/leader/empty/undefined/null and any
    // differently-cased or near-miss string must NOT be treated as a daemon,
    // or a normal agent could be silenced into never running the model.
    for (const role of [
      "agent",
      "leader",
      "supervisor",
      "Host_Supervisor",
      "HOST_SUPERVISOR",
      "host-supervisor",
      " host_supervisor",
      "host_supervisor ",
      "",
      undefined,
      null,
    ]) {
      expect(isDaemonPureProgramNode(role as any)).toBe(false);
    }
  });

  test("program reply names the alias, states no model, and is deterministic", () => {
    const r = daemonProgramReply("TM基建牛");
    expect(r).toContain("TM基建牛");
    expect(r).toContain("host_supervisor");
    // It must not leave the sender expecting an AI answer.
    expect(r).toMatch(/不运行大模型/);
    expect(r).toMatch(/无 AI|不会调用 AI/);
    // Names the lifecycle commands the daemon actually serves.
    expect(r).toContain("创建");
    expect(r).toContain("删除");
    // Pure function of the alias — stable across calls (no clock/randomness).
    expect(daemonProgramReply("TM基建牛")).toBe(r);
    // Different alias → different, correctly-addressed reply.
    expect(daemonProgramReply("daemon-2")).toContain("daemon-2");
  });
});
