import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonProviderStore } from "./daemon-provider-store";
import { readProviderInput, runDaemonProvider } from "./daemon-provider-command";

const roots: string[] = [];
const SECRET = "fixture-key-never-in-a-response";
function setup(network = "net_a", daemon = "daemon_a") {
  const root = mkdtempSync(join(tmpdir(), "provider906-")); roots.push(root);
  const dir = join(root, "daemon"); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ role: "host_supervisor", node_id: daemon, network_id: network }), { mode: 0o600 });
  return { root, dir, store: new DaemonProviderStore(dir) };
}
function keyProvider(key: string | undefined = SECRET) {
  return { id: "deepseek", label: "DeepSeek", enabled: true,
    runtimes: [{ runtime: "codex-tui", auth: [{ id: "work", kind: "api_key", baseUrl: "https://api.example.test/v1", models: ["model-a"], ...(key ? { key } : {}) }] }] };
}
const official = () => ({ id: "openai", label: "OpenAI", enabled: true,
  runtimes: [{ runtime: "codex-tui", auth: [{ id: "personal", kind: "chatgpt", models: ["model-b"] }] }] });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("#906 daemon Provider persistence", () => {
  test('saved login binds only to its owning daemon, without exposing credentials', () => {
    const { store } = setup();
    const { root } = store.prepareLoginDirectory();
    const home = join(root, 'login-fixture'); mkdirSync(home, { mode: 0o700 });
    const account = '11111111-1111-4111-8111-111111111111';
    const record = { version: 1, network_id: 'net_a', daemon_node_id: 'daemon_a', account_id: account };
    writeFileSync(join(home, 'anet-account.json'), JSON.stringify(record), { mode: 0o600 });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: SECRET, refresh_token: 'TEST-ONLY-refresh' } }), { mode: 0o600 });
    const p: any = official(); p.runtimes[0].auth[0].account_id = account;
    const result = store.upsert(p, 0);
    expect(result.providers[0].runtimes[0].auth[0]).toMatchObject({ account_id: account, credential_present: true, verification: 'not_checked', application: 'not_applied' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(root);
    // Login removed after configuration: readback retains the reference, not a false presence claim.
    rmSync(join(home, 'auth.json'));
    expect(store.list().providers[0].runtimes[0].auth[0].credential_present).toBe(false);
    expect(() => store.upsert(p, 1)).toThrow('saved_account_unavailable');
    expect(store.list().revision).toBe(1);
  });
  test('foreign saved login and path-shaped account refs cannot be bound', () => {
    const { store } = setup(), { root } = store.prepareLoginDirectory();
    const home = join(root, 'login-fixture'); mkdirSync(home, { mode: 0o700 });
    const account = '11111111-1111-4111-8111-111111111111';
    writeFileSync(join(home, 'anet-account.json'), JSON.stringify({ version: 1, network_id: 'net_a', daemon_node_id: 'daemon_b', account_id: account }), { mode: 0o600 });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: SECRET, refresh_token: 'TEST-ONLY-refresh' } }), { mode: 0o600 });
    const p: any = official(); p.runtimes[0].auth[0].account_id = account;
    expect(() => store.upsert(p, 0)).toThrow('saved_account_unavailable');
    p.runtimes[0].auth[0].account_id = '../other-node/auth.json';
    expect(() => store.upsert(p, 0)).toThrow('invalid_account_id');
    const key: any = keyProvider(); key.runtimes[0].auth[0].account_id = account;
    expect(() => store.upsert(key, 0)).toThrow('unsupported_auth_combination');
    expect(store.list().revision).toBe(0);
  });
  test("list is read-only and starts unknown, with no auto-created state", () => {
    const { dir, store } = setup();
    expect(store.list()).toEqual({ network_id: "net_a", daemon_node_id: "daemon_a", source: "daemon", revision: 0, providers: [] });
    expect(existsSync(join(dir, "provider-store"))).toBe(false);
  });
  test("API key saves privately and roundtrips across process instances without echo", () => {
    const { dir, store } = setup(); const result = store.upsert(keyProvider(), 0);
    expect(result.revision).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(new DaemonProviderStore(dir).list()).toEqual(result);
    expect(readFileSync(join(dir, "provider-store/state.json"), "utf8")).toContain(SECRET);
    expect(statSync(join(dir, "provider-store/state.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "provider-store")).mode & 0o777).toBe(0o700);
    expect(result.providers[0].runtimes[0].auth[0]).toMatchObject({ credential_present: true, verification: "not_checked", application: "not_applied" });
  });
  test("official identity has no claimed login or key; both modes can coexist", () => {
    const { store } = setup(); store.upsert(official(), 0);
    const result = store.upsert(keyProvider(), 1);
    expect(result.providers.map(x => x.id)).toEqual(["openai", "deepseek"]);
    expect(result.providers[0].runtimes[0].auth[0]).toMatchObject({ kind: "chatgpt", credential_present: false });
  });
  test("omitted key preserves prior value; blank key is not a credential-delete shortcut", () => {
    const { store, dir } = setup(); store.upsert(keyProvider(), 0);
    const edit = keyProvider(undefined); delete edit.runtimes[0].auth[0].key; edit.label = "Renamed";
    expect(store.upsert(edit, 1).providers[0].label).toBe("Renamed");
    expect(readFileSync(join(dir, "provider-store/state.json"), "utf8")).toContain(SECRET);
    edit.runtimes[0].auth[0].key = "";
    expect(() => store.upsert(edit, 2)).toThrow("api_key_required");
    expect(store.list().revision).toBe(2);
  });
  test("stale revision cannot clobber another writer; no partial write or leftover lock", () => {
    const { store, dir } = setup(); const second = new DaemonProviderStore(dir);
    store.upsert(keyProvider(), 0);
    expect(() => second.upsert(official(), 0)).toThrow("revision_conflict");
    expect(store.list().providers).toHaveLength(1);
    expect(existsSync(join(dir, "provider-store/write.lock"))).toBe(false);
  });
  test("another daemon and network do not inherit configuration or credentials", () => {
    const a = setup(), b = setup("net_b", "daemon_b"); a.store.upsert(keyProvider(), 0);
    expect(b.store.list().providers).toEqual([]);
    cpSync(join(a.dir, "provider-store"), join(b.dir, "provider-store"), { recursive: true });
    // cp's destination mode is runtime/umask dependent. Satisfy the filesystem
    // gate so this negative specifically reaches the persisted identity gate.
    chmodSync(join(b.dir, "provider-store"), 0o700);
    chmodSync(join(b.dir, "provider-store/state.json"), 0o600);
    expect(() => b.store.list()).toThrow("scope_mismatch");
    expect(() => b.store.upsert(official(), 1)).toThrow("scope_mismatch");
  });
  test("same-network different daemon and same-daemon different network are both refused", () => {
    const a = setup(); a.store.upsert(keyProvider(), 0);
    for (const scope of [{ network_id: "net_a", node_id: "daemon_b" }, { network_id: "net_b", node_id: "daemon_a" }]) {
      writeFileSync(join(a.dir, "config.json"), JSON.stringify({ role: "host_supervisor", ...scope }));
      expect(() => new DaemonProviderStore(a.dir).list()).toThrow("scope_mismatch");
    }
  });
  test("changing endpoint never silently reuses the old endpoint's key", () => {
    const { store } = setup(); store.upsert(keyProvider(), 0);
    const p = keyProvider(); delete p.runtimes[0].auth[0].key;
    p.runtimes[0].auth[0].baseUrl = "https://another.example.test/v1";
    expect(() => store.upsert(p, 1)).toThrow("endpoint_change_requires_key");
    expect(store.list().revision).toBe(1);
  });
  test("active writer lock refuses update; no automatic stale-lock stealing", () => {
    const { store, dir } = setup(); store.upsert(keyProvider(), 0);
    writeFileSync(join(dir, "provider-store/write.lock"), "", { mode: 0o600 });
    expect(() => store.upsert(official(), 1)).toThrow("provider_store_busy");
    expect(store.list().revision).toBe(1);
  });
  test("permissions changed after construction are rejected, not silently repaired", () => {
    const { store, dir } = setup(); store.upsert(keyProvider(), 0);
    chmodSync(join(dir, "provider-store"), 0o755);
    expect(() => store.upsert(official(), 1)).toThrow("unsafe_provider_directory");
    expect(statSync(join(dir, "provider-store")).mode & 0o777).toBe(0o755);
  });
  test("unsupported auth/runtime and duplicate ids are rejected without applying", () => {
    const { store } = setup();
    const bad: any = official(); bad.id = "deepseek";
    expect(() => store.upsert(bad, 0)).toThrow("unsupported_auth_combination");
    bad.id = "openai"; bad.runtimes[0].runtime = "claude";
    expect(() => store.upsert(bad, 0)).toThrow("unsupported_runtime");
    bad.runtimes[0].runtime = "codex-tui"; bad.runtimes.push(bad.runtimes[0]);
    expect(() => store.upsert(bad, 0)).toThrow("duplicate_id");
    expect(store.list().revision).toBe(0);
  });
  test("secret in official login, endpoint auth/query, unknown fields, invalid ids refused", () => {
    const { store } = setup(); const login: any = official(); login.runtimes[0].auth[0].key = SECRET;
    expect(() => store.upsert(login, 0)).toThrow("unsupported_auth_combination");
    for (const baseUrl of ["http://api.example.test", "https://user:password@api.example.test", "https://api.example.test?key=secret"]) {
      const p = keyProvider(); p.runtimes[0].auth[0].baseUrl = baseUrl;
      expect(() => store.upsert(p, 0)).toThrow("invalid_endpoint");
    }
    expect(() => store.upsert({ ...keyProvider(), token: SECRET }, 0)).toThrow("unsupported_field");
    expect(() => store.upsert({ ...keyProvider(), id: "../outside" }, 0)).toThrow("invalid_id");
  });
  test("symlinked state/root and nonprivate state fail closed", () => {
    const { store, dir, root } = setup(); store.upsert(keyProvider(), 0);
    const statePath = join(dir, "provider-store/state.json"); chmodSync(statePath, 0o644);
    expect(() => store.list()).toThrow("unsafe_private_file"); chmodSync(statePath, 0o600);
    const target = join(root, "outside.json"); writeFileSync(target, "{}", { mode: 0o600 });
    rmSync(statePath); symlinkSync(target, statePath);
    expect(() => store.list()).toThrow("unsafe_private_file");
    expect(() => store.upsert(keyProvider(), 1)).toThrow("unsafe_private_file");
    expect(readFileSync(target, "utf8")).toBe("{}");
  });
  test("invalid daemon role, identity, config permissions refuse store", () => {
    const { dir } = setup(); const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ role: "agent", node_id: "a", network_id: "n" }));
    expect(() => new DaemonProviderStore(dir)).toThrow("not_a_daemon");
    writeFileSync(config, JSON.stringify({ role: "host_supervisor" }));
    expect(() => new DaemonProviderStore(dir)).toThrow("daemon_identity_required");
    chmodSync(config, 0o644); expect(() => new DaemonProviderStore(dir)).toThrow("unsafe_private_file");
  });
  test("root symlink and hard-linked state cannot become writable configuration", () => {
    const { store, dir, root } = setup(); store.upsert(keyProvider(), 0);
    linkSync(join(dir, "provider-store/state.json"), join(root, "copy"));
    expect(() => store.list()).toThrow("unsafe_private_file");
    expect(() => store.upsert(official(), 1)).toThrow("unsafe_private_file");
    const b = setup(); symlinkSync(join(dir, "provider-store"), join(b.dir, "provider-store"));
    expect(() => new DaemonProviderStore(b.dir)).toThrow("unsafe_provider_directory");
  });
  test("input reader enforces its byte bound before JSON parsing", () => {
    const { root } = setup(); const path = join(root, "input");
    writeFileSync(path, "x".repeat(65537)); const fd = openSync(path, "r");
    try { expect(() => readProviderInput(fd)).toThrow("input_too_large"); } finally { closeSync(fd); }
    writeFileSync(path, JSON.stringify(official())); const next = openSync(path, "r");
    try { expect(JSON.parse(readProviderInput(next))).toEqual(official()); } finally { closeSync(next); }
  });
  test("CLI management roundtrip has scoped public output and no key or raw parser error", () => {
    const { root } = setup(); const lines: string[] = [];
    const deps = { nodesDir: root, readInput: () => JSON.stringify(keyProvider()), print: (line: string) => lines.push(line) };
    expect(runDaemonProvider(["put", "daemon", "--revision", "0"], deps)).toBe(0);
    expect(runDaemonProvider(["list", "daemon"], deps)).toBe(0);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, revision: 1, daemon_node_id: "daemon_a" });
    deps.readInput = () => `{ "key": "${SECRET}`;
    expect(runDaemonProvider(["put", "daemon", "--revision", "1"], deps)).toBe(1);
    expect(JSON.parse(lines.at(-1)!)).toEqual({ ok: false, error: "invalid_json" });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(runDaemonProvider(["put", "../escape", "--revision", "0"], deps)).toBe(2);
    expect(runDaemonProvider(["put", "daemon", "--key", SECRET], deps)).toBe(2);
  });
});
