// #622 —— daemon 逐个 runtime 自测「在这台机器上建这种节点,真的能跑起来吗」。
//
// 为什么需要:`can_create_nodes` 只检查 anet 二进制的 pin(#1353),
// `runtimes_supported` 只是 `anet daemon init` 时写下的**声明**。#619 审计里
// 21 个「主机 × runtime」格子有 15 个会失败(CLI 不在子进程 PATH 上、没登录、
// 连不上 provider),而 app 的「可建节点 ✓」对它们全部打勾。
//
// 本模块对每个声明的 runtime 回答四件事,都只看**存在性**:
//   CLI     —— 子进程**真正拿到的** PATH(`minimalEnv()`,不是 daemon 自己的 PATH)
//              上能不能解析到二进制,`--version` 报什么;
//   登录    —— 登录文件在不在 / API key 变量**名**在不在。**永不读取、永不记录内容或值**;
//              唯一例外是 codex 的共享登录计数,复用 #1918 的指纹代码(只出一个数字);
//   网络    —— 对 provider 端点发一次 HEAD(5s 超时,走代理环境变量);
//   共享    —— 本机有多少别的节点和新节点会共用同一条 codex 刷新链。
//
// 🔴 绝不阻塞心跳:探测在后台跑,心跳只读缓存。每一步有自己的超时,
//    每个 runtime 还有一个总截止时间 —— 超了就报 `unknown`,不猜。
// 🔴 输出里不出现机器路径:reason 只引用 `~/.codex/auth.json` 这类通用写法。
//    版本号只取正则匹配出的 `x.y.z…`,`--version` 的其余输出一律丢弃。

import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join, delimiter as pathDelimiter } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { codexFingerprintIndexDir, fingerprintRefreshToken } from "../codex-auth-fingerprint.js";
import { isAcceptedOpencodeVersionFor, opencodeGenerationSupport } from "./opencode-versions.js";

export type ReadinessState = "ready" | "missing_cli" | "not_logged_in" | "no_network" | "unknown";
export type NetworkVerdict = "reachable" | "unreachable" | "skipped";

/** 上报给 Hub 的单个 runtime 结果(`daemon_capabilities.runtime_readiness[<runtime>]`)。 */
export interface RuntimeReadiness {
  ok: boolean;
  state: ReadinessState;
  /** 面向用户的中文说明,包含修法。不含机器路径、不含任何凭据。 */
  reason: string;
  /** CLI `--version` 里抠出来的版本号(只有 `x.y.z…`)。 */
  version?: string;
  /** daemon 本机时钟的 ISO 时间。 */
  checked_at: string;
  /** found = PATH 上解析到且 --version 成功;bundled = 该 runtime 自带 CLI,不依赖 PATH。 */
  cli?: "found" | "missing" | "bundled" | "unknown";
  /** present = 登录文件或 key 变量存在;not_required = 该 runtime 默认不需要登录。 */
  auth?: "present" | "absent" | "not_required" | "unknown";
  network?: NetworkVerdict;
  /** codex 专属:本机已有多少个**别的**节点在用同一条 codex 登录(刷新链)。 */
  shared_login_count?: number;
  /** opencode-cli only. Accepted pin of that generation, not an authorization to create. */
  generation?: "v1" | "v2";
  /** True only when `version` is an accepted pin for `generation`. */
  accepted?: boolean;
}

export type ExecResult =
  | { kind: "ok"; stdout: string }
  | { kind: "error" }
  | { kind: "timeout" };

