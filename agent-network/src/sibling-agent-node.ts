// #1808 —— anet 起节点时优先用「装在自己旁边」的 agent-node。
//
// 现状:各 resolve*AgentNodeLaunchPlan 只认 ① ANET_AGENT_NODE_BIN ② PATH 上的 agent-node ③ npx
// @preview。隔离前缀(~/x/node_modules/.bin/anet)、npx 缓存、多棵 nvm 树的场景下,PATH 上那份
// 往往是另一棵树里的老版本(2026-09-04 DEV:anet .82 起 grok 节点用了 v24 树的 agent-node .40,
// 随即在占位文件上崩)。能力探针只问「会不会共存」,不问版本,所以老版本也能过。
//
// 这里给出「旁边那份」的定位:从 anet 自己的入口文件往上找最近的 `node_modules` 目录,
// 看 `<node_modules>/@sleep2agi/agent-node` 是否存在且带可执行入口。全局安装
// (/usr/lib/node_modules/@sleep2agi/{agent-network,agent-node})与隔离前缀是同一形状。
// 纯函数:fs 访问通过参数注入,便于用临时目录树测试。

import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface SiblingAgentNode {
  /** 直接可 `node <entrypoint>` 的文件。 */
  entrypoint: string;
  packageDir: string;
  version: string | null;
}

export interface SiblingFs {
  exists(path: string): boolean;
  readJson(path: string): unknown;
}

/** 从 anet 入口文件路径往上,返回最近的 `…/node_modules` 目录;找不到返回 null。 */
export function nearestNodeModules(cliEntry: string): string | null {
  if (!cliEntry || !isAbsolute(cliEntry)) return null;
  let dir = dirname(resolve(cliEntry));
  for (let i = 0; i < 64; i++) {
    if (dir.split(sep).pop() === "node_modules") return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** package.json 的 bin 可以是字符串或 { name: path };只认名为 agent-node 的那条。 */
export function binEntryFromPackageJson(pkg: unknown): string | null {
  if (!pkg || typeof pkg !== "object") return null;
  const bin = (pkg as { bin?: unknown }).bin;
  if (typeof bin === "string") return bin;
  if (bin && typeof bin === "object") {
    const named = (bin as Record<string, unknown>)["agent-node"];
    return typeof named === "string" ? named : null;
  }
  return null;
}

export function siblingAgentNodeEntrypoint(cliEntry: string, fs: SiblingFs): SiblingAgentNode | null {
  const nm = nearestNodeModules(cliEntry);
  if (!nm) return null;
  const packageDir = join(nm, "@sleep2agi", "agent-node");
  const pkgJsonPath = join(packageDir, "package.json");
  if (!fs.exists(pkgJsonPath)) return null;
  let pkg: unknown;
  try { pkg = fs.readJson(pkgJsonPath); } catch { return null; }
  const bin = binEntryFromPackageJson(pkg);
  if (!bin) return null;
  const entrypoint = resolve(packageDir, bin);
  if (!fs.exists(entrypoint)) return null;
  const version = typeof (pkg as { version?: unknown }).version === "string" ? (pkg as { version: string }).version : null;
  return { entrypoint, packageDir, version };
}
