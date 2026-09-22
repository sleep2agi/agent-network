import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FORK_HOME_COPY, FORK_HOME_NEVER_COPY, checkForkIsolation, ensureForkWorkdir, forkGapsCheck, forkRolloutPath, readLastTurnContextModel, rewriteRollout, rewriteTrustedProjects, uuidV7 } from "./codex-lifecycle-fork.js";
import { receiptVerdict, type ReceiptCheck } from "./codex-lifecycle-receipt.js";

const SRC = "01a02193-e1fd-70f3-9e16-6fbff295fbae";
const NEW = "01a0aaaa-0000-7000-8000-000000000001";
const meta = (id: string) => JSON.stringify({ timestamp: "2026-08-20T23:48:55Z", type: "session_meta", payload: { id, session_id: id, cwd: "/w" } });

function fixture(lines: string[]): { dir: string; src: string } {
  const dir = mkdtempSync(join(tmpdir(), "anet-fork-"));
  const src = join(dir, "src.jsonl");
  writeFileSync(src, lines.join("\n") + "\n");
  return { dir, src };
}

describe("#1856 PR-C fork: rollout rewrite", () => {
  test("rewrites every occurrence of the source id, keeps byte size, writes 0600 into a fresh path", async () => {
    const { dir, src } = fixture([meta(SRC), `{"type":"event","payload":{"turn":"x","session":"${SRC}"}}`, `{"type":"msg","payload":{"text":"no id here"}}`]);
    const dst = join(dir, "sessions", "2026", "09", "09", `rollout-x-${NEW}.jsonl`);
    const r = await rewriteRollout(src, dst, SRC, NEW);
    expect(r.lines).toBe(3);
    expect(r.replacements).toBe(3); // id + session_id on line 1, session on line 2
    expect(r.bytesIn).toBe(r.bytesOut);
    expect(statSync(dst).size).toBe(r.bytesOut);
    expect(statSync(dst).mode & 0o777).toBe(0o600);
    const out = readFileSync(dst, "utf8");
    expect(out.includes(SRC)).toBe(false);
    expect(JSON.parse(out.split("\n")[0]).payload.session_id).toBe(NEW);
  });

  test("relocates the recorded cwd in every line and accounts for the byte delta", async () => {
    const { dir, src } = fixture([meta(SRC), `{"type":"turn_context","payload":{"cwd":"/w","x":"${SRC}"}}`, `{"type":"msg","payload":{"cwdish":"/w/not-a-cwd-field"}}`]);
    const dst = join(dir, "out.jsonl");
    const r = await rewriteRollout(src, dst, SRC, NEW, { from: "/w", to: "/new/workdir" });
    expect(r.cwdReplacements).toBe(2); // session_meta + turn_context; the look-alike field is untouched
    expect(r.expectedBytesOut).toBe(r.bytesIn + 2 * ("/new/workdir".length - "/w".length));
    expect(r.bytesOut).toBe(r.expectedBytesOut);
    const out = readFileSync(dst, "utf8");
    expect(JSON.parse(out.split("\n")[0]).payload.cwd).toBe("/new/workdir");
    expect(out).toContain("/w/not-a-cwd-field");
  });

  test("first line not session_meta for the source id → refuses before writing anything", async () => {
    const { dir, src } = fixture([meta("01a02193-e1fd-70f3-9e16-6fbff295fbaf"), "{}"]);
    const dst = join(dir, "out.jsonl");
    await expect(rewriteRollout(src, dst, SRC, NEW)).rejects.toThrow(/not session_meta/);
    expect(existsSync(dst)).toBe(false);
    const bad = fixture(["not json", "{}"]);
    await expect(rewriteRollout(bad.src, join(bad.dir, "o.jsonl"), SRC, NEW)).rejects.toThrow(/not JSON/);
    expect(existsSync(join(bad.dir, "o.jsonl"))).toBe(false);
  });

  test("refuses same id, malformed ids, existing target, and empty source", async () => {
    const { dir, src } = fixture([meta(SRC)]);
    await expect(rewriteRollout(src, join(dir, "a.jsonl"), SRC, SRC)).rejects.toThrow(/equals/);
    await expect(rewriteRollout(src, join(dir, "b.jsonl"), "01a0", NEW)).rejects.toThrow(/36-char/);
    writeFileSync(join(dir, "c.jsonl"), "x");
    await expect(rewriteRollout(src, join(dir, "c.jsonl"), SRC, NEW)).rejects.toThrow(/already exists/);
    const empty = fixture([]);
    writeFileSync(empty.src, "");
    await expect(rewriteRollout(empty.src, join(empty.dir, "d.jsonl"), SRC, NEW)).rejects.toThrow(/first line|empty/);
  });
});

