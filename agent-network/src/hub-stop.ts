// #515(#502 anet CLI 审计)—— `anet hub stop` 找 hub 进程不再依赖 lsof。
//
// 原来:`lsof -t -i :<port> -sTCP:LISTEN`,lsof 不在就 catch → [] →
// 「No hub server listening on port 9200」、退出 0 —— hub 明明在跑。
// 而且 lsof 找到谁就 SIGTERM 谁,不看它是不是 commhub-server。
//
// 现在:
//   1. 端口归属按平台走一条探针链,第一条「能跑」的探针说了算:
//        linux   /proc/net/tcp(6) inode → /proc/<pid>/fd → ss -ltnp → lsof → netstat
//        darwin  lsof → netstat -anv
//        win32   netstat -ano
//      (lsof 只是链上的一环,不是前提。)
//   2. hub start 写的 pid 文件(~/.anet/server/hub-<port>.pid.json)作为补充:
//      所有探针都跑不了时,它是唯一的 PID 来源;探针能跑时只做交叉核对。
//   3. 每个候选 PID 都要读到 cmdline 且认出是 commhub-server 才会被杀;
//      读不到 cmdline / 不是 commhub-server → 拒绝,原样报出 pid 与 cmdline。
//   🔴 绝不按名字/模式杀(没有 pkill / killall / 「找所有 commhub 进程」)——
//      候选只来自「这个端口的监听者」或「hub start 自己记下的 pid」。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

export type ProbeName = "proc" | "ss" | "lsof" | "netstat";

/** null = 这条探针在本机跑不了(没有 /proc、没装 ss …);数组 = 跑了,这些 PID 在监听。 */
export interface SocketProbeResult {
  pids: number[];
  /** 端口确实被监听、但属主 PID 读不到(别的用户的进程)。 */
  unresolved?: number;
}

export interface HubPidRecord { pid: number; port: number; launcher_pid?: number; started_at?: string }

export interface HubStopProbes {
  platform: NodeJS.Platform;
  socket: Partial<Record<ProbeName, (port: number) => SocketProbeResult | null>>;
  readPidFile: (port: number) => HubPidRecord | null;
  cmdline: (pid: number) => string | null;
  alive: (pid: number) => boolean;
}

export type CandidateVerdict = "commhub" | "not-commhub" | "cmdline-unreadable";
export interface Candidate { pid: number; source: ProbeName | "pidfile"; cmdline: string | null; verdict: CandidateVerdict }

export interface HubListenerResolution {
  port: number;
  /** 每条探针的结果,按尝试顺序。 */
  tried: { probe: ProbeName | "pidfile"; outcome: string }[];
  /** 给出端口归属的那条探针;null = 本机没有一条能跑。 */
  authority: ProbeName | null;
  /** 端口被监听但读不到属主 PID 的个数。 */
  unresolved: number;
  /** 核实过是 commhub-server 的 PID —— 只有这些会被停。 */
  hubPids: Candidate[];
  /** 端口上的其他进程 / cmdline 读不到的进程 —— 拒绝动手。 */
  refused: Candidate[];
}

export function probeOrder(platform: NodeJS.Platform): ProbeName[] {
  if (platform === "linux") return ["proc", "ss", "lsof", "netstat"];
  if (platform === "win32") return ["netstat"];
  return ["lsof", "netstat"]; // darwin / *bsd
}

/** cmdline 是不是 commhub-server。只做核实,不用来挑选进程。 */
export function isCommhubServerCmdline(cmdline: string | null | undefined): boolean {
  if (!cmdline) return false;
  const c = cmdline.replace(/\\/g, "/");
  return (
    /@sleep2agi\/commhub-server(@|\/|\s|$)/.test(c) ||       // bunx @sleep2agi/commhub-server@x / node_modules/@sleep2agi/commhub-server/…
    /(^|\/|\s)commhub-server(\s|$)/.test(c) ||                  // …/.bin/commhub-server
    /\/commhub-server@[^/\s]+\//.test(c) ||                     // /tmp/bunx-1000-@sleep2agi/commhub-server@0.9.0/…
    /\/bin\/commhub\.ts(\s|$)/.test(c)                          // bun …/commhub-server/bin/commhub.ts(含源码检出 server/bin/commhub.ts)
  );
}

// ── 纯解析(测试直接喂文本)──