export interface ReadinessDeps {
  platform: NodeJS.Platform;
  /** 子进程的 HOME(与 minimalEnv 一致)。 */
  home: string;
  /** 子进程**真正拿到的**环境(minimalEnv())—— 用于 PATH 和 key 变量**名**判断。 */
  childEnv: Record<string, string | undefined>;
  /** daemon 自己的环境 —— 只用于代理变量,以及「daemon 有 key 但不会传给子进程」的提示。 */
  daemonEnv: Record<string, string | undefined>;
  fileExists(path: string): boolean;
  /** 在给定 PATH 里解析可执行文件;返回绝对路径或 null。 */
  resolveOnPath(bin: string, pathValue: string): string | null;
  execVersion(bin: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<ExecResult>;
  httpHead(url: string, timeoutMs: number, proxyEnv: Record<string, string | undefined>): Promise<"reachable" | "unreachable">;
  /** 本机有多少别的节点和 `home/.codex/auth.json` 共用同一条刷新链;算不出返回 null。 */
  codexSharedCount(home: string): number | null;
  now(): number;
}

export interface ProbeOptions {
  stepTimeoutMs?: number;
  runtimeDeadlineMs?: number;
}

export const STEP_TIMEOUT_MS = 5_000;
export const RUNTIME_DEADLINE_MS = 20_000;

interface RuntimeSpec {
  /** PATH 上要找的命令;undefined = runtime 自带 CLI。 */
  cli?: string;
  /** 自带 CLI 时也去 PATH 上找一下,找到就报版本(codex-sdk:PATH 上更新的 codex 会被优先使用)。 */
  optionalCli?: string;
  installHint: string;
  /** 登录文件(相对 HOME)。 */
  authFiles: string[];
  /** 任一存在即视为已提供凭据的 env 变量名(只看名字)。 */
  authEnvKeys: string[];
  /** true = 默认不需要登录(opencode 免费 Zen 模型)。 */
  authOptional?: boolean;
  loginHint: string;
  endpoint: string;
  codexShared?: boolean;
}

const CLAUDE_LOGIN_HINT = "在这台机器上运行 `claude` 并执行 /login(会生成 ~/.claude/.credentials.json),然后等下一轮自检(约 10 分钟)";
const CODEX_LOGIN_HINT = "在这台机器上运行 `codex login --device-auth`(会生成 ~/.codex/auth.json)";
const GROK_LOGIN_HINT = "在这台机器上运行 `grok login`(会生成 ~/.grok/auth.json)";
const ON_CHILD_PATH = "并确保它位于 /usr/local/bin(或与 node 同一目录),或写进这个 daemon 节点 config.json 的 daemonExtraPath(绝对路径组成的字符串数组,追加在固定 PATH 之后)—— daemon 创建的节点看不到你 shell 里的 PATH";

const SPECS: Record<string, RuntimeSpec> = {
  "claude-agent-sdk": {
    installHint: "",
    authFiles: [".claude/.credentials.json"],
    authEnvKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    loginHint: CLAUDE_LOGIN_HINT,
    endpoint: "https://api.anthropic.com",
  },
  "claude-code-cli": {
    cli: "claude",
    installHint: `安装 Claude Code:npm i -g @anthropic-ai/claude-code,${ON_CHILD_PATH}`,
    authFiles: [".claude/.credentials.json"],
    authEnvKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    loginHint: CLAUDE_LOGIN_HINT,
    endpoint: "https://api.anthropic.com",
  },
  "codex-sdk": {
    optionalCli: "codex",
    installHint: "",
    authFiles: [".codex/auth.json"],
    authEnvKeys: ["OPENAI_API_KEY"],
    loginHint: CODEX_LOGIN_HINT,
    endpoint: "https://chatgpt.com",
    codexShared: true,
  },
  "codex-app-server": {
    cli: "codex",
    installHint: `安装 Codex CLI:npm i -g @openai/codex,${ON_CHILD_PATH}`,
    authFiles: [".codex/auth.json"],
    authEnvKeys: ["OPENAI_API_KEY"],
    loginHint: CODEX_LOGIN_HINT,
    endpoint: "https://chatgpt.com",
    codexShared: true,
  },
  "grok-build-acp": {
    cli: "grok",
    installHint: `安装 grok CLI,${ON_CHILD_PATH}`,
    authFiles: [".grok/auth.json"],
    authEnvKeys: [],
    loginHint: GROK_LOGIN_HINT,
    endpoint: "https://api.x.ai",
  },
  "grok-build-cli": {
    cli: "grok",
    installHint: `安装 grok CLI,${ON_CHILD_PATH}`,
    authFiles: [".grok/auth.json"],
    authEnvKeys: [],
    loginHint: GROK_LOGIN_HINT,
    endpoint: "https://api.x.ai",
  },
  "opencode-cli": {
    cli: "opencode",
    installHint: `安装 anet 固定版本的 opencode-ai(见 anet 文档「OpenCode 节点」),${ON_CHILD_PATH}`,
    authFiles: [".local/share/opencode/auth.json"],
    authEnvKeys: [],
    authOptional: true,
    loginHint: "",
    endpoint: "https://opencode.ai",
  },
};

export const PROBED_RUNTIMES: readonly string[] = Object.keys(SPECS);

/** 只取版本号本身;`--version` 其余输出(可能带路径)一律丢弃。 */
export function extractVersion(stdout: string): string | undefined {
  const m = /\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?/.exec(stdout);
  return m ? m[0].slice(0, 64) : undefined;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

const DEADLINE = Symbol("deadline");
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(DEADLINE), ms);
    (t as any).unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(DEADLINE); });
  });
}