describe("#1856 PR-C fork: ids, paths, copy policy", () => {
  test("uuidV7 has version 7 / variant 10 and sorts after an older one", () => {
    const rand = new Uint8Array(10).fill(0xab);
    const a = uuidV7(Date.UTC(2026, 8, 9, 1, 0, 0), rand);
    const b = uuidV7(Date.UTC(2026, 8, 9, 1, 0, 1), rand);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(() => uuidV7(1, new Uint8Array(3))).toThrow();
  });
  test("forkRolloutPath follows codex's sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl layout (UTC)", () => {
    const p = forkRolloutPath("/h", new Date(Date.UTC(2026, 8, 9, 3, 4, 5)), NEW);
    expect(p).toBe(`/h/sessions/2026/09/09/rollout-2026-09-09T03-04-05-${NEW}.jsonl`);
  });
  test("copy policy: auth.json required and 0600; env file / history / sqlite / sessions never copied", () => {
    expect(FORK_HOME_COPY.find((f) => f.name === "auth.json")).toEqual({ name: "auth.json", required: true, mode: 0o600 });
    for (const n of [".anet-copresence.env", "history.jsonl", "sessions", "logs_2.sqlite"]) expect(FORK_HOME_NEVER_COPY).toContain(n);
    for (const f of FORK_HOME_COPY) expect(FORK_HOME_NEVER_COPY).not.toContain(f.name);
  });
});

describe("#1856 PR-C fork: fork_isolation", () => {
  const ok = () => ({
    source: { nodeId: "n_a", homeReal: "/a/codex-home", threadId: SRC, alias: "源", rolloutInode: 1, rolloutBytes: 100 },
    target: { nodeId: "n_b", homeReal: "/b/codex-home", threadId: NEW, alias: "叉", rolloutInode: 2, rolloutBytes: 100, envFilePresent: false },
    rewrite: { lines: 3, bytesIn: 100, bytesOut: 100, replacements: 3, cwdReplacements: 0, expectedBytesOut: 100 },
  });
  test("all five distinct + byte-equal rewrite → pass", () => {
    const c = checkForkIsolation(ok());
    expect(c.status).toBe("pass");
    expect(c.evidence).toMatchObject({ targetThread: NEW, idReplacements: 3 });
  });
  test("each shared identity fails on its own", () => {
    const cases: Array<[string, (s: any) => void]> = [
      ["node_id", (s) => { s.target.nodeId = "n_a"; }],
      ["CODEX_HOME", (s) => { s.target.homeReal = "/a/codex-home"; }],
      ["thread id", (s) => { s.target.threadId = SRC; }],
      ["alias", (s) => { s.target.alias = "源"; }],
      ["rollout not a separate", (s) => { s.target.rolloutInode = 1; }],
      ["rollout size", (s) => { s.rewrite.bytesOut = 99; }],
      ["never appeared", (s) => { s.rewrite.replacements = 0; }],
      ["env file", (s) => { s.target.envFilePresent = true; }],
      ["not rewritten", (s) => { s.rewrite = null; }],
    ];
    for (const [needle, mutate] of cases) {
      const s = ok(); mutate(s);
      const c = checkForkIsolation(s);
      expect(c.status).toBe("fail");
      expect(c.detail).toContain(needle);
    }
  });
});

describe("#1856 PR-C fork verdict", () => {
  const pass = (key: string): ReceiptCheck => ({ key, status: "pass", detail: "ok" });
  const req = ["identity_match", "fork_isolation", "home_isolated", "workdir_consistent", "session_exact"].map(pass);
  test("a source-side fail (its own workdir gap) is informational; a target-side extra fail still blocks", () => {
    const withSourceGap = [...req, { key: "source:workdir_consistent", status: "fail", detail: "config.codexProjectDir is missing" } as ReceiptCheck, { key: "identity_attested", status: "unknown", detail: "not started" } as ReceiptCheck];
    expect(receiptVerdict("fork", withSourceGap)).toEqual({ verdict: "PASS", blocking: [] });
    const withTargetGap = [...req, { key: "port_owner_verified", status: "fail", detail: "foreign" } as ReceiptCheck];
    expect(receiptVerdict("fork", withTargetGap).blocking).toEqual(["port_owner_verified"]);
  });
  test("fork does not require identity_attested but does require session_exact on the target", () => {
    expect(receiptVerdict("fork", req.filter((c) => c.key !== "session_exact")).blocking).toEqual(["session_exact"]);
  });
});

describe("#1856 PR-D config round-trip", () => {
  test("codexProjectDir survives serializeProfileForConfigJson (the field whitelist)", async () => {
    const { serializeProfileForConfigJson } = await import("./profile-serialize.js");
    const out = serializeProfileForConfigJson({ node_id: "n", runtime: "codex-app-server", codexProjectDir: "/w" } as any, { node_id: "n", runtime: "codex-app-server", codexProjectDir: "/w" } as any);
    expect((out as any).codexProjectDir).toBe("/w");
  });
});

