// #622 —— daemon 逐 runtime 自检的合同。所有 fs / exec / http 都是注入的桩,
// 只有「秘密不出现在输出里」和「codex 共享计数」两组用真文件(临时 HOME)。

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  attachRuntimeReadiness,
  buildConfigSnapshot,
} from "./config-apply.js";
import {
  codexSharedCountReal,
  createRuntimeReadinessMonitor,
  extractVersion,
  httpHeadReal,
  probeRuntimeReadiness,
  proxyFor,
  realReadinessDeps,
  type ExecResult,
  type ReadinessDeps,
} from "./runtime-readiness.js";
import { codexFingerprintIndexFile } from "../codex-auth-fingerprint.js";

const HOME = "/home/user";
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

function deps(over: Partial<ReadinessDeps> & {
  files?: string[];
  bins?: Record<string, ExecResult | "hang">;
  net?: Record<string, "reachable" | "unreachable" | "hang">;
  shared?: number | null;
} = {}): ReadinessDeps & { calls: { exec: string[]; head: string[]; pathSeen: string[] } } {
  const files = new Set((over.files ?? []).map((f) => join(HOME, f)));
  const bins = over.bins ?? {};
  const net = over.net ?? {};
  const calls = { exec: [] as string[], head: [] as string[], pathSeen: [] as string[] };
  return {
    platform: "linux",
    home: HOME,
    childEnv: { PATH: CHILD_PATH, HOME, LANG: "C.UTF-8" },
    daemonEnv: { PATH: "/home/user/.nvm/bin:" + CHILD_PATH },
    fileExists: (p) => files.has(p),
    resolveOnPath: (bin, pv) => { calls.pathSeen.push(pv); return bin in bins ? `/usr/local/bin/${bin}` : null; },
    execVersion: (bin) => {
      calls.exec.push(bin);
      const name = bin.split("/").pop()!;
      const r = bins[name];
      if (r === "hang") return new Promise(() => {});
      return Promise.resolve(r ?? { kind: "error" });
    },
    httpHead: (url) => {
      calls.head.push(url);
      const host = new URL(url).host;
      const r = net[host] ?? "reachable";
      if (r === "hang") return new Promise(() => {});
      return Promise.resolve(r);
    },
    codexSharedCount: () => (over.shared === undefined ? 0 : over.shared),
    now: () => Date.parse("2026-10-06T03:00:00Z"),
    calls,
    ...over,
  } as any;
}

const OK = (v: string): ExecResult => ({ kind: "ok", stdout: v });

