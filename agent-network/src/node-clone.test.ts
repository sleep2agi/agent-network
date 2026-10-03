import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneRefusal,
  defaultClonePersist,
  formatCloneSummary,
  isAsciiPath,
  parseCloneArgs,
  planCloneProfile,
  runNodeClone,
  sanitizeMcpJson,
  type RunCloneInput,
} from "./node-clone";

// #509 — a clone must be a NEW identity carrying the source's settings, never a second
// holder of the source's node_id / token (that is what `cp -r` of a node dir does, and the
// Hub then delivers every task to both processes).

const SRC_TOKEN = "ntok_SOURCE_SECRET_aaaaaaaaaaaaaaaa";
const SRC_SECRET = "sk-source-vendor-secret-bbbbbbbb";
const SRC_SESSION = "11111111-2222-4333-8444-555555555555";
const SRC_THREAD = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

let root: string;
let work: string;

function writeSourceNode(runtime = "claude-code-cli", extra: Record<string, any> = {}) {
  const nodeDir = join(work, ".anet", "nodes", "alpha");
  mkdirSync(nodeDir, { recursive: true });
  const cfg = {
    anet_version: "0.1.0",
    node_id: "n_srcsrc01",
    node_name: "alpha",
    runtime,
    network_id: "net_1",
    hub: "http://127.0.0.1:1",
    token: SRC_TOKEN,
    model: "claude-sonnet-x",
    tools: ["Read", "Bash"],
    channels: ["server:commhub", "plugin:telegram@claude-plugins-official"],
    env: { ANTHROPIC_BASE_URL: "https://vendor.invalid", ANTHROPIC_AUTH_TOKEN: { _envRef: "ANTHROPIC_AUTH_TOKEN_N_SRCSRC01" }, LEGACY_API_KEY: SRC_SECRET },
    flags: { dangerouslySkipPermissions: true, teammateMode: "in-process" },
    session: SRC_SESSION,
    codexThreadId: SRC_THREAD,
    systemPrompt: "You are alpha's twin.",
    ...extra,
  };
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify(cfg, null, 2));
  writeFileSync(join(nodeDir, ".env"), `ANTHROPIC_AUTH_TOKEN_N_SRCSRC01=${SRC_SECRET}\n`);
  mkdirSync(join(nodeDir, "logs"));
  writeFileSync(join(nodeDir, "logs", "node.log"), `token=${SRC_TOKEN}\n`);
  writeFileSync(join(nodeDir, ".pid"), "4242\n");
  writeFileSync(join(nodeDir, "goals.json"), "[]");
  writeFileSync(join(nodeDir, "copresence-identity.json"), `{"marker":"m"}`);
  writeFileSync(join(nodeDir, "grok-leader.sock"), "");
  mkdirSync(join(nodeDir, "channels", "telegram"), { recursive: true });
  writeFileSync(join(nodeDir, "channels", "telegram", "access.json"), `{"botToken":"123:ABC"}`);
  const home = join(nodeDir, "codex-home");
  mkdirSync(join(home, "sessions", "2026", "10", "03"), { recursive: true });
  writeFileSync(join(home, "auth.json"), `{"tokens":{"refresh_token":"rt-source"}}`);
  writeFileSync(join(home, ".anet-copresence.env"), `COMMHUB_TOKEN=${SRC_TOKEN}\n`);
  writeFileSync(join(home, "history.jsonl"), "{}\n");
  writeFileSync(join(home, "sessions", "2026", "10", "03", `rollout-x-${SRC_THREAD}.jsonl`), "{}\n");
  writeFileSync(join(home, "config.toml"), `model = "gpt-x"\n[projects.${JSON.stringify(work)}]\ntrust_level = "trusted"\n`);
  writeFileSync(join(home, "AGENTS.md"), "# home rules\n");
  mkdirSync(join(home, "skills", "s1"), { recursive: true });
  writeFileSync(join(home, "skills", "s1", "SKILL.md"), "---\nname: s1\n---\n");
  // workdir-level settings
  writeFileSync(join(work, "CLAUDE.md"), "# project rules\n");
  mkdirSync(join(work, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(work, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\n---\n");
  writeFileSync(join(work, ".claude", "skills", "deploy", ".env"), "X=leak\n");
  writeFileSync(join(work, ".mcp.json"), JSON.stringify({ mcpServers: { commhub: { command: "bun" }, gh: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_secret" } } } }));
  return { nodeDir, cfg };
}

function baseInput(over: Partial<RunCloneInput> = {}): RunCloneInput {
  const nodeDir = join(work, ".anet", "nodes", "alpha");
  return {
    sourceId: "alpha",
    sourceProfile: JSON.parse(readFileSync(join(nodeDir, "config.json"), "utf-8")),
    target: "beta",
    sourceNodeDir: nodeDir,
    sourceWorkdir: work,
    targetWorkdir: work,
    explicitWorkdir: false,
    newNodeId: () => "n_newnew02",
    newSession: () => "99999999-8888-4777-8666-555555555555",
    grokFields: (id) => ({ grokCopresence: true, grokLeaderSocket: `/run/x/${id}-leader.sock`, grokAttachSocket: `/run/x/${id}-attach.sock` }),
    register: async () => "ntok_CLONE_bbbbbbbbbbbbbbbbbbbb",
    persist: defaultClonePersist,
    ...over,
  };
}

/** Every file under dir, as [relativePath, content]. */
function walk(dir: string, rel = ""): [string, string][] {
  const out: [string, string][] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), r = rel ? `${rel}/${name}` : name;
    if (statSync(p).isDirectory()) out.push(...walk(p, r));
    else out.push([r, readFileSync(p, "utf-8")]);
  }
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anet-clone-"));
  work = join(root, "proj");
  mkdirSync(work);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseCloneArgs — clone and create --from are the same request", () => {
  it("parity: `clone A B` ≡ `create B --from A` (flags included)", () => {
    const a = parseCloneArgs(["alpha", "beta", "--model", "m2", "--start", "--workdir", "~/x"], "clone");
    const b = parseCloneArgs(["beta", "--from", "alpha", "--workdir", "~/x", "--start", "--model", "m2"], "create-from");
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    if (a.ok) expect(a.args).toEqual({ source: "alpha", target: "beta", workdir: "~/x", model: "m2", start: true });
  });
  it("rejects create-only flags instead of silently dropping them", () => {
    const r = parseCloneArgs(["alpha", "beta", "--runtime", "codex-sdk"], "clone");
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) expect(r.error).toContain("--runtime");
    const u = parseCloneArgs(["beta", "--from", "alpha", "--bogus"], "create-from");
    expect(u.ok).toBe(false);
  });
  it("arity and missing --from", () => {
    expect(parseCloneArgs(["alpha"], "clone").ok).toBe(false);
    expect(parseCloneArgs(["beta"], "create-from").ok).toBe(false);
    expect(parseCloneArgs(["beta", "--from"], "create-from").ok).toBe(false);
    expect(parseCloneArgs(["--help"], "clone")).toEqual({ ok: false, help: true });
  });
});

describe("runNodeClone — new identity, settings carried, secrets and state left behind", () => {
  it("identity fields differ; token is the Hub's new one; settings are equal", async () => {
    const { cfg } = writeSourceNode();
    const seen: Record<string, any>[] = [];
    const r = await runNodeClone(baseInput({ register: async (p) => { seen.push(structuredClone(p)); return "ntok_CLONE_bbbbbbbbbbbbbbbbbbbb"; } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the Hub was asked to register the NEW identity, not the source's
    expect(seen).toHaveLength(1);
    expect(seen[0]!.node_id).toBe("n_newnew02");
    expect(seen[0]!.node_name).toBe("beta");
    expect(seen[0]!.token).toBeUndefined();

    const written = JSON.parse(readFileSync(join(work, ".anet", "nodes", "beta", "config.json"), "utf-8"));
    expect(written.node_id).not.toBe(cfg.node_id);
    expect(written.node_name).toBe("beta");
    expect(written.token).toBe("ntok_CLONE_bbbbbbbbbbbbbbbbbbbb");
    expect(written.token).not.toBe(SRC_TOKEN);
    expect(written.session).not.toBe(SRC_SESSION);
    expect(written.codexThreadId).toBeUndefined();
    // settings
    expect(written.runtime).toBe(cfg.runtime);
    expect(written.model).toBe(cfg.model);
    expect(written.tools).toEqual(cfg.tools);
    expect(written.flags).toEqual(cfg.flags);
    expect(written.systemPrompt).toBe(cfg.systemPrompt);
    expect(written.network_id).toBe(cfg.network_id);
    expect(written.channels).toEqual(["server:commhub"]);
    expect(written.env.ANTHROPIC_BASE_URL).toBe("https://vendor.invalid");
  });

  it("no source token, secret value, session, log or login anywhere in the clone's directory", async () => {
    writeSourceNode();
    const r = await runNodeClone(baseInput());
    expect(r.ok).toBe(true);
    const files = walk(join(work, ".anet", "nodes", "beta"));
    const names = files.map(([p]) => p).sort();
    expect(names).toEqual(["codex-home/AGENTS.md", "codex-home/config.toml", "codex-home/skills/s1/SKILL.md", "config.json"]);
    for (const [p, body] of files) {
      expect(`${p}:${body}`).not.toContain(SRC_TOKEN);
      expect(`${p}:${body}`).not.toContain(SRC_SECRET);
      expect(`${p}:${body}`).not.toContain(SRC_SESSION);
      expect(`${p}:${body}`).not.toContain(SRC_THREAD);
      expect(`${p}:${body}`).not.toContain("rt-source");
    }
    // positive control: the walk does see the source's secrets in the source dir
    const srcBlob = walk(join(work, ".anet", "nodes", "alpha")).map(([p, b]) => `${p}:${b}`).join("\n");
    for (const s of [SRC_TOKEN, SRC_SECRET, SRC_THREAD, "rt-source"]) expect(srcBlob).toContain(s);
    expect(statSync(join(work, ".anet", "nodes", "beta", "codex-home")).mode & 0o777).toBe(0o700);
    expect(statSync(join(work, ".anet", "nodes", "beta", "config.json")).mode & 0o777).toBe(0o600);
  });

  it("secret env keys are kept as an envRef named for the NEW node; values never copied", async () => {
    writeSourceNode();
    const r = await runNodeClone(baseInput());
    if (!r.ok) throw new Error(r.error);
    const env = JSON.parse(readFileSync(join(r.targetNodeDir, "config.json"), "utf-8")).env;
    expect(env.ANTHROPIC_AUTH_TOKEN).toEqual({ _envRef: "ANTHROPIC_AUTH_TOKEN_N_NEWNEW02" });
    expect(env.LEGACY_API_KEY).toEqual({ _envRef: "LEGACY_API_KEY_N_NEWNEW02" });
    expect(r.ledger.secrets.map((s) => s.key).sort()).toEqual(["ANTHROPIC_AUTH_TOKEN", "LEGACY_API_KEY"]);
    expect(existsSync(join(r.targetNodeDir, ".env"))).toBe(false);
  });

  it("the summary lists copied / regenerated / skipped and never prints a token or secret", async () => {
    writeSourceNode();
    const r = await runNodeClone(baseInput());
    if (!r.ok) throw new Error(r.error);
    const text = formatCloneSummary({ source: "alpha", target: "beta", profile: r.profile, ledger: r.ledger, targetNodeDir: r.targetNodeDir, sourceNodeId: "n_srcsrc01" });
    for (const h of ["copied (", "regenerated (", "skipped ("]) expect(text).toContain(h);
    for (const item of ["token", "codex-home/auth.json", "logs", ".env", "channels", "codexThreadId"]) expect(text).toContain(`- ${item}`);
    expect(text).toContain("n_srcsrc01 → n_newnew02");
    expect(text).not.toContain(SRC_TOKEN);
    expect(text).not.toContain("ntok_CLONE");
    expect(text).not.toContain(SRC_SECRET);
    expect(text).toContain("codex account install beta");
  });

  it("same workdir: rules/skills/.mcp.json are shared, not duplicated", async () => {
    writeSourceNode();
    const r = await runNodeClone(baseInput());
    if (!r.ok) throw new Error(r.error);
    expect(r.ledger.copied.some((c) => c.note?.includes("shared"))).toBe(true);
  });

  it("--workdir: rules file, skills and a sanitized .mcp.json are copied; codex trust is rewritten", async () => {
    writeSourceNode();
    const other = join(root, "other-proj");
    mkdirSync(other);
    const r = await runNodeClone(baseInput({ targetWorkdir: other, explicitWorkdir: true }));
    if (!r.ok) throw new Error(r.error);
    expect(r.targetNodeDir).toBe(join(other, ".anet", "nodes", "beta"));
    expect(readFileSync(join(other, "CLAUDE.md"), "utf-8")).toBe("# project rules\n");
    expect(existsSync(join(other, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(other, ".claude", "skills", "deploy", ".env"))).toBe(false);
    const mcp = JSON.parse(readFileSync(join(other, ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.commhub).toBeUndefined();
    expect(mcp.mcpServers.gh.env.GITHUB_TOKEN).toBe("");
    const toml = readFileSync(join(r.targetNodeDir, "codex-home", "config.toml"), "utf-8");
    expect(toml).toContain(`[projects.${JSON.stringify(other)}]`);
    expect(toml).not.toContain(`[projects.${JSON.stringify(work)}]`);
  });

  it("grok co-presence sockets are regenerated from the new node_id", async () => {
    writeSourceNode("grok-build-cli", { grokCopresence: true, grokLeaderSocket: "/run/x/n_srcsrc01-leader.sock", grokAttachSocket: "/run/x/n_srcsrc01-attach.sock", grokCliSession: "g-src", session: undefined });
    const r = await runNodeClone(baseInput());
    if (!r.ok) throw new Error(r.error);
    const c = JSON.parse(readFileSync(join(r.targetNodeDir, "config.json"), "utf-8"));
    expect(c.grokLeaderSocket).toBe("/run/x/n_newnew02-leader.sock");
    expect(c.grokAttachSocket).toBe("/run/x/n_newnew02-attach.sock");
    expect(c.grokCliSession).toBeUndefined();
  });
});

describe("refusals — nothing registered, nothing written", () => {
  async function refused(over: Partial<RunCloneInput>, needle: string) {
    let registered = 0;
    const r = await runNodeClone(baseInput({ register: async () => { registered++; return "ntok_x"; }, ...over }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.stage).toBe("refused"); expect(r.error).toContain(needle); }
    expect(registered).toBe(0);
  }
  it("destination exists", async () => {
    writeSourceNode();
    mkdirSync(join(work, ".anet", "nodes", "beta"));
    await refused({}, "already exists");
  });
  it("same name as the source", async () => {
    writeSourceNode();
    await refused({ target: "alpha" }, "source node's own name");
  });
  it("into the source's own directory", async () => {
    writeSourceNode();
    await refused({ targetWorkdir: join(work, ".anet", "nodes", "alpha"), explicitWorkdir: true }, "source node's own directory");
  });
  it("non-ASCII --workdir", async () => {
    writeSourceNode();
    await refused({ targetWorkdir: join(root, "吉他大师"), explicitWorkdir: true }, "ASCII");
    expect(existsSync(join(root, "吉他大师"))).toBe(false);
  });
  it("opencode-cli and host daemons", async () => {
    writeSourceNode("opencode-cli");
    await refused({}, "opencode-cli");
    rmSync(join(work, ".anet"), { recursive: true });
    writeSourceNode("claude-agent-sdk", { role: "host_supervisor" });
    await refused({}, "host daemon");
  });
  it("a failed Hub registration leaves no directory behind", async () => {
    writeSourceNode();
    const r = await runNodeClone(baseInput({ register: async () => { throw new Error("hub down"); } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe("register");
    expect(existsSync(join(work, ".anet", "nodes", "beta"))).toBe(false);
  });
  it("a Hub that hands back the source's own token is refused", async () => {
    writeSourceNode();
    const r = await runNodeClone(baseInput({ register: async () => SRC_TOKEN }));
    expect(r.ok).toBe(false);
    expect(existsSync(join(work, ".anet", "nodes", "beta"))).toBe(false);
  });
});

describe("CLI wiring (bin/cli.ts)", () => {
  const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");
  const at = CLI.indexOf("async function createCommand(");
  const create = CLI.slice(at, at + 4000);
  it("`node create … --from <src>` routes to the clone path before any default-node work", () => {
    const route = create.indexOf('args.includes("--from")) return await nodeCloneCommand(args.slice(1), "create-from")');
    expect(route).toBeGreaterThan(0);
    expect(route).toBeLessThan(create.indexOf("const id = idOverride || args[1];"));
  });
  it("`node clone` is dispatched and uses create's registration + writer", () => {
    expect(CLI).toContain('case "clone": await nodeCloneCommand(args.slice(2), "clone"); break;');
    const fn = CLI.slice(CLI.indexOf("async function nodeCloneCommand("), at);
    expect(fn).toContain("register: (p) => requestNodeToken(p as Profile, a.target)");
    expect(fn).toContain("saveCreatedNode(a.target, p as Profile)");
  });
});

describe("pure helpers", () => {
  it("isAsciiPath", () => {
    expect(isAsciiPath("/home/user/guitar-master")).toBe(true);
    expect(isAsciiPath("/home/user/吉他大师")).toBe(false);
  });
  it("planCloneProfile never carries token/node_id/session/thread", () => {
    const { profile } = planCloneProfile({
      sourceProfile: { node_id: "n_a", token: SRC_TOKEN, runtime: "codex-app-server", session: "s", codexThreadId: SRC_THREAD, codexHome: "/x", codexAppServerUrl: "ws://127.0.0.1:1", flags: {}, env: {}, channels: [] },
      target: "b", newNodeId: "n_b", targetWorkdir: "/w", newSession: () => "new",
    });
    expect(profile.token).toBeUndefined();
    expect(profile.node_id).toBe("n_b");
    for (const k of ["session", "codexThreadId", "codexHome", "codexAppServerUrl"]) expect(profile[k]).toBeUndefined();
  });
  it("cloneRefusal is null for an ordinary clone", () => {
    expect(cloneRefusal({ sourceId: "a", sourceProfile: { runtime: "claude-agent-sdk" }, target: "b", sourceNodeDir: "/p/.anet/nodes/a", targetNodeDir: join(root, "nope", "b") })).toBeNull();
  });
  it("sanitizeMcpJson blanks env and header values", () => {
    const { text, blanked } = sanitizeMcpJson(JSON.stringify({ mcpServers: { x: { headers: { Authorization: "Bearer y" } } } }));
    expect(text).not.toContain("Bearer y");
    expect(blanked).toEqual(["x.headers.Authorization"]);
  });
});
