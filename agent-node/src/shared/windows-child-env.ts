/**
 * Windows child-only PATH completion.
 *
 * 2026-11-22 — 闻星真机（native Windows, scheduled-task launch）：
 * `agy` 的 shell 工具要 `powershell`，但 agent-node 给子进程的 PATH 里没有
 * `C:\Windows\System32\WindowsPowerShell\v1.0` ⇒ `exec: powershell not found`。
 *
 * 这不是 ACP 专属问题：任何在 Windows 上要调 `powershell.exe` / System32 工具的
 * 子进程都会撞上。根因是 **子进程直接继承 daemon 的 process.env**，而计划任务 /
 * 服务启动的进程 PATH 往往只有最小集合。
 *
 * 口径（与 create-node-daemon.ts 的 computeChildPath 同源）：
 *   · 只用 `SystemRoot`（或 `windir`）推导，不写死盘符；
 *   · 只**补缺**，已经在 PATH 里的条目（大小写不敏感）不重复加；
 *   · `SystemRoot` 缺失或不是绝对路径 ⇒ 只补 execDir，不猜目录；
 *   · 只用于子进程 env，**不修改** daemon 自己的 process.env。
 */
import { win32 } from "node:path";

export interface WindowsChildPathOptions {
  execDir?: string;
  systemRoot?: string;
  platform?: NodeJS.Platform;
}

function splitPath(value: string): string[] {
  return value.split(";").map(part => part.trim()).filter(Boolean);
}

/** 补全 Windows 子进程 PATH。非 win32 原样返回。 */
export function windowsChildPath(
  existing: string | undefined,
  opts: WindowsChildPathOptions = {},
): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return existing ?? "";
  const wanted: string[] = [];
  const execDir = opts.execDir ?? win32.dirname(process.execPath);
  if (execDir) wanted.push(execDir);
  const root = opts.systemRoot;
  if (root && win32.isAbsolute(root)) {
    wanted.push(win32.join(root, "System32"));
    wanted.push(win32.join(root, "System32", "WindowsPowerShell", "v1.0"));
  }
  const seen = new Set(splitPath(existing ?? "").map(part => part.toLowerCase()));
  const prepend: string[] = [];
  for (const dir of wanted) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    prepend.push(dir);
  }
  const rest = splitPath(existing ?? "");
  return [...prepend, ...rest].join(";");
}

/** 给子进程用的 env：只补 PATH，其它键原样。 */
export function withWindowsChildPath(
  env: NodeJS.ProcessEnv,
  opts: WindowsChildPathOptions = {},
): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  const systemRoot = opts.systemRoot ?? env.SystemRoot ?? env.windir;
  return { ...env, PATH: windowsChildPath(env.PATH, { ...opts, systemRoot, platform }) };
}