describe("#622 probeRuntimeReadiness —— 状态判定", () => {
  test("ready:CLI 在子进程 PATH 上 + 登录文件在 + 网络通", async () => {
    const d = deps({ bins: { claude: OK("2.1.290 (Claude Code)\n") }, files: [".claude/.credentials.json"] });
    const r = await probeRuntimeReadiness(["claude-code-cli"], d);
    const e = r["claude-code-cli"];
    expect(e.state).toBe("ready");
    expect(e.ok).toBe(true);
    expect(e.version).toBe("2.1.290");
    expect(e.cli).toBe("found");
    expect(e.auth).toBe("present");
    expect(e.network).toBe("reachable");
    expect(e.checked_at).toBe("2026-10-06T03:00:00.000Z");
    expect(d.calls.head).toEqual(["https://api.anthropic.com"]);
  });

  test("CLI 解析用的是子进程 PATH,不是 daemon 自己的 PATH", async () => {
    const d = deps({ bins: { grok: OK("grok 1.0.5") }, files: [".grok/auth.json"] });
    await probeRuntimeReadiness(["grok-build-acp"], d);
    expect(d.calls.pathSeen).toEqual([CHILD_PATH]);
  });

  test("missing_cli:PATH 上没有 grok → 不发网络请求,reason 带修法", async () => {
    const d = deps({ files: [".grok/auth.json"] });
    const e = (await probeRuntimeReadiness(["grok-build-acp"], d))["grok-build-acp"];
    expect(e.state).toBe("missing_cli");
    expect(e.ok).toBe(false);
    expect(e.cli).toBe("missing");
    expect(e.network).toBe("skipped");
    expect(e.reason).toContain("grok");
    expect(e.reason).toContain("/usr/local/bin");
    expect(d.calls.head).toEqual([]);
  });

  test("missing_cli:二进制在但 --version 失败(坏的 vendor 二进制)", async () => {
    const d = deps({ bins: { codex: { kind: "error" } }, files: [".codex/auth.json"] });
    const e = (await probeRuntimeReadiness(["codex-app-server"], d))["codex-app-server"];
    expect(e.state).toBe("missing_cli");
  });

  test("not_logged_in:CLI 在但登录文件不在 → reason 给登录命令", async () => {
    const d = deps({ bins: { codex: OK("codex-cli 0.155.1") } });
    const e = (await probeRuntimeReadiness(["codex-app-server"], d))["codex-app-server"];
    expect(e.state).toBe("not_logged_in");
    expect(e.auth).toBe("absent");
    expect(e.version).toBe("0.155.1");
    expect(e.reason).toContain("codex login --device-auth");
    expect(e.network).toBe("skipped");
  });

  test("not_logged_in:daemon 环境里有 key 但子进程拿不到 → reason 点明", async () => {
    const d = deps({ bins: { claude: OK("2.1.0") } });
    d.daemonEnv = { ...d.daemonEnv, ANTHROPIC_API_KEY: "sk-ant-PLANTED-DAEMON-ONLY-0001" };
    const e = (await probeRuntimeReadiness(["claude-code-cli"], d))["claude-code-cli"];
    expect(e.state).toBe("not_logged_in");
    expect(e.reason).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(e)).not.toContain("PLANTED");
  });

  test("API key 变量在子进程环境里也算已登录(只看名字)", async () => {
    const d = deps({});
    d.childEnv = { ...d.childEnv, ANTHROPIC_API_KEY: "sk-ant-PLANTED-0002" };
    const e = (await probeRuntimeReadiness(["claude-agent-sdk"], d))["claude-agent-sdk"];
    expect(e.state).toBe("ready");
    expect(e.cli).toBe("bundled");
    expect(JSON.stringify(e)).not.toContain("PLANTED");
  });

  test("no_network:provider 端点不通", async () => {
    const d = deps({ bins: { grok: OK("1.0.5") }, files: [".grok/auth.json"], net: { "api.x.ai": "unreachable" } });
    const e = (await probeRuntimeReadiness(["grok-build-acp"], d))["grok-build-acp"];
    expect(e.state).toBe("no_network");
    expect(e.network).toBe("unreachable");
    expect(e.reason).toContain("api.x.ai");
    expect(e.reason).toContain("HTTPS_PROXY");
  });

  test("probe 超时 → unknown(总截止时间)", async () => {
    const d = deps({ bins: { claude: OK("2.1.0") }, files: [".claude/.credentials.json"], net: { "api.anthropic.com": "hang" } });
    const t0 = Date.now();
    const e = (await probeRuntimeReadiness(["claude-code-cli"], d, { stepTimeoutMs: 50, runtimeDeadlineMs: 150 }))["claude-code-cli"];
    expect(e.state).toBe("unknown");
    expect(e.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("--version 超时 → unknown(不是 missing_cli,也不是 ready)", async () => {
    const d = deps({ bins: { claude: { kind: "timeout" } }, files: [".claude/.credentials.json"] });
    const e = (await probeRuntimeReadiness(["claude-code-cli"], d))["claude-code-cli"];
    expect(e.state).toBe("unknown");
    expect(e.cli).toBe("unknown");
  });

  test("一个 runtime 挂住不拖累别的 runtime", async () => {
    const d = deps({ bins: { claude: "hang", grok: OK("1.0.5") }, files: [".claude/.credentials.json", ".grok/auth.json"] });
    const r = await probeRuntimeReadiness(["claude-code-cli", "grok-build-acp"], d, { runtimeDeadlineMs: 100 });
    expect(r["claude-code-cli"].state).toBe("unknown");
    expect(r["grok-build-acp"].state).toBe("ready");
  });

  test("opencode 免费模型:不需要登录也 ready", async () => {
    const d = deps({ bins: { opencode: OK("1.2.3") } });
    const e = (await probeRuntimeReadiness(["opencode-cli"], d))["opencode-cli"];
    expect(e.state).toBe("ready");
    expect(e.auth).toBe("not_required");
  });

  test("codex 共享登录:只报个数,ready 时 reason 提示", async () => {
    const d = deps({ bins: { codex: OK("0.155.1") }, files: [".codex/auth.json"], shared: 27 });
    const e = (await probeRuntimeReadiness(["codex-sdk"], d))["codex-sdk"];
    expect(e.state).toBe("ready");
    expect(e.shared_login_count).toBe(27);
    expect(e.reason).toContain("27");
  });

  test("macOS 上没有 claude 凭据文件 → unknown(可能在钥匙串),不判没登录", async () => {
    const d = deps({ bins: { claude: OK("2.1.195") }, platform: "darwin" } as any);
    const e = (await probeRuntimeReadiness(["claude-code-cli"], d))["claude-code-cli"];
    expect(e.state).toBe("unknown");
  });

  test("不认识的 runtime → unknown,并提示升级", async () => {
    const e = (await probeRuntimeReadiness(["future-runtime"], deps()))["future-runtime"];
    expect(e.state).toBe("unknown");
    expect(e.reason).toContain("升级");
  });

  test("版本号只取 x.y.z,丢掉 --version 里的其它内容(可能含路径)", () => {
    expect(extractVersion("codex-cli 0.155.1 (/home/user/.nvm/x)")).toBe("0.155.1");
    expect(extractVersion("1.0.24-alpha.3")).toBe("1.0.24-alpha.3");
    expect(extractVersion("no version here")).toBeUndefined();
  });
});

describe("#622 秘密永不出现在输出里(真文件 + 埋点假 key)", () => {
  const PLANT_RT = "rt-PLANTED-SECRET-refresh-9f8e7d6c";
  const PLANT_AT = "at-PLANTED-SECRET-access-1a2b3c";
  const PLANT_KEY = "sk-PLANTED-SECRET-key-5555";
  const PLANT_CLAUDE = "claude-PLANTED-SECRET-oauth-7777";

  function plantHome(): string {
    const h = mkdtempSync(join(tmpdir(), "rr622-"));
    mkdirSync(join(h, ".codex"), { recursive: true });
    mkdirSync(join(h, ".claude"), { recursive: true });
    mkdirSync(join(h, ".grok"), { recursive: true });
    writeFileSync(join(h, ".codex", "auth.json"), JSON.stringify({ tokens: { refresh_token: PLANT_RT, access_token: PLANT_AT } }));
    writeFileSync(join(h, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: PLANT_CLAUDE } }));
    writeFileSync(join(h, ".grok", "auth.json"), JSON.stringify({ token: PLANT_CLAUDE }));
    return h;
  }

  test("全部 runtime 的结果 + 日志摘要里都不含任何埋点值", async () => {
    const h = plantHome();
    const real = realReadinessDeps({
      childEnv: { PATH: "/nonexistent-622", HOME: h, OPENAI_API_KEY: PLANT_KEY },
      daemonEnv: { ANTHROPIC_API_KEY: PLANT_KEY, HTTPS_PROXY: "http://127.0.0.1:1" },
    });
    // 网络用桩(不出网);fs / 共享计数用真实现。
    const d: ReadinessDeps = { ...real, httpHead: async () => "reachable" };
    const r = await probeRuntimeReadiness(
      ["claude-agent-sdk", "claude-code-cli", "codex-sdk", "codex-app-server", "grok-build-acp", "grok-build-cli", "opencode-cli"], d);
    const blob = JSON.stringify(r);
    for (const s of [PLANT_RT, PLANT_AT, PLANT_KEY, PLANT_CLAUDE, "PLANTED"]) expect(blob).not.toContain(s);
    // 也不含临时 HOME 路径(机器路径不出本机)。
    expect(blob).not.toContain(h);
    // 断言确实走到了登录判断,而不是因为别的原因提前返回。
    expect(r["claude-agent-sdk"].auth).toBe("present");
    expect(r["codex-sdk"].auth).toBe("present");
  });

  test("codexSharedCountReal:只数别的节点(活着的)记录,返回数字", () => {
    const h = plantHome();
    const indexDir = join(h, ".anet", "codex-auth-fingerprints");
    mkdirSync(indexDir, { recursive: true });
    const { fingerprintRefreshToken } = require("../codex-auth-fingerprint.js");
    const fp = fingerprintRefreshToken(JSON.stringify({ tokens: { refresh_token: PLANT_RT } }));
    const nodeA = mkdtempSync(join(tmpdir(), "rr622-nodeA-"));
    const nodeB = mkdtempSync(join(tmpdir(), "rr622-nodeB-"));
    const gone = join(tmpdir(), "rr622-gone-does-not-exist");
    for (const [dir, f] of [[nodeA, fp], [nodeB, fp], [gone, fp], [join(h, "other"), "deadbeef"]] as const) {
      writeFileSync(join(indexDir, codexFingerprintIndexFile(dir)), JSON.stringify({ schema_version: 3, alias: "x", fingerprint: f, written_at: new Date().toISOString(), node_dir: dir }));
    }
    expect(codexSharedCountReal(h, indexDir)).toBe(2);
  });

  test("codexSharedCountReal:没有 auth.json → null(不知道 ≠ 0)", () => {
    const h = mkdtempSync(join(tmpdir(), "rr622-empty-"));
    expect(codexSharedCountReal(h)).toBeNull();
  });
});