/** /proc/net/tcp 或 tcp6 文本 → 在 port 上 LISTEN(st=0A)的 socket inode。 */
export function parseProcNetTcp(text: string, port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes: string[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const local = f[1] || "";
    if (local.split(":").pop()?.toUpperCase() !== hexPort) continue;
    if (f[3] !== "0A") continue;
    if (f[9] && f[9] !== "0") inodes.push(f[9]);
  }
  return inodes;
}

/** `ss -Hltnp 'sport = :PORT'` → pids;有行却没有 users:(…) 的算 unresolved。 */
export function parseSsOutput(text: string, port: number): SocketProbeResult {
  const pids = new Set<number>();
  let unresolved = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || /^State\s/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    // 不管有没有表头,Local Address:Port 是第一个形如 x:port 的列
    const local = cols.find(c => /:(\d+|\*)$/.test(c));
    if (!local || !local.endsWith(`:${port}`)) continue;
    const found = [...line.matchAll(/pid=(\d+)/g)].map(m => Number(m[1]));
    if (found.length === 0) unresolved++;
    for (const p of found) pids.add(p);
  }
  return { pids: [...pids], unresolved };
}

/** Windows `netstat -ano`:`TCP 127.0.0.1:9200 0.0.0.0:0 LISTENING 1234`。 */
export function parseNetstatWindows(text: string, port: number): SocketProbeResult {
  const pids = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0]?.toUpperCase() !== "TCP" || f.length < 5) continue;
    if (!/^LISTEN/i.test(f[3] || "")) continue;
    if (!(f[1] || "").endsWith(`:${port}`)) continue;
    const pid = Number(f[4]);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return { pids: [...pids] };
}

/** macOS `netstat -anv -p tcp`:按表头找 pid 列;本地地址形如 `127.0.0.1.9200` / `*.9200`。 */
export function parseNetstatDarwin(text: string, port: number): SocketProbeResult {
  const lines = text.split("\n");
  const header = lines.find(l => /Local Address/.test(l) && /\bpid\b/.test(l));
  const pids = new Set<number>();
  let unresolved = 0;
  // 表头里 "Local Address" / "Foreign Address" 各占两个词
  const hcols = header ? header.trim().replace(/Local Address/, "Local_Address").replace(/Foreign Address/, "Foreign_Address").split(/\s+/) : [];
  const pidIdx = hcols.indexOf("pid");
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (!/^tcp/.test(f[0] || "")) continue;
    if (!f.includes("LISTEN")) continue;
    if (!new RegExp(`[.:]${port}$`).test(f[3] || "")) continue;
    const pid = pidIdx >= 0 ? Number(f[pidIdx]) : NaN;
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid); else unresolved++;
  }
  return { pids: [...pids], unresolved };
}

// ── 解析 ──

export function resolveHubListener(port: number, probes: HubStopProbes): HubListenerResolution {
  const tried: HubListenerResolution["tried"] = [];
  let authority: ProbeName | null = null;
  let listener: SocketProbeResult | null = null;
  for (const name of probeOrder(probes.platform)) {
    const fn = probes.socket[name];
    let r: SocketProbeResult | null = null;
    try { r = fn ? fn(port) : null; } catch { r = null; }
    if (!r) { tried.push({ probe: name, outcome: "unavailable" }); continue; }
    tried.push({ probe: name, outcome: r.pids.length ? `pid ${r.pids.join(", ")}` : r.unresolved ? `${r.unresolved} listener(s), owner unreadable` : "no listener" });
    authority = name; listener = r;
    break;
  }

  const verify = (pid: number, source: Candidate["source"]): Candidate => {
    const cmd = probes.cmdline(pid);
    return { pid, source, cmdline: cmd, verdict: cmd == null ? "cmdline-unreadable" : isCommhubServerCmdline(cmd) ? "commhub" : "not-commhub" };
  };

  const hubPids: Candidate[] = [];
  const refused: Candidate[] = [];
  for (const pid of listener?.pids ?? []) {
    const c = verify(pid, authority!);
    (c.verdict === "commhub" ? hubPids : refused).push(c);
  }

  // pid 文件:探针能跑时只交叉核对;一条都跑不了时才作为 PID 来源。
  const rec = probes.readPidFile(port);
  if (!rec) tried.push({ probe: "pidfile", outcome: "none" });
  else if (!probes.alive(rec.pid)) tried.push({ probe: "pidfile", outcome: `stale (pid ${rec.pid} not running)` });
  else {
    const c = verify(rec.pid, "pidfile");
    if (c.verdict !== "commhub") {
      // PID 被复用了 —— 那是别人的进程,不碰,也不算「端口上的拒绝对象」。
      tried.push({ probe: "pidfile", outcome: `stale (pid ${rec.pid} is not a commhub-server now)` });
    } else if (authority) {
      const listed = hubPids.some(h => h.pid === rec.pid);
      tried.push({ probe: "pidfile", outcome: listed ? `pid ${rec.pid} (matches ${authority})` : `pid ${rec.pid} is a commhub-server but ${authority} does not show it on :${port} — not used` });
    } else {
      tried.push({ probe: "pidfile", outcome: `pid ${rec.pid} (commhub-server; no socket probe available to cross-check)` });
      hubPids.push(c);
    }
  }
  return { port, tried, authority, unresolved: listener?.unresolved ?? 0, hubPids, refused };
}