describe("#1951 fork CLI gaps", () => {
  test("gap 1: ensureForkWorkdir creates a missing dir (recursively) and refuses a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-fork-wd-"));
    const fresh = join(dir, "a", "b", "c");
    expect(ensureForkWorkdir(fresh)).toEqual({ created: true });
    expect(statSync(fresh).isDirectory()).toBe(true);
    expect(ensureForkWorkdir(fresh)).toEqual({ created: false });
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => ensureForkWorkdir(file)).toThrow(/exists but is not a directory/);
  });

  test("gap 2: rewriteTrustedProjects renames only the source table header; other tables and values stay byte-identical", () => {
    const toml = [
      'model = "gpt-5"',
      '[projects."/ws/source"]',
      'trust_level = "trusted"',
      '',
      '[projects."/ws/other"]',
      'trust_level = "trusted"',
      '# a comment mentioning /ws/source in prose',
      'note = "/ws/source"',
      '',
      '[model_providers.foo]',
      'base_url = "http://127.0.0.1:1/ws/source"',
    ].join("\n");
    const r = rewriteTrustedProjects(toml, "/ws/source", "/ws/target");
    expect(r.rewritten).toBe(1);
    expect(r.dropped).toBe(0);
    const lines = r.text.split("\n");
    expect(lines[1]).toBe('[projects."/ws/target"]');
    expect(lines[4]).toBe('[projects."/ws/other"]');
    expect(lines[6]).toBe('# a comment mentioning /ws/source in prose'); // prose untouched
    expect(lines[7]).toBe('note = "/ws/source"'); // values untouched
    expect(lines[10]).toBe('base_url = "http://127.0.0.1:1/ws/source"'); // provider block untouched
    expect(r.text.split("\n").length).toBe(toml.split("\n").length);
  });

  test("gap 2: when the target table already exists the source table is dropped, not duplicated", () => {
    const toml = ['[projects."/ws/source"]', 'trust_level = "trusted"', 'extra = 1', '[projects."/ws/target"]', 'trust_level = "trusted"'].join("\n");
    const r = rewriteTrustedProjects(toml, "/ws/source", "/ws/target");
    expect(r.rewritten).toBe(0);
    expect(r.dropped).toBe(1);
    expect(r.text).toBe(['[projects."/ws/target"]', 'trust_level = "trusted"'].join("\n"));
    expect(rewriteTrustedProjects(toml, "/ws/source", "/ws/source").rewritten).toBe(0);
  });

  test("gap 3: readLastTurnContextModel reads the LAST turn_context from the tail, not the first", () => {
    const { src } = fixture([
      meta(SRC),
      `{"type":"turn_context","payload":{"cwd":"/w","model":"gpt-a","model_provider":"prov-a"}}`,
      `{"type":"event_msg","payload":{"text":"turn_context in a string must not count"}}`,
      `{"type":"turn_context","payload":{"cwd":"/w","model":"gpt-b"}}`,
      `{"type":"event_msg","payload":{"text":"tail"}}`,
    ]);
    expect(readLastTurnContextModel(src)).toEqual({ model: "gpt-b", provider: null });
    expect(readLastTurnContextModel(src, 64)).toEqual({ model: null, provider: null }); // tail window too small → unknown, never a guess
    const none = fixture([meta(SRC), `{"type":"event_msg","payload":{}}`]);
    expect(readLastTurnContextModel(none.src)).toEqual({ model: null, provider: null });
  });

  test("gap 5: AGENTS.md rides along in the CODEX_HOME copy whitelist (optional, 0600)", () => {
    const entry = FORK_HOME_COPY.find((f) => f.name === "AGENTS.md");
    expect(entry).toEqual({ name: "AGENTS.md", required: false, mode: 0o600 });
    expect(FORK_HOME_NEVER_COPY).not.toContain("AGENTS.md");
  });

  test("gap 4 + receipt: fork_options is informational (pass) and carries every gap fact verbatim", () => {
    const facts = { workdir_created: true, trusted_rewritten: 1, trusted_dropped: 0, model_override: "gpt-x", source_last_model: "gpt-a", port: 24723, agents_md_carried: true };
    const c = forkGapsCheck(facts);
    expect(c.key).toBe("fork_options");
    expect(c.status).toBe("pass");
    expect(c.evidence).toEqual(facts);
    expect(c.detail).toContain("port 24723");
    expect(c.detail).toContain("source last ran gpt-a");
    expect(receiptVerdict("fork", [c]).blocking).not.toContain("fork_options");
  });
});
