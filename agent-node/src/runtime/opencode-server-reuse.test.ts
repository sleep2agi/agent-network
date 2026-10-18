// #1293 negative controls: the host-shared admission guard must never admit a
// non-loopback/foreign-uid/stale/missing-observation server, never approve on
// an on-disk record alone (live probe required), never require node identity
// (that is carried by MCP credentials/session binding), and must fall back
// rather than throw.
import { describe, expect, test } from "bun:test";
import {
  classifyServeUrl,
  decideHostSharedServerAdmission,
  isSupportedServeUrl,
  type HostSharedServerAdmissionInput,
  type HostSharedServerObservation,
} from "./opencode-server-reuse.js";

const base: HostSharedServerObservation = {
  url: "http://127.0.0.1:4096",
  uid: 1000,
  pid: 4242,
  startTicks: 900,
  generation: "v2",
};

function input(overrides: Partial<HostSharedServerAdmissionInput> = {}): HostSharedServerAdmissionInput {
  return {
    uid: 1000,
    generation: "v2",
    observations: [base],
    probeAlive: () => true,
    ...overrides,
  };
}

describe("host-shared server admission", () => {
  test("a live same-uid loopback host-shared server is admitted", () => {
    const observed: Array<[number, number]> = [];
    const d = decideHostSharedServerAdmission(input({
      probeAlive: (pid, ticks) => { observed.push([pid, ticks]); return true; },
    }));
    expect(d.decision).toBe("admit");
    expect(d.reason).toBe("host_shared_live");
    expect(d.server).toEqual({ url: "http://127.0.0.1:4096", uid: 1000, pid: 4242, startTicks: 900, generation: "v2" });
    expect(observed).toEqual([[4242, 900]]);
  });

  test("a DIFFERENT node may borrow the same host-shared server (no node-id gate)", () => {
    // Node identity is carried by MCP credentials + session binding, not by this
    // guard, so borrowing must NOT depend on the borrower's node id/alias.
    expect(decideHostSharedServerAdmission(input()).decision).toBe("admit");
  });

  test("off mode preserves today's always-spawn behaviour", () => {
    const d = decideHostSharedServerAdmission(input({ mode: "off" }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("host_shared_off");
  });

  test("absent probe never admits (no admission on a registered record alone)", () => {
    const d = decideHostSharedServerAdmission(input({ probeAlive: undefined }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("probe_unavailable");
  });

  test("a throwing probe falls back and never escapes as a throw", () => {
    const d = decideHostSharedServerAdmission(input({ probeAlive: () => { throw new Error("probe blew up"); } }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("probe_error");
  });

  test("missing startTicks is refused (PID reuse would be undetectable)", () => {
    const d = decideHostSharedServerAdmission(input({ observations: [{ ...base, startTicks: null }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("missing_start_ticks");
  });

  test("missing pid is refused (fail-closed)", () => {
    const d = decideHostSharedServerAdmission(input({ observations: [{ ...base, pid: undefined }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("missing_pid");
  });

  test("non-loopback url is refused", () => {
    const d = decideHostSharedServerAdmission(input({ observations: [{ ...base, url: "http://10.0.0.5:4096" }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("not_loopback");
  });

  // #2777 review (通信牛): only the production-supported `127.0.0.1` form may be
  // admitted. `localhost` and `[::1]` are loopback but are shapes the host
  // registry never writes, so they are refused with their own audit reason.
  test.each([
    ["http://localhost:4096"],
    ["http://[::1]:4096"],
    ["http://127.0.0.2:4096"],
  ])("loopback-but-unsupported url %s is refused as host_not_127_0_0_1", (url) => {
    const d = decideHostSharedServerAdmission(input({ observations: [{ ...base, url }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("host_not_127_0_0_1");
  });

  test("an unsupported-loopback url never masks a later supported one", () => {
    const d = decideHostSharedServerAdmission(input({
      observations: [{ ...base, url: "http://localhost:4096" }, { ...base, pid: 5151 }],
    }));
    expect(d.decision).toBe("admit");
    expect(d.server?.url).toBe("http://127.0.0.1:4096");
  });

  test("dead server (pid not live) falls back, never reuses a stale record", () => {
    const d = decideHostSharedServerAdmission(input({ probeAlive: () => false }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("not_live");
  });

  test("foreign uid is refused", () => {
    const d = decideHostSharedServerAdmission(input({ observations: [{ ...base, uid: 2000 }] }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("foreign_uid");
  });

  test("generation mismatch is refused", () => {
    const d = decideHostSharedServerAdmission(input({ generation: "v1" }));
    expect(d.decision).toBe("fallback");
    expect(d.reason).toBe("generation_mismatch");
  });

  test("empty observations fall back", () => {
    expect(decideHostSharedServerAdmission(input({ observations: [] })).reason).toBe("no_candidate");
  });

  test("malformed record degrades to fallback, not throw", () => {
    const d = decideHostSharedServerAdmission(input({ observations: [null, undefined, "x" as any, { url: 1 } as any] }));
    expect(d.decision).toBe("fallback");
  });

  test("the first valid observation wins over earlier refusals", () => {
    const d = decideHostSharedServerAdmission(input({
      observations: [{ ...base, uid: 2000 }, { ...base, pid: 5151 }],
    }));
    expect(d.decision).toBe("admit");
    expect(d.server?.pid).toBe(5151);
  });
});

describe("supported serve url guard", () => {
  test.each([
    ["http://127.0.0.1:4096", "supported"],
    ["http://127.0.0.1:65535", "supported"],
    ["http://localhost:4096", "unsupported_loopback"],
    ["http://[::1]:4096", "unsupported_loopback"],
    ["http://127.0.0.2:4096", "unsupported_loopback"],
    ["https://127.0.0.1:4096", "unsupported_loopback"],
    ["http://user:pass@127.0.0.1:4096", "unsupported_loopback"],
    // Raw-string strictness (通信牛, #2777 review): all of these normalize to
    // 127.0.0.1 under `new URL()`, so a parsed-host check would have accepted them.
    ["http://127.1:4096", "unsupported_loopback"],
    ["http://2130706433:4096", "unsupported_loopback"],
    ["http://0x7f000001:4096", "unsupported_loopback"],
    ["http://127.0.0.1:4096/other?x=1#x", "unsupported_loopback"],
    ["http://127.0.0.1:4096/", "unsupported_loopback"],
    ["http://127.0.0.1:4096?x=1", "unsupported_loopback"],
    ["http://127.0.0.1:4096#frag", "unsupported_loopback"],
    ["http://127.0.0.1:04096", "unsupported_loopback"],
    ["http://127.0.0.1:0", "unsupported_loopback"],
    ["http://127.0.0.1:65536", "unsupported_loopback"],
    ["http://127.0.0.1", "unsupported_loopback"],
    ["HTTP://127.0.0.1:4096", "unsupported_loopback"],
    ["http://127.0.0.01:4096", "unsupported_loopback"],
    ["http://192.168.1.5:4096", "not_loopback"],
    ["https://anet.sh", "not_loopback"],
    ["not-a-url", "not_loopback"],
  ] as const)("%s -> %s", (url, expected) => {
    expect(classifyServeUrl(url)).toBe(expected);
    expect(isSupportedServeUrl(url)).toBe(expected === "supported");
  });

  test("non-strings are never supported", () => {
    expect(classifyServeUrl(undefined)).toBe("not_loopback");
    expect(classifyServeUrl(4096)).toBe("not_loopback");
  });
});
