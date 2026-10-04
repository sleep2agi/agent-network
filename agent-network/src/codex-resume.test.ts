import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listExternalThreads } from "./codex-adopt.js";
import {
  type CodexResumeFacts,
  decideCodexResume,
  formatNodeThreadList,
  gatherCodexResumeFacts,
  parsePickAnswer,
  resumeConfigShouldRollBack,
} from "./codex-resume.js";

const A = "01a02193-e1fd-70f3-9e16-6fbff295fbae";
const B = "01a02193-e1fd-70f3-9e16-6fbff295fbaf"; // shares 35 chars with A
const C = "01b0cccc-0000-7000-8000-000000000003";
const meta = (id: string, ts: string) => JSON.stringify({ timestamp: ts, type: "session_meta", payload: { id, timestamp: ts, cwd: "/w" } });
const userMsg = (t: string) => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: t } });
const FAKE_AUTH = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: "fake-access", refresh_token: "fake-refresh", account_id: "fake" } });

function codexHome(dir: string, opts: { login?: boolean; dupC?: boolean } = {}): string {
  const put = (day: string, id: string, lines: string[], tag = "") => {
    const d = join(dir, "sessions", "2026", "10", day);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `rollout-2026-10-${day}T0${day}-00-00${tag}-${id}.jsonl`), lines.join("\n") + "\n");
  };
  put("01", A, [meta(A, "2026-10-01T01:00:00.000Z"), userMsg("fix the flaky test")]);
  put("02", B, [meta(B, "2026-10-02T02:00:00.000Z"), userMsg("write the release notes for the new version please, all of them, in two languages")]);
  put("03", C, [meta(C, "2026-10-03T03:00:00.000Z")]);
  if (opts.dupC) put("04", C, [meta(C, "2026-10-04T03:00:00.000Z")]);
  if (opts.login !== false) writeFileSync(join(dir, "auth.json"), FAKE_AUTH);
  return dir;
}

function facts(over: Partial<CodexResumeFacts> = {}): CodexResumeFacts {
  const home = codexHome(mkdtempSync(join(tmpdir(), "anet-resume-")));
  return {
    alias: "my-node",
    kind: "co-presence",
    state: "stopped",
    running: false,
    codexHome: home,
    homeExists: true,
    homeIsHost: false,
    loggedIn: true,
    recordedThread: A,
    threads: listExternalThreads(home),
    ...over,
  };
}

const first = (d: ReturnType<typeof decideCodexResume>) => ("lines" in d ? d.lines[0] : "");