// ── 停止 ──

export interface StopHubDeps {
  probes: HubStopProbes;
  kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep: (ms: number) => Promise<void>;
  /** /health 是否 ok —— 与探针无关的独立判据。 */
  healthy: () => Promise<boolean>;
  log: (line: string) => void;
  error: (line: string) => void;
  graceMs?: number;
}

export interface StopHubResult { code: 0 | 1; killed: number[]; refused: Candidate[] }

function describeCandidate(c: Candidate): string {
  return `pid ${c.pid} (${c.source}) cmdline=${c.cmdline == null ? "<unreadable>" : JSON.stringify(c.cmdline.length > 200 ? c.cmdline.slice(0, 200) + "…" : c.cmdline)}`;
}

export async function stopHub(port: number, d: StopHubDeps): Promise<StopHubResult> {
  const r = resolveHubListener(port, d.probes);
  d.log(`[anet] hub stop :${port} — probes: ${r.tried.map(t => `${t.probe}=${t.outcome}`).join("; ")}`);

  for (const c of r.refused) {
    d.error(`[anet] ✗ refusing to kill ${describeCandidate(c)} — ${c.verdict === "cmdline-unreadable" ? "cannot read its command line" : "not a commhub-server"}.`);
  }
  if (r.unresolved > 0) {
    d.error(`[anet] ✗ ${r.unresolved} listener(s) on :${port} belong to a process anet cannot inspect (another user's?). Not touching it.`);
  }

  if (r.hubPids.length === 0) {
    const up = await d.healthy();
    if (r.refused.length || r.unresolved) return { code: 1, killed: [], refused: r.refused };
    if (up) {
      d.error(`[anet] ✗ a hub answers /health on :${port}, but anet could not find its PID on this machine (${r.authority ? `${r.authority} shows no commhub-server listener` : "no /proc, ss, lsof or netstat available, and no hub pid file"}).`);
      d.error(`[anet]   Nothing was killed. Stop it from the process manager that started it (pm2, systemd, a terminal).`);
      return { code: 1, killed: [], refused: [] };
    }
    d.log(`[anet] No hub server listening on port ${port}.`);
    return { code: 0, killed: [], refused: [] };
  }
  if (r.refused.length) {
    // 端口上同时有 hub 和别的进程 —— 不可能是正常形态,别猜。
    d.error(`[anet] ✗ port ${port} has both a commhub-server and other listener(s); not stopping anything.`);
    return { code: 1, killed: [], refused: r.refused };
  }

  for (const c of r.hubPids) d.log(`[anet] stopping commhub-server ${describeCandidate(c)}`);
  const killed: number[] = [];
  for (const c of r.hubPids) {
    try { d.kill(c.pid, "SIGTERM"); killed.push(c.pid); } catch (e: any) { d.error(`[anet] ⚠ SIGTERM ${c.pid} failed: ${e?.message || e}`); }
  }
  const grace = d.graceMs ?? 3000;
  const step = 250;
  for (let waited = 0; waited < grace; waited += step) {
    await d.sleep(step);
    if (r.hubPids.every(c => !d.probes.alive(c.pid))) break;
  }
  for (const c of r.hubPids) {
    if (!d.probes.alive(c.pid)) continue;
    // 宽限期里 PID 可能已被复用 —— SIGKILL 前再核一次 cmdline。
    if (!isCommhubServerCmdline(d.probes.cmdline(c.pid))) continue;
    d.log(`[anet] pid ${c.pid} survived SIGTERM — sending SIGKILL`);
    try { d.kill(c.pid, "SIGKILL"); } catch {}
  }
  await d.sleep(500);
  const survivors = r.hubPids.filter(c => d.probes.alive(c.pid) && isCommhubServerCmdline(d.probes.cmdline(c.pid)));
  if (survivors.length) {
    d.error(`[anet] ✗ commhub-server pid(s) ${survivors.map(c => c.pid).join(", ")} still running on :${port}.`);
    return { code: 1, killed, refused: [] };
  }
  if (await d.healthy()) {
    d.error(`[anet] ✗ stopped pid(s) ${killed.join(", ")}, but something still answers /health on :${port}.`);
    return { code: 1, killed, refused: [] };
  }
  d.log(`[anet] ✅ Stopped commhub-server pid(s) ${killed.join(", ")} on port ${port}.`);
  return { code: 0, killed, refused: [] };
}

