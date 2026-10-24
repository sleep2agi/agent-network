// RFC-043 §4 v1：启动时注入 Hub 层规则（默认关闭）。
// 这些用例同时固定三件"行为契约"：
//   1. 关闭时**不发请求、不动文件**；
//   2. Hub 不可达 / 非 2xx → **文件原样**（不删块、不写空）；
//   3. 打开时：插入 / 幂等 / revision 替换 / 用户内容逐字节保留 / 标记损坏拒写。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectTeamRules, currentTeamRulesOutcome, recordTeamRulesOutcome, resetTeamRulesOutcome } from "./team-rules-inject";
import { MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END } from "./managed-rules-block";

let dir = "";
const HUB = "http://hub.test";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "team-rules-")); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function workdirWith(name: string, content?: string) {
  const d = join(dir, name);
  rmSync(d, { recursive: true, force: true });
  // 用 mkdtemp 保证父目录存在，再把手写的 AGENTS.md 放进去。
  const made = mkdtempSync(join(dir, name + "-"));
  if (content !== undefined) writeFileSync(join(made, "AGENTS.md"), content, "utf8");
  return made;
}

const okFetch = (rules: { content: string; revision: number }) => {
  const calls: string[] = [];
  const f = (async (url: string, init?: any) => {
    calls.push(String(url));
    expect(String(url)).toBe(`${HUB}/api/networks/net_1/rules`);
    expect(init?.headers?.Authorization).toBe("Bearer ntok_x");
    return new Response(JSON.stringify({ ok: true, rules: { ...rules, updated_at: "2026-10-24T13:00:00Z" } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe("injectTeamRules", () => {
  test("disabled: no request and the file is untouched", async () => {
    const d = workdirWith("disabled", "# mine\n");
    const { f, calls } = okFetch({ content: "hub rule", revision: 1 });
    const out = await injectTeamRules({ enabled: false, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: f });
    expect(out.status).toBe("disabled");
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe("# mine\n");
  });

  test("hub unreachable keeps the file byte-identical (rule is not silently withdrawn)", async () => {
    const original = "# mine\n\n- keep me\n";
    const d = workdirWith("unreachable", original);
    const f = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const warns: string[] = [];
    const out = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: f, warn: (m) => warns.push(m) });
    expect(out).toMatchObject({ status: "skipped", reason: "hub_unreachable" });
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe(original);
    expect(warns.join("\n")).toContain("unreachable");
  });

  test("a hung hub is cut off instead of blocking startup", async () => {
    const d = workdirWith("timeout", "# mine\n");
    // never resolves, never rejects — the half-open connection case
    const f = ((_u: string, init?: any) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const warns: string[] = [];
    const started = Date.now();
    const out = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: f, timeoutMs: 60, warn: (m) => warns.push(m) });
    expect(out).toMatchObject({ status: "skipped", reason: "hub_timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe("# mine\n");
    expect(warns.join("\n")).toContain("did not answer");
  });

  test("non-2xx also leaves the file alone", async () => {
    const d = workdirWith("http500", "# mine\n");
    const f = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const out = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: f });
    expect(out).toMatchObject({ status: "skipped", reason: "hub_http_500" });
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe("# mine\n");
  });

  test("injects once, is idempotent on the same revision, and replaces on a new one", async () => {
    const user = "# 我自己的规则\n\n- 不要动我\n";
    const d = workdirWith("inject", user);

    const first = okFetch({ content: "hub rule v1", revision: 1 });
    const out1 = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: first.f });
    expect(out1).toMatchObject({ status: "injected", action: "inserted", revision: 1 });
    const after1 = readFileSync(join(d, "AGENTS.md"), "utf8");
    expect(after1.startsWith(MANAGED_BLOCK_BEGIN(1))).toBe(true);
    expect(after1.endsWith(user)).toBe(true);

    const second = okFetch({ content: "hub rule v1", revision: 1 });
    const out2 = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: second.f });
    expect(out2).toEqual({ status: "unchanged", revision: 1 });
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe(after1);

    const third = okFetch({ content: "hub rule v2", revision: 2 });
    const out3 = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: third.f });
    expect(out3).toMatchObject({ status: "injected", action: "replaced", revision: 2 });
    const after3 = readFileSync(join(d, "AGENTS.md"), "utf8");
    expect(after3).toContain(MANAGED_BLOCK_END(2));
    expect(after3.endsWith(user)).toBe(true);
  });

  test("empty hub rules skip without creating a block", async () => {
    const d = workdirWith("empty");
    const { f } = okFetch({ content: "   \n", revision: 3 });
    const out = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: f });
    expect(out).toMatchObject({ status: "skipped", reason: "no_rules" });
    expect(existsSync(join(d, "AGENTS.md"))).toBe(false);
  });

  test("a half-written marker in the user file is refused, and the file is not touched", async () => {
    const broken = `${MANAGED_BLOCK_BEGIN(1)}\n半截\n# 我的规则\n`;
    const d = workdirWith("refuse", broken);
    const { f } = okFetch({ content: "hub rule", revision: 2 });
    const warns: string[] = [];
    const out = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "codex", fetchImpl: f, warn: (m) => warns.push(m) });
    expect(out.status).toBe("error");
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe(broken);
    expect(warns.join("\n")).toContain("refused");
  });

  test("claude nodes use CLAUDE.md, the rest use AGENTS.md", async () => {
    const d = workdirWith("runtime");            // 空目录：由注入创建目标文件
    const { f } = okFetch({ content: "hub rule", revision: 1 });
    await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d, runtime: "claude", fetchImpl: f });
    expect(existsSync(join(d, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(d, "AGENTS.md"))).toBe(false);

    const d2 = workdirWith("runtime2");
    const second = okFetch({ content: "hub rule", revision: 1 });
    await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: "net_1", workDir: d2, runtime: "codex", fetchImpl: second.f });
    expect(existsSync(join(d2, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(d2, "CLAUDE.md"))).toBe(false);
  });

  test("a token without network scope is skipped rather than guessing", async () => {
    const d = workdirWith("noscope", "# mine\n");
    const { f, calls } = okFetch({ content: "hub rule", revision: 1 });
    const out = await injectTeamRules({ enabled: true, hubUrl: HUB, token: "ntok_x", networkId: null, workDir: d, runtime: "codex", fetchImpl: f });
    expect(out).toMatchObject({ status: "skipped", reason: "no_network_scope" });
    expect(calls).toHaveLength(0);
  });
});