describe("#622 网络 HEAD 与代理", () => {
  test("proxyFor 尊重 NO_PROXY", () => {
    expect(proxyFor("api.x.ai", { HTTPS_PROXY: "http://p:3128" })).toBe("http://p:3128");
    expect(proxyFor("api.x.ai", { HTTPS_PROXY: "http://p:3128", NO_PROXY: ".x.ai" })).toBeUndefined();
    expect(proxyFor("api.x.ai", { https_proxy: "http://p:3128", no_proxy: "*" })).toBeUndefined();
    expect(proxyFor("api.x.ai", {})).toBeUndefined();
  });

  async function fakeProxy(reply: (line: string) => string | null): Promise<{ server: Server; port: number; seen: string[] }> {
    const seen: string[] = [];
    const server = createServer((sock) => {
      sock.once("data", (d) => {
        const line = d.toString().split("\r\n")[0];
        seen.push(line);
        const r = reply(line);
        if (r) sock.write(r);
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
    return { server, port: (server.address() as any).port, seen };
  }

  test("走代理:CONNECT 200 → reachable;502 → unreachable", async () => {
    const p = await fakeProxy((line) => line.startsWith("CONNECT api.anthropic.com:443")
      ? "HTTP/1.1 200 Connection established\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\n\r\n");
    try {
      const env = { HTTPS_PROXY: `http://127.0.0.1:${p.port}` };
      expect(await httpHeadReal("https://api.anthropic.com", 2_000, env)).toBe("reachable");
      expect(await httpHeadReal("https://api.x.ai", 2_000, env)).toBe("unreachable");
      expect(p.seen[0]).toBe("CONNECT api.anthropic.com:443 HTTP/1.1");
    } finally { p.server.close(); }
  });

  test("走代理:代理不回话 → 超时 unreachable(不挂住)", async () => {
    const p = await fakeProxy(() => null);
    try {
      const t0 = Date.now();
      expect(await httpHeadReal("https://api.x.ai", 200, { HTTPS_PROXY: `http://127.0.0.1:${p.port}` })).toBe("unreachable");
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally { p.server.close(); }
  });
});

describe("#622 调度与上报", () => {
  test("monitor:首轮前 current() 为 undefined,首轮后有值且触发 onChange 一次", async () => {
    let changes = 0;
    const m = createRuntimeReadinessMonitor({
      runtimes: () => ["opencode-cli"],
      deps: () => deps({ bins: { opencode: OK("1.0.0") } }),
      onChange: () => { changes++; },
    });
    expect(m.current()).toBeUndefined();
    await m.runOnce();
    expect(m.current()?.["opencode-cli"].state).toBe("ready");
    await m.runOnce();
    expect(changes).toBe(1);
    m.stop();
  });

  test("monitor:deps 抛错不会冒泡(不打死 daemon)", async () => {
    const warns: string[] = [];
    const m = createRuntimeReadinessMonitor({
      runtimes: () => ["opencode-cli"],
      deps: () => { throw new Error("minimalEnv: no HOME"); },
      warn: (w) => warns.push(w),
    });
    await m.runOnce();
    expect(m.current()).toBeUndefined();
    expect(warns.length).toBe(1);
  });

  test("attachRuntimeReadiness:挂到 daemon_capabilities 上,不动 can_create_nodes", async () => {
    const snap = buildConfigSnapshot({ role: "host_supervisor", runtimes_supported: ["opencode-cli"] }, false, 1,
      { ok: true, probedAtMs: 1_000 }, 1_000);
    const rr = await probeRuntimeReadiness(["opencode-cli"], deps({ bins: { opencode: OK("1.0.0") } }));
    const out = attachRuntimeReadiness(snap, rr);
    expect(out.daemon_capabilities?.can_create_nodes).toBe(true);
    expect(out.daemon_capabilities?.runtimes_supported).toEqual(["opencode-cli"]);
    expect(out.daemon_capabilities?.runtime_readiness?.["opencode-cli"].state).toBe("ready");
    // 首轮未完成 / 非 daemon:逐字不变。
    expect(attachRuntimeReadiness(snap, undefined)).toBe(snap);
  });
});
