// #3146 —— 回归门：共享 OpenCode Server 的包装对象必须把 selectedModel /
// setSelectedModel 转发出去。
//
// 为什么要单独一条：这个 wrapper 曾经只转发 url/sessionId/attachScriptPath/
// isRunning/backgroundControl/notify/submit/close，core 上的这两个方法没被转发。
// 于是 `typeof session.setSelectedModel === "function"` 恒为 false，
// 任何走共享 server 的节点都**结构性无法热切模型**——生产表现是每次切模型都重启。
//
// 现有的 shared-server 测试全部直接测 core（openVettedOpenCodeCopresence），
// 没有一条经过 wrapper，所以这个漏转发一直没被测出来。
// 这条测试刻意只测 wrapper 本身（纯对象，不 spawn 任何进程）。
import { describe, expect, test } from "bun:test";
import { wrapSharedCopresenceSession, type OpenCodeCopresenceSession } from "./runtime";

function stubCore(over: Partial<OpenCodeCopresenceSession> = {}): OpenCodeCopresenceSession {
  return {
    url: "http://127.0.0.1:1",
    sessionId: "ses_stub",
    attachScriptPath: "/tmp/stub-attach.sh",
    isRunning: true,
    notify: async () => {},
    submit: async () => "reply",
    close: async () => {},
    selectedModel: async () => "stub/stub-model",
    setSelectedModel: async () => {},
    ...over,
  } as OpenCodeCopresenceSession;
}

describe("#3146 — shared-server wrapper", () => {
  test("forwards scoped native model readback without flattening variant", async () => {
    const model = { providerID: "stub", id: "model", variant: "high" };
    const wrapped = wrapSharedCopresenceSession(stubCore({
      selectedSessionModel: async (id) => id === "ses_stub" ? model : undefined,
    }));
    expect(await wrapped.selectedSessionModel!("ses_stub")).toEqual(model);
    expect(await wrapped.selectedSessionModel!("ses_other")).toBeUndefined();
    expect(wrapSharedCopresenceSession(stubCore()).selectedSessionModel).toBeUndefined();
  });
  test("forwards fork identity and preserves forked and unknown outcomes", async () => {
    const seen: string[] = [];
    let uncertain = false;
    const wrapped = wrapSharedCopresenceSession(stubCore({
      forkSession: async id => { seen.push(id); return uncertain
        ? { status: "unknown", reason: "verification_failed" }
        : { status: "forked", sessionId: "ses_child" }; },
    }));
    expect(typeof wrapped.forkSession).toBe("function");
    expect(await wrapped.forkSession!("ses_stub")).toEqual({ status: "forked", sessionId: "ses_child" });
    uncertain = true;
    expect(await wrapped.forkSession!("ses_stub")).toEqual({ status: "unknown", reason: "verification_failed" });
    expect(seen).toEqual(["ses_stub", "ses_stub"]);
  });
  test("forwards scoped model selection and its unsupported result", async () => {
    const seen: unknown[] = [];
    const wrapped = wrapSharedCopresenceSession(stubCore({
      selectSessionModel: async (id, model) => { seen.push(id, model); return { status: "rejected", reason: "unsupported" }; },
    }));
    const model = { providerID: "stub", id: "model", variant: "high" };
    expect(await wrapped.selectSessionModel!("ses_stub", model)).toEqual({ status: "rejected", reason: "unsupported" });
    expect(seen).toEqual(["ses_stub", model]);
  });
  test("forwards selectedModel / setSelectedModel (the two that went missing)", () => {
    const wrapped = wrapSharedCopresenceSession(stubCore());
    expect(typeof wrapped.selectedModel).toBe("function");
    expect(typeof wrapped.setSelectedModel).toBe("function");
  });

  test("setSelectedModel actually reaches the core", async () => {
    const seen: string[] = [];
    const wrapped = wrapSharedCopresenceSession(stubCore({
      setSelectedModel: async (m: string) => { seen.push(m); },
      selectedModel: async () => seen[seen.length - 1],
    }));
    await wrapped.setSelectedModel!("deepseek/deepseek-v4-pro");
    expect(seen).toEqual(["deepseek/deepseek-v4-pro"]);
    expect(await wrapped.selectedModel!()).toBe("deepseek/deepseek-v4-pro");
  });
  test("combined model/depth writer survives the shared-server wrapper", async () => {
    const calls: unknown[] = [];
    const wrapped = wrapSharedCopresenceSession(stubCore({
      setSelectedModelAndVariant: async (model, variant) => { calls.push([model, variant]); return { providerID: "p", id: "m", variant: "high" }; },
    }));
    expect(await wrapped.setSelectedModelAndVariant!("p/m", "high")).toEqual({ providerID: "p", id: "m", variant: "high" });
    expect(calls).toEqual([["p/m", "high"]]);
    expect(wrapSharedCopresenceSession(stubCore()).setSelectedModelAndVariant).toBeUndefined();
  });

  test("omits the optional methods when the core does not expose them", () => {
    const wrapped = wrapSharedCopresenceSession(stubCore({ selectedModel: undefined, setSelectedModel: undefined }));
    expect(wrapped.selectedModel).toBeUndefined();
    expect(wrapped.setSelectedModel).toBeUndefined();
    expect(wrapped.forkSession).toBeUndefined();
  });

  test("forwards the rest unchanged and runs afterClose once", async () => {
    let closes = 0;
    const wrapped = wrapSharedCopresenceSession(stubCore({
      url: "http://127.0.0.1:9", sessionId: "ses_x", isRunning: false,
      close: async () => { closes += 1; },
    }), { afterClose: () => { closes += 10; } });
    expect(wrapped.url).toBe("http://127.0.0.1:9");
    expect(wrapped.sessionId).toBe("ses_x");
    expect(wrapped.isRunning).toBe(false);
    await wrapped.close();
    expect(closes).toBe(11);
  });
});