/** 某个 runtime 的必选 CLI 在子进程 PATH 上的结论。没有必选 CLI 时是 `not_required`。
 *  `missing` 与就绪状态 `missing_cli` 是同一条判据(找不到,或 `--version` 失败)。
 *  `--version` 超时是 `unknown`,不是 missing。建节点拒绝与自检必须走这里,避免两套结论。 */
export async function requiredCliStatus(
  runtime: string,
  pathValue: string,
  childEnv: Record<string, string | undefined>,
  io: Pick<ReadinessDeps, "resolveOnPath" | "execVersion">,
  stepTimeoutMs: number,
): Promise<{ cli: "found" | "missing" | "unknown" | "not_required"; command?: string; version?: string }> {
  const spec = SPECS[runtime];
  if (!spec?.cli) return { cli: "not_required" };
  const command = spec.cli;
  const abs = io.resolveOnPath(command, pathValue);
  if (!abs) return { cli: "missing", command };
  const r = await io.execVersion(abs, childEnv, stepTimeoutMs);
  if (r.kind === "ok") return { cli: "found", command, version: extractVersion(r.stdout) };
  if (r.kind === "error") return { cli: "missing", command };
  return { cli: "unknown", command };
}

/**
 * Explicit create generation vs the installed `opencode --version`.
 * Returns null unless the request names v1 or v2 AND the CLI was found.
 * A missing or unparsed version on an explicit request is a mismatch.
 * Omitted generation (legacy V1) and cli timeout/missing do not mismatch.
 */
export function opencodeExplicitGenerationMismatch(
  requested: unknown,
  cli: { cli: string; version?: string },
): string | null {
  if (requested !== "v1" && requested !== "v2") return null;
  if (cli.cli !== "found") return null;
  if (cli.version && isAcceptedOpencodeVersionFor(requested, cli.version)) return null;
  const support = opencodeGenerationSupport(requested);
  const pin = support.pin ?? "none";
  const accepted = support.acceptedVersions.join(", ") || "none";
  const seen = cli.version ?? "(unparsed)";
  return `opencode_generation_mismatch: installed opencode ${seen} is not an accepted ${requested} of ${support.packageName}@${pin} (accepted: ${accepted}). Provider and model stay in OpenCode's own config; this check does not apply an anet provider preset.`;
}

