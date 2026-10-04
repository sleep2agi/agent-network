import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { firstPromptOf, formatThreadList, listExternalThreads, resolveExternalThread, shortIds } from "./codex-adopt.js";
import { rewriteRollout } from "./codex-lifecycle-fork.js";

// Rollout shapes copied from codex-lifecycle-fork.test.ts (compact JSON, the form codex writes).
const A = "01a02193-e1fd-70f3-9e16-6fbff295fbae";
const B = "01a02193-e1fd-70f3-9e16-6fbff295fbaf"; // shares 35 chars with A
const C = "01b0cccc-0000-7000-8000-000000000003";
const meta = (id: string, ts: string, cwd: string) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, session_id: id, timestamp: ts, cwd } });
const userItem = (t: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
const userMsg = (t: string) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: t } });

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "anet-adopt-"));
  const put = (day: string, stamp: string, id: string, lines: string[]) => {
    const d = join(h, "sessions", "2026", "10", day);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `rollout-2026-10-${day}T${stamp}-${id}.jsonl`), lines.join("\n") + "\n");
  };
  put("01", "01-00-00", A, [meta(A, "2026-10-01T01:00:00.000Z", "/proj/a"), userItem("<environment_context>x</environment_context>"), userMsg("fix the\n flaky test please")]);
  put("02", "02-00-00", B, [meta(B, "2026-10-02T02:00:00.000Z", "/proj/b"), userItem("<user_instructions>y</user_instructions>"), userItem("only a response item prompt")]);
  put("03", "03-00-00", C, [meta(C, "2026-10-03T03:00:00.000Z", "/proj/c")]);
  writeFileSync(join(h, "sessions", "2026", "10", "03", "not-a-rollout.jsonl"), "{}\n");
  return h;
}

describe("#528 adopt: listing a raw CODEX_HOME", () => {
  test("lists every rollout newest first with cwd and the first human prompt", () => {
    const t = listExternalThreads(home());
    expect(t.map((x) => x.threadId)).toEqual([C, B, A]);
    expect(t[2].cwd).toBe("/proj/a");
    expect(t[2].firstPrompt).toBe("fix the flaky test please");
    expect(t[1].firstPrompt).toBe("only a response item prompt"); // injected <...> items are skipped
    expect(t[0].firstPrompt).toBeNull();
  });
  test("an empty / missing home lists nothing", () => {
    expect(listExternalThreads(join(tmpdir(), "anet-adopt-missing-xyz"))).toEqual([]);
  });
  test("firstPromptOf prefers the typed user_message over a response item", () => {
    expect(firstPromptOf([userItem("item"), userMsg("typed")])).toBe("typed");
  });
  test("short ids are unique and at least 8 chars", () => {
    const m = shortIds([A, B, C]);
    expect(m.get(C)).toBe("01b0cccc");
    expect(m.get(A)).toBe(A); // only the last char differs from B
    expect(m.get(A)).not.toBe(m.get(B));
  });
  test("formatThreadList numbers rows and quotes the truncated prompt", () => {
    const lines = formatThreadList(listExternalThreads(home()));
    expect(lines[0]).toContain(" 1. 2026-10-03 03:00:00Z  01b0cccc  /proj/c  (no prompt yet)");
    expect(lines[2]).toContain('"fix the flaky test please"');
    expect(formatThreadList(listExternalThreads(home()), 1).at(-1)).toContain("2 older thread(s) not shown");
  });
});

describe("#528 adopt: resolving --thread", () => {
  const t = listExternalThreads(home());
  test("full id and unique prefix resolve to one rollout", () => {
    const full = resolveExternalThread(t, A.toUpperCase());
    expect(full.kind).toBe("ok");
    expect(full.kind === "ok" && full.thread.threadId).toBe(A);
    const pre = resolveExternalThread(t, "01b0");
    expect(pre.kind === "ok" && pre.thread.threadId).toBe(C);
  });
  test("an ambiguous prefix is refused, listing both", () => {
    const r = resolveExternalThread(t, "01a02193");
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && r.matches.length).toBe(2);
  });
  test("no match, too short, and non-hex are refused", () => {
    expect(resolveExternalThread(t, "ffff").kind).toBe("none");
    expect(resolveExternalThread(t, "01").kind).toBe("invalid");
    expect(resolveExternalThread(t, "latest").kind).toBe("invalid");
  });
  test("one id in two rollout files is refused (duplicate)", () => {
    const dup = [...t, { ...t[0], path: t[0].path + ".copy" }];
    expect(resolveExternalThread(dup, C).kind).toBe("duplicate");
  });
});

describe("#528 adopt: rewriteRollout accepts an old header with payload.id only", () => {
  test("payload.id without session_id is the thread id", async () => {
    const d = mkdtempSync(join(tmpdir(), "anet-adopt-old-"));
    const src = join(d, "src.jsonl");
    writeFileSync(src, JSON.stringify({ type: "session_meta", payload: { id: A, cwd: "/w" } }) + "\n");
    const r = await rewriteRollout(src, join(d, "out.jsonl"), A, C, { from: "/w", to: "/x" });
    expect(r.replacements).toBe(1);
    expect(r.cwdReplacements).toBe(1);
  });
  test("session_id still wins when both are present", async () => {
    const d = mkdtempSync(join(tmpdir(), "anet-adopt-old-"));
    const src = join(d, "src.jsonl");
    writeFileSync(src, JSON.stringify({ type: "session_meta", payload: { id: A, session_id: B } }) + "\n");
    await expect(rewriteRollout(src, join(d, "out.jsonl"), A, C)).rejects.toThrow(/not session_meta/);
  });
});