describe("#536 resume: which thread", () => {
  test("no flags resumes the recorded thread, unchanged", () => {
    const d = decideCodexResume(facts(), { tty: false });
    expect(d).toMatchObject({ kind: "resume", threadId: A, changed: false });
  });
  test("--thread with a full id or a unique prefix resolves to the full id and marks it changed", () => {
    expect(decideCodexResume(facts(), { thread: C, tty: false })).toMatchObject({ kind: "resume", threadId: C, changed: true });
    expect(decideCodexResume(facts(), { thread: "01b0", tty: false })).toMatchObject({ kind: "resume", threadId: C, changed: true });
    expect(decideCodexResume(facts(), { thread: C.toUpperCase(), tty: false })).toMatchObject({ kind: "resume", threadId: C });
  });
  test("no recorded thread and no --thread refuses (never a silent fresh start)", () => {
    const d = decideCodexResume(facts({ recordedThread: null }), { tty: false });
    expect(d.kind).toBe("refuse");
    expect(first(d)).toContain("no recorded codex thread");
    expect(first(d)).toContain("anet resume my-node --pick");
    expect((d as any).lines[1]).toContain("anet node codex start my-node");
  });
  test("a recorded thread whose rollout is gone refuses and names the fresh start as a choice", () => {
    const gone = "01ffffff-0000-7000-8000-00000000dead";
    const d = decideCodexResume(facts({ recordedThread: gone }), { tty: false });
    expect(d).toMatchObject({ kind: "refuse", code: 2 });
    expect(first(d)).toContain(`recorded thread ${gone} has no rollout`);
    expect(first(d)).toContain("refusing to start a fresh thread");
  });
  test("a foreign --thread (not in this CODEX_HOME) refuses with the list command", () => {
    const d = decideCodexResume(facts(), { thread: "01ffffff-0000-7000-8000-00000000dead", tty: false });
    expect(first(d)).toContain("is not in my-node's CODEX_HOME");
    expect(first(d)).toContain("--pick");
  });
  test("an ambiguous prefix, junk, a bare --thread and --thread+--pick all refuse", () => {
    expect(first(decideCodexResume(facts(), { thread: "01a02193", tty: false }))).toContain("matches 2 threads");
    expect(first(decideCodexResume(facts(), { thread: "zzz", tty: false }))).toContain("not a thread id");
    expect(first(decideCodexResume(facts(), { thread: "true", tty: false }))).toContain("--thread needs a thread id");
    expect(first(decideCodexResume(facts(), { thread: C, pick: true, tty: false }))).toContain("contradict");
  });
  test("one id in two rollout files refuses (which one is the conversation is a guess)", () => {
    const home = codexHome(mkdtempSync(join(tmpdir(), "anet-resume-dup-")), { dupC: true });
    const d = decideCodexResume(facts({ codexHome: home, threads: listExternalThreads(home) }), { thread: C, tty: false });
    expect(first(d)).toContain("2 rollout files");
  });
});

describe("#536 resume: environment", () => {
  test("a missing CODEX_HOME refuses before anything else", () => {
    const d = decideCodexResume(facts({ homeExists: false, codexHome: "/nope/codex-home", threads: [] }), { tty: false });
    expect(first(d)).toContain("CODEX_HOME /nope/codex-home does not exist");
  });
  test("no login refuses with the exact login command (exit 1); host home omits CODEX_HOME=", () => {
    const f = facts({ loggedIn: false });
    const d = decideCodexResume(f, { tty: false });
    expect(d).toMatchObject({ kind: "refuse", code: 1 });
    expect(first(d)).toContain(`CODEX_HOME=${f.codexHome} codex login --device-auth`);
    const h = decideCodexResume(facts({ loggedIn: false, homeIsHost: true, kind: "codex-sdk" }), { tty: false });
    expect(first(h)).toContain("Log in first: codex login --device-auth");
  });
  test("running on the same thread = attach; running/partial while switching = stop first", () => {
    expect(decideCodexResume(facts({ running: true, state: "running" }), { tty: false })).toMatchObject({ kind: "already" });
    const sw = decideCodexResume(facts({ running: true, state: "running" }), { thread: C, tty: false });
    expect(first(sw)).toContain("anet node stop my-node");
    const part = decideCodexResume(facts({ running: true, state: "partial 1/3" }), { tty: false });
    expect(first(part)).toContain("is partial 1/3");
  });
  test("codex-sdk fresh-start hint is anet node start", () => {
    const d = decideCodexResume(facts({ kind: "codex-sdk", recordedThread: null }), { tty: false });
    expect((d as any).lines[1]).toContain("anet node start my-node");
  });
});