async function probeOne(runtime: string, deps: ReadinessDeps, stepTimeoutMs: number): Promise<RuntimeReadiness> {
  const checked_at = new Date(deps.now()).toISOString();
  const spec = SPECS[runtime];
  if (!spec) {
    return { ok: false, state: "unknown", reason: `这个 daemon 不认识运行时 ${runtime.slice(0, 64)},无法自检;请升级 agent-node`, checked_at };
  }
  const out: RuntimeReadiness = { ok: false, state: "unknown", reason: "", checked_at };
  const pathValue = deps.childEnv.PATH ?? "";

  // ── 1. CLI ──
  let cliUnknown = false;
  if (spec.cli) {
    const st = await requiredCliStatus(runtime, pathValue, deps.childEnv, deps, stepTimeoutMs);
    if (st.cli === "found") {
      out.cli = "found";
      if (st.version) out.version = st.version;
    } else if (st.cli === "missing") {
      // 文件在但跑不起来(#619:Mac 上 codex 的 vendor 二进制 ENOENT)也走这里。
      out.cli = "missing";
    } else {
      out.cli = "unknown";
      cliUnknown = true;
    }
  } else {
    out.cli = "bundled";
    if (spec.optionalCli) {
      const abs = deps.resolveOnPath(spec.optionalCli, pathValue);
      if (abs) {
        const r = await deps.execVersion(abs, deps.childEnv, stepTimeoutMs);
        if (r.kind === "ok") {
          const v = extractVersion(r.stdout);
          if (v) out.version = v;
        }
      }
    }
  }

  // V2 chooses its provider/model in the node's own configuration. The V1
  // Zen endpoint and auth-file probes cannot establish V2 readiness: an
  // offline/LAN provider can work while opencode.ai is unreachable, and a
  // reachable website does not prove model authentication. Keep this unknown,
  // not ready. `accepted` only classifies the --version token against the pin
  // table; create re-checks before writing a node.
  if (runtime === "opencode-cli" && out.cli === "found" && /^2\./.test(out.version ?? "")) {
    out.auth = "unknown";
    out.network = "skipped";
    out.generation = "v2";
    const support = opencodeGenerationSupport("v2");
    const accepted = !!out.version && isAcceptedOpencodeVersionFor("v2", out.version);
    out.accepted = accepted;
    out.reason = accepted
      ? "检测到 OpenCode V2;provider、模型和登录取决于目标节点配置,不能用 opencode.ai 的连通性确认。创建时仍需校验准确版本、显式工具授权和启动结果"
      : `检测到 OpenCode 2.x（${out.version ?? "未解析"}），不是本发行接受的 ${support.packageName}@${support.pin}；显式创建 v2 会被拒绝。provider 与模型仍用 OpenCode 自己的配置，本检查不套用 anet provider 预设`;
    return out;
  }

  // ── 2. 登录(只看存在性)──
  const fileHit = spec.authFiles.some((rel) => deps.fileExists(join(deps.home, rel)));
  const envHit = spec.authEnvKeys.some((k) => typeof deps.childEnv[k] === "string" && deps.childEnv[k] !== "");
  const daemonOnlyKeys = spec.authEnvKeys.filter((k) =>
    typeof deps.daemonEnv[k] === "string" && deps.daemonEnv[k] !== ""
    && !(typeof deps.childEnv[k] === "string" && deps.childEnv[k] !== ""));
  let authUnknownMac = false;
  if (fileHit || envHit) out.auth = "present";
  else if (spec.authOptional) out.auth = "not_required";
  else if (deps.platform === "darwin" && spec.authFiles.some((f) => f.startsWith(".claude/"))) {
    // macOS 的 Claude Code 把登录放在钥匙串里,文件不在 ≠ 没登录。不猜。
    out.auth = "unknown";
    authUnknownMac = true;
  } else out.auth = "absent";

  // ── 3. codex 共享登录(只出一个数字)──
  if (spec.codexShared && fileHit) {
    try {
      const n = deps.codexSharedCount(deps.home);
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out.shared_login_count = n;
    } catch { /* 观测而已 */ }
  }

  // ── 4. 网络 ──
  // CLI 缺失或没登录时不发网络请求:结论已定,省掉一次 5 秒等待。
  if (out.cli === "missing" || out.auth === "absent") {
    out.network = "skipped";
  } else {
    let verdict: "reachable" | "unreachable";
    try { verdict = await deps.httpHead(spec.endpoint, stepTimeoutMs, deps.daemonEnv); }
    catch { verdict = "unreachable"; }
    out.network = verdict;
  }

  // ── 判定(优先级:missing_cli > not_logged_in > no_network > unknown > ready)──
  const host = hostOf(spec.endpoint);
  if (out.cli === "missing") {
    out.state = "missing_cli";
    out.reason = `新节点的 PATH 上找不到可用的 ${spec.cli} 命令(或 \`${spec.cli} --version\` 运行失败)。修法:${spec.installHint}`;
  } else if (out.auth === "absent") {
    out.state = "not_logged_in";
    let r = `这台机器上没有 ${runtime} 需要的登录。修法:${spec.loginHint}`;
    if (daemonOnlyKeys.length > 0) {
      r += `。注意:daemon 进程环境里有 ${daemonOnlyKeys.join("/")},但它不会传给 daemon 创建的节点`;
    }
    out.reason = r;
  } else if (out.network === "unreachable") {
    out.state = "no_network";
    out.reason = `这台机器连不上 ${host}(连接被拒或 ${Math.round(stepTimeoutMs / 1000)} 秒内无响应)。修法:检查这台机器的出网;需要代理时在 daemon 的环境里设置 HTTPS_PROXY`;
  } else if (cliUnknown) {
    out.state = "unknown";
    out.reason = `\`${spec.cli} --version\` 在 ${Math.round(stepTimeoutMs / 1000)} 秒内没有返回,无法确认 CLI 可用;下一轮自检会重试`;
  } else if (authUnknownMac) {
    out.state = "unknown";
    out.reason = "macOS 上 Claude Code 的登录可能存在钥匙串里,无法只凭文件确认;如果建出来的节点报未登录,在这台机器上运行 `claude` 并执行 /login";
  } else {
    out.state = "ready";
    out.ok = true;
    const parts: string[] = [];
    if (out.cli === "bundled") parts.push("使用 runtime 自带的 CLI");
    if (out.auth === "not_required") parts.push("免费模型无需登录;用付费 provider 时需另行登录");
    if (typeof out.shared_login_count === "number" && out.shared_login_count > 0) {
      parts.push(`本机已有 ${out.shared_login_count} 个节点共用这个 codex 登录,新节点会加入同一条刷新链,其中一个刷新后其余可能被顶掉登录;建好后可用 \`anet node codex login-status\` 查看,并为新节点单独执行 codex login`);
    }
    out.reason = parts.length > 0 ? `可以创建。${parts.join(";")}` : "可以创建";
  }
  if (runtime === "opencode-cli" && out.cli === "found" && out.version && isAcceptedOpencodeVersionFor("v1", out.version)) {
    out.generation = "v1";
    out.accepted = true;
  }
  return out;
}