// ── 默认探针(真机)──

/** 跑一条命令:没装 → null;装了 → stdout(非零退出但有 stdout 也收)。 */
function run(cmd: string, argv: string[], okStatuses: number[] = [0]): string | null {
  try {
    return execFileSync(cmd, argv, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true });
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    if (typeof e?.status === "number" && okStatuses.includes(e.status)) return String(e.stdout || "");
    return null;
  }
}

export function procNetListeners(port: number, procRoot = "/proc"): SocketProbeResult | null {
  const files = [`${procRoot}/net/tcp`, `${procRoot}/net/tcp6`].filter(f => existsSync(f));
  if (files.length === 0) return null;
  const inodes = new Set<string>();
  for (const f of files) {
    try { for (const i of parseProcNetTcp(readFileSync(f, "utf-8"), port)) inodes.add(i); } catch {}
  }
  if (inodes.size === 0) return { pids: [] };
  const owners = new Map<string, Set<number>>();
  let dirs: string[] = [];
  try { dirs = readdirSync(procRoot).filter(d => /^\d+$/.test(d)); } catch { return null; }
  for (const d of dirs) {
    let fds: string[];
    try { fds = readdirSync(`${procRoot}/${d}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`${procRoot}/${d}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) {
        if (!owners.has(m[1])) owners.set(m[1], new Set());
        owners.get(m[1])!.add(Number(d));
      }
    }
  }
  const pids = new Set<number>();
  let unresolved = 0;
  for (const i of inodes) {
    const o = owners.get(i);
    if (!o || o.size === 0) unresolved++;
    else for (const p of o) pids.add(p);
  }
  return { pids: [...pids], unresolved };
}

export function defaultHubStopProbes(readPidFile: (port: number) => HubPidRecord | null, platform: NodeJS.Platform = process.platform): HubStopProbes {
  return {
    platform,
    readPidFile,
    socket: {
      proc: (port) => procNetListeners(port),
      ss: (port) => {
        const out = run("ss", ["-Hltnp", `sport = :${port}`]);
        return out == null ? null : parseSsOutput(out, port);
      },
      lsof: (port) => {
        const out = run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], [1]);
        if (out == null) return null;
        return { pids: [...new Set(out.split(/\s+/).filter(Boolean).map(Number).filter(p => Number.isSafeInteger(p) && p > 1))] };
      },
      netstat: (port) => {
        if (platform === "win32") {
          const out = run("netstat", ["-ano", "-p", "TCP"]);
          return out == null ? null : parseNetstatWindows(out, port);
        }
        const out = run("netstat", ["-anv", "-p", "tcp"]);
        if (out == null) return null;
        // 没有 pid 列的 netstat(Linux net-tools、FreeBSD)给不出属主 —— 当作跑不了。
        if (!/Local Address/.test(out) || !/\bpid\b/.test(out)) return null;
        return parseNetstatDarwin(out, port);
      },
    },
    cmdline: (pid) => readCmdline(pid, platform),
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } },
  };
}

export function readCmdline(pid: number, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      const s = raw.split("\0").filter(Boolean).join(" ");
      return s || null;
    } catch { return null; }
  }
  if (platform === "win32") {
    const out = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
    return out && out.trim() ? out.trim() : null;
  }
  const out = run("ps", ["-p", String(pid), "-o", "command="]);
  return out && out.trim() ? out.trim() : null;
}