describe("#536 picker", () => {
  test("non-TTY --pick prints the list and a copy-paste --thread command; exit 2, nothing resumed", () => {
    const d = decideCodexResume(facts(), { pick: true, tty: false });
    expect(d.kind).toBe("list");
    const lines = (d as any).lines as string[];
    expect((d as any).code).toBe(2);
    expect(lines.join("\n")).toContain(`anet resume my-node --thread ${C}`);
    expect(lines[1]).toContain(" 1. 2026-10-03 03:00:00Z  01b0cccc  (no prompt yet)");
    expect(lines.find((l) => l.includes('"fix the flaky test"'))).toContain("← recorded");
    expect(lines.find((l) => l.includes("release notes"))).toContain("…");
  });
  test("TTY --pick asks with choices newest first; the answer is re-decided as --thread", () => {
    const f = facts();
    const d = decideCodexResume(f, { pick: true, tty: true });
    expect(d.kind).toBe("ask");
    const choices = (d as any).choices as string[];
    expect(choices).toEqual([C, B, A]);
    const ans = parsePickAnswer("2", choices);
    expect(ans).toEqual({ kind: "ok", threadId: B });
    expect(decideCodexResume(f, { thread: B, tty: true })).toMatchObject({ kind: "resume", threadId: B, changed: true });
  });
  test("pick answers: empty/q cancel, out of range is bad", () => {
    expect(parsePickAnswer("", [A])).toEqual({ kind: "cancel" });
    expect(parsePickAnswer(null, [A])).toEqual({ kind: "cancel" });
    expect(parsePickAnswer("q", [A])).toEqual({ kind: "cancel" });
    expect(parsePickAnswer("2", [A]).kind).toBe("bad");
    expect(parsePickAnswer("1.5", [A]).kind).toBe("bad");
  });
  test("--pick on a home with no rollouts refuses", () => {
    const empty = mkdtempSync(join(tmpdir(), "anet-resume-empty-"));
    expect(first(decideCodexResume(facts({ codexHome: empty, threads: [] }), { pick: true, tty: true }))).toContain("nothing to pick");
  });
  test("list limit mentions the older ones", () => {
    const f = facts();
    expect(formatNodeThreadList(f.threads, null, 1).at(-1)).toContain("2 older thread(s) not shown");
  });
});

describe("#536 gather facts from a node dir", () => {
  test("co-presence node: own codex-home, login, recorded codexThreadId", () => {
    const nodes = mkdtempSync(join(tmpdir(), "anet-resume-nodes-"));
    codexHome(join(nodes, "n1", "codex-home"));
    const f = gatherCodexResumeFacts(
      { id: "n1", alias: "my-node", profile: { runtime: "codex-app-server", codexCopresence: true, codexThreadId: B } },
      { nodesDir: nodes, home: "/nonexistent-home", env: {}, tmuxSessions: () => new Set() },
    )!;
    expect(f).toMatchObject({ kind: "co-presence", state: "stopped", loggedIn: true, homeIsHost: false, recordedThread: B, homeExists: true });
    expect(f.threads.map((t) => t.threadId)).toEqual([C, B, A]);
  });
  test("codex-sdk node without its own home uses the host ~/.codex; not logged in there", () => {
    const nodes = mkdtempSync(join(tmpdir(), "anet-resume-nodes-"));
    const host = mkdtempSync(join(tmpdir(), "anet-resume-host-"));
    codexHome(join(host, ".codex"), { login: false });
    const f = gatherCodexResumeFacts(
      { id: "s1", alias: "my-sdk", profile: { runtime: "codex-sdk", session: A } },
      { nodesDir: nodes, home: host, env: {}, tmuxSessions: () => new Set() },
    )!;
    expect(f).toMatchObject({ kind: "codex-sdk", homeIsHost: true, loggedIn: false, recordedThread: A, codexHome: join(host, ".codex") });
    expect(decideCodexResume(f, { tty: false })).toMatchObject({ kind: "refuse", code: 1 });
  });
  test("a non-codex node yields null", () => {
    expect(gatherCodexResumeFacts({ id: "x", alias: "x", profile: { runtime: "claude-code-cli" } }, { nodesDir: "/n", home: "/h", env: {}, tmuxSessions: () => new Set() })).toBeNull();
  });
});

describe("#536 node codex resume config rollback", () => {
  test("only stops before anything was touched roll the thread back", () => {
    for (const s of ["preflight_before", "goal_state", "live_sessions"]) expect(resumeConfigShouldRollBack(s)).toBe(true);
    for (const s of ["done", "stop", "start", "verify_after(x)"]) expect(resumeConfigShouldRollBack(s)).toBe(false);
  });
});
