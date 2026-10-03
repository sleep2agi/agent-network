import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { describeCodexModelSource, resolveCodexCopresenceModel } from "./codex-copresence-model";
import { DEFAULT_CODEX_MODEL } from "./codex-model-default";
import { resumeAndVerifyCodexThread } from "./codex-copresence-recovery";
import { codexTuiLaunchArgs } from "./codex-tui-client-health";

// #512 — codex co-presence nodes ignored the `model` in their own config.json at
// start: the launcher computed `opts.model || DEFAULT_CODEX_MODEL` where
// opts.model is only the --model flag, and thread/resume carried no model so
// codex fell back to the rollout's recorded one.

describe("#512 resolveCodexCopresenceModel: flag > node config > default", () => {
  test("explicit flag wins over node config", () => {
    expect(resolveCodexCopresenceModel("o3", "gpt-cfg")).toEqual({ model: "o3", source: "flag" });
  });

  test("node config wins over the default when no flag is given", () => {
    expect(resolveCodexCopresenceModel(undefined, "gpt-cfg")).toEqual({ model: "gpt-cfg", source: "node-config" });
  });

  test("default only when neither is set", () => {
    expect(resolveCodexCopresenceModel(undefined, undefined)).toEqual({ model: DEFAULT_CODEX_MODEL, source: "default" });
  });

  test("blank / non-string values do not count as set", () => {
    expect(resolveCodexCopresenceModel("  ", "gpt-cfg")).toEqual({ model: "gpt-cfg", source: "node-config" });
    expect(resolveCodexCopresenceModel("", "")).toEqual({ model: DEFAULT_CODEX_MODEL, source: "default" });
    expect(resolveCodexCopresenceModel(true, 42)).toEqual({ model: DEFAULT_CODEX_MODEL, source: "default" });
    expect(resolveCodexCopresenceModel(" o3 ", undefined)).toEqual({ model: "o3", source: "flag" });
  });

  test("the configured model is never the default's value by accident (fixture is distinct)", () => {
    expect("gpt-cfg").not.toBe(DEFAULT_CODEX_MODEL);
  });

  test("each source has a distinct human description", () => {
    const d = (["flag", "node-config", "default"] as const).map((source) => describeCodexModelSource({ model: "m", source }));
    expect(new Set(d).size).toBe(3);
    expect(d[1]).toContain("config.json");
  });
});

describe("#512 thread/resume carries the resolved model", () => {
  const history = { thread: { id: "thread_old", turns: [{ id: "turn_1", status: "completed" }] } };

  test("model rides on thread/resume (codex 0.155 otherwise resumes on the rollout's recorded model)", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const out = await resumeAndVerifyCodexThread("thread_old", async (method, params) => {
      calls.push({ method, params });
      return method === "thread/resume" ? { model: "gpt-cfg" } : history;
    }, "gpt-cfg");
    expect(calls[0]).toEqual({ method: "thread/resume", params: { threadId: "thread_old", model: "gpt-cfg" } });
    expect(out.resumedModel).toBe("gpt-cfg");
  });

  test("no model → no override key (legacy callers unchanged)", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await resumeAndVerifyCodexThread("thread_old", async (method, params) => {
      calls.push(params);
      return method === "thread/resume" ? {} : history;
    });
    expect(calls[0]).toEqual({ threadId: "thread_old" });
  });
});

describe("#512 TUI gets -m on fresh and resume", () => {
  test("resume --remote keeps -m <configured>", () => {
    expect(codexTuiLaunchArgs("ws://127.0.0.1:4500", "gpt-cfg", "01a10297-2480-7453-8e5e-4870ad37caa3"))
      .toEqual(["resume", "--remote", "ws://127.0.0.1:4500", "01a10297-2480-7453-8e5e-4870ad37caa3", "-m", "gpt-cfg"]);
  });
  test("fresh --remote keeps -m <configured>", () => {
    expect(codexTuiLaunchArgs("ws://127.0.0.1:4500", "gpt-cfg")).toEqual(["--remote", "ws://127.0.0.1:4500", "-m", "gpt-cfg"]);
  });
});

describe("#512 launcher wiring (source)", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
  const start = cli.indexOf("async function startCopresenceOrchestration(");
  const body = cli.slice(start, cli.indexOf("async function startOpencodeCopresenceOrchestration(", start));

  test("start resolves from the flag AND the node profile, once, before either platform backend", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("resolveCodexCopresenceModel(opts.model, (profile as { model?: unknown }).model)");
    expect(body).not.toContain("opts.model || DEFAULT_CODEX_MODEL");
    const resolveAt = body.indexOf("resolveCodexCopresenceModel(");
    expect(resolveAt).toBeLessThan(body.indexOf("startWindowsCodexCopresence("));
    expect(resolveAt).toBeLessThan(body.indexOf("-c model=${shellQuote(model)}"));
    expect(body).toContain("source: ${describeCodexModelSource(resolvedModel)}");
  });

  test("both platforms pass the resolved model into thread recovery", () => {
    const calls = cli.match(/createCodexCopresenceThread\(wsUrl, 60_000, [^)]*\)/g) ?? [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.endsWith(", model)")).toBe(true);
    const create = cli.slice(cli.indexOf("async function createCodexCopresenceThread("), cli.indexOf("async function askTypedConfirmation"));
    expect(create).toMatch(/resumeAndVerifyCodexThread\([\s\S]*?model,\s*\)/);
  });
});