describe("#2211 — the node reports what it last did", () => {
  test("nothing recorded before an attempt (the field is omitted, not sent as null)", () => {
    resetTeamRulesOutcome();
    expect(currentTeamRulesOutcome()).toBeNull();
  });

  test("an injected outcome carries the revision; a refusal carries the reason", () => {
    resetTeamRulesOutcome();
    recordTeamRulesOutcome({ status: "injected", revision: 7, action: "inserted" }, "2026-10-24T12:00:00Z");
    expect(currentTeamRulesOutcome()).toEqual({ revision: 7, status: "injected", at: "2026-10-24T12:00:00Z" });

    recordTeamRulesOutcome({ status: "error", reason: "expected exactly one BEGIN" }, "2026-10-24T12:01:00Z");
    expect(currentTeamRulesOutcome()).toEqual({
      revision: null, status: "error", reason: "expected exactly one BEGIN", at: "2026-10-24T12:01:00Z",
    });
  });

  test("a skipped outcome reports why, with no revision", () => {
    resetTeamRulesOutcome();
    recordTeamRulesOutcome({ status: "skipped", reason: "hub_unreachable" }, "2026-10-24T12:02:00Z");
    expect(currentTeamRulesOutcome()).toMatchObject({ revision: null, status: "skipped", reason: "hub_unreachable" });
  });
});