/** 探测一组 runtime。每个 runtime 有总截止时间;超时即 `unknown`。永不抛错。 */
export async function probeRuntimeReadiness(
  runtimes: readonly string[],
  deps: ReadinessDeps,
  opts: ProbeOptions = {},
): Promise<Record<string, RuntimeReadiness>> {
  const stepTimeoutMs = opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const deadlineMs = opts.runtimeDeadlineMs ?? RUNTIME_DEADLINE_MS;
  const uniq = [...new Set(runtimes.filter((r) => typeof r === "string" && r.length > 0))].slice(0, 16);
  const entries = await Promise.all(uniq.map(async (rt) => {
    const r = await withDeadline(probeOne(rt, deps, stepTimeoutMs), deadlineMs);
    if (r === DEADLINE) {
      const res: RuntimeReadiness = {
        ok: false,
        state: "unknown",
        reason: `自检在 ${Math.round(deadlineMs / 1000)} 秒内没有完成,无法确认能否创建;下一轮自检会重试`,
        checked_at: new Date(deps.now()).toISOString(),
      };
      return [rt, res] as const;
    }
    return [rt, r] as const;
  }));
  return Object.fromEntries(entries);
}

// ─────────────────────────── 默认(真实)依赖 ───────────────────────────

export function resolveOnPathReal(bin: string, pathValue: string, platform: NodeJS.Platform = process.platform): string | null {
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = pathValue.split(platform === "win32" ? ";" : pathDelimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = join(dir, bin + ext);
      try {
        const st = statSync(cand);
        if (!st.isFile()) continue;
        if (platform !== "win32") accessSync(cand, constants.X_OK);
        return cand;
      } catch { /* next */ }
    }
  }
  return null;
}

export function execVersionReal(bin: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    try {
      execFile(bin, ["--version"], {
        env: env as NodeJS.ProcessEnv,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 64 * 1024,
        shell,
      }, (err: any, stdout) => {
        if (err) {
          resolve(err.killed || err.signal === "SIGKILL" || err.code === "ETIMEDOUT" ? { kind: "timeout" } : { kind: "error" });
          return;
        }
        resolve({ kind: "ok", stdout: String(stdout ?? "") });
      });
    } catch {
      resolve({ kind: "error" });
    }
  });
}

/** NO_PROXY 判定:`*`、精确主机、`.example.com` / `example.com` 后缀。 */
export function proxyFor(targetHost: string, env: Record<string, string | undefined>): string | undefined {
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = targetHost.toLowerCase();
  for (const np of noProxy) {
    if (np === "*") return undefined;
    const bare = np.replace(/^\./, "").replace(/:\d+$/, "");
    if (host === bare || host.endsWith("." + bare)) return undefined;
  }
  const p = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  return p && p.trim() ? p.trim() : undefined;
}

/**
 * HEAD 一个 https 端点。直连:收到任何 HTTP 响应(含 4xx)即 reachable。
 * 走代理:代理对 CONNECT 回 2xx 即 reachable(代理已经替我们连上了目标主机);
 * 否则继续在隧道里发 HEAD 不改变结论。只支持 http:// 代理(与 curl 的常见用法一致)。
 */
export function httpHeadReal(url: string, timeoutMs: number, proxyEnv: Record<string, string | undefined>): Promise<"reachable" | "unreachable"> {
  return new Promise((resolve) => {
    let done = false;
    const sockets: Array<{ destroy(): void }> = [];
    const finish = (v: "reachable" | "unreachable") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of sockets) { try { s.destroy(); } catch {} }
      resolve(v);
    };
    const timer = setTimeout(() => finish("unreachable"), timeoutMs);
    (timer as any).unref?.();
    let target: URL;
    try { target = new URL(url); } catch { finish("unreachable"); return; }
    const host = target.hostname;
    const port = Number(target.port || 443);
    const sendHead = (sock: any) => {
      let buf = "";
      sock.on("data", (d: Buffer) => {
        buf += d.toString("latin1");
        if (/^HTTP\/\d(\.\d)? \d{3}/.test(buf)) finish("reachable");
        else if (buf.length > 16) finish("unreachable");
      });
      sock.on("error", () => finish("unreachable"));
      sock.on("close", () => finish("unreachable"));
      sock.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: anet-readiness\r\nConnection: close\r\n\r\n`);
    };
    const proxy = proxyFor(host, proxyEnv);
    if (!proxy) {
      try {
        const t = tlsConnect({ host, port, servername: host }, () => sendHead(t));
        sockets.push(t);
        t.on("error", () => finish("unreachable"));
      } catch { finish("unreachable"); }
      return;
    }
    let p: URL;
    try { p = new URL(proxy.includes("://") ? proxy : `http://${proxy}`); } catch { finish("unreachable"); return; }
    if (p.protocol !== "http:") { finish("unreachable"); return; }
    try {
      const s = netConnect({ host: p.hostname, port: Number(p.port || 80) });
      sockets.push(s);
      s.on("error", () => finish("unreachable"));
      s.on("close", () => finish("unreachable"));
      s.on("connect", () => {
        let auth = "";
        if (p.username) {
          const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
          auth = `Proxy-Authorization: Basic ${Buffer.from(cred).toString("base64")}\r\n`;
        }
        s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      });
      let head = "";
      s.on("data", (d: Buffer) => {
        head += d.toString("latin1");
        const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head);
        if (m) finish(m[1].startsWith("2") ? "reachable" : "unreachable");
        else if (head.length > 64) finish("unreachable");
      });
    } catch { finish("unreachable"); }
  });
}

/**
 * 本机有多少**别的**节点和 `<home>/.codex/auth.json` 共用同一条刷新链。
 * 指纹算法复用 #1918 的 `fingerprintRefreshToken`(只在内存里哈希,不保存不输出),
 * 只**读** `~/.anet/codex-auth-fingerprints/` 索引 —— daemon 自己不是 codex 节点,
 * 所以这里**不**调用会写索引的 `checkCodexCredentialSharing`。
 * 节点目录已不存在的记录不计(与 #1918 的存活判据一致),但这里不删它们:只读。
 */
export function codexSharedCountReal(home: string, indexDir: string = codexFingerprintIndexDir(home)): number | null {
  let fp: string | null;
  try { fp = fingerprintRefreshToken(readFileSync(join(home, ".codex", "auth.json"), "utf-8")); }
  catch { return null; }
  if (!fp) return null;
  let entries: string[] = [];
  try { entries = readdirSync(indexDir); } catch { return 0; }
  const dirs = new Set<string>();
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(readFileSync(join(indexDir, e), "utf-8"));
      if (rec?.fingerprint !== fp || typeof rec?.node_dir !== "string") continue;
      statSync(rec.node_dir);
      dirs.add(rec.node_dir);
    } catch { /* 坏记录 / 节点已不在 */ }
  }
  return dirs.size;
}

export function realReadinessDeps(input: {
  childEnv: Record<string, string | undefined>;
  daemonEnv?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): ReadinessDeps {
  const platform = input.platform ?? process.platform;
  const childEnv = input.childEnv;
  return {
    platform,
    home: childEnv.HOME || childEnv.USERPROFILE || "",
    childEnv,
    daemonEnv: input.daemonEnv ?? (process.env as Record<string, string | undefined>),
    fileExists: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
    resolveOnPath: (bin, pv) => resolveOnPathReal(bin, pv, platform),
    execVersion: execVersionReal,
    httpHead: httpHeadReal,
    codexSharedCount: (home) => codexSharedCountReal(home),
    now: () => Date.now(),
  };
}

// ─────────────────────────── 调度 ───────────────────────────

export const READINESS_INTERVAL_MS = 10 * 60_000;

/** `ANET_RUNTIME_READINESS_INTERVAL_MS`(≥ 5000,给测试用);默认 10 分钟。 */
export function readinessIntervalFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.ANET_RUNTIME_READINESS_INTERVAL_MS);
  return Number.isInteger(n) && n >= 5_000 ? n : READINESS_INTERVAL_MS;
}

export interface ReadinessMonitorOptions {
  runtimes: () => readonly string[];
  deps: () => ReadinessDeps;
  intervalMs?: number;
  /** 每轮间隔的随机抖动比例(默认 ±10%)。 */
  jitterRatio?: number;
  /** 结果变化时回调(调用方据此补发一次心跳,不等 3 分钟)。 */
  onChange?: (r: Record<string, RuntimeReadiness>) => void;
  warn?: (m: string) => void;
  random?: () => number;
  probeOptions?: ProbeOptions;
}

/** 后台定时自检。`current()` 只读缓存,永不阻塞;首轮完成前返回 undefined(不上报该字段)。 */
export function createRuntimeReadinessMonitor(opts: ReadinessMonitorOptions) {
  const interval = opts.intervalMs ?? READINESS_INTERVAL_MS;
  const jitter = opts.jitterRatio ?? 0.1;
  const rand = opts.random ?? Math.random;
  let latest: Record<string, RuntimeReadiness> | undefined;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const stateKey = (r: Record<string, RuntimeReadiness> | undefined) =>
    r ? JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k].state, r[k].version ?? "", r[k].network ?? "", r[k].shared_login_count ?? -1])) : "";

  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const before = stateKey(latest);
      const next = await probeRuntimeReadiness(opts.runtimes(), opts.deps(), opts.probeOptions);
      latest = next;
      if (stateKey(next) !== before) {
        try { opts.onChange?.(next); } catch { /* 观测而已 */ }
      }
    } catch (e: any) {
      opts.warn?.(`[runtime-readiness] probe failed: ${e?.message || e}`);
    } finally {
      running = false;
    }
  }

  function schedule(): void {
    if (stopped) return;
    const delta = interval * jitter * (rand() * 2 - 1);
    timer = setTimeout(() => { void runOnce().finally(schedule); }, Math.max(1_000, Math.round(interval + delta)));
    (timer as any).unref?.();
  }

  return {
    /** 立刻在后台跑首轮(不 await),之后每 interval±jitter 一轮。 */
    start(): void {
      void runOnce().finally(schedule);
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    current(): Record<string, RuntimeReadiness> | undefined {
      return latest;
    },
    /** 测试用:跑一轮并等它结束。 */
    runOnce,
  };
}
