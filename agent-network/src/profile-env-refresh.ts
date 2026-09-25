// `anet node start` 的 exit-75 原地重启要重新读节点配置里的 env 块。
//
// 🔴 缺陷(节点环境变量功能暴露出来的):启动器在第一次拉起 agent-node 之前把
//    config.json 的 env 解析好、塞进 childEnv,之后每次 exit 75(restart_node /
//    update_node_config)都用**同一份** childEnv 重新拉起。而 agent-node 注入 config env
//    时是「外层 env 优先」(`if (process.env[k]) continue`)—— 于是:
//      · 改过值的键:子进程看到的永远是启动时的旧值;
//      · 删掉的键:旧值照样被塞进去;
//      · 只有新增的键能生效(外层没有它)。
//    也就是「在客户端里改了密钥、点了重启」对已经存在的键不起作用。
//
// 修法:每次重新拉起之前,按磁盘上的配置重算一遍这层覆盖 —— 上一轮由配置带进来、这一轮
// 配置里没有了的键,恢复成启动器自己进程里的原值(没有就删掉);配置里的键一律用新值。
// 保留名单里的键(PATH / NODE_OPTIONS / LD_* / ANET_* / COMMHUB_* …,与 node-env.ts
// 同一个 envKeyProblem)不参与重算:它们由启动器自己决定(opencode 的加固、grok 的
// 身份哨兵都在 childEnv 里),配置不能借重启改掉它们。

import { envKeyProblem } from "./node-env";

export type EnvMap = Record<string, string | undefined>;

/** 与 bin/cli.ts resolveProfileEnv 同一套取值规则,但缺失的 envRef 不 exit —— 记下来、跳过。 */
export function resolveProfileEnvLenient(
  profileEnv: unknown,
  home: string,
  dotenv: Record<string, string> | undefined,
  processEnv: EnvMap,
): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  if (!profileEnv || typeof profileEnv !== "object" || Array.isArray(profileEnv)) return { env, missing };
  for (const [k, v] of Object.entries(profileEnv as Record<string, unknown>)) {
    if (typeof v === "string") { env[k] = v.replace(/^~/, home); continue; }
    if (v && typeof v === "object" && typeof (v as any)._envRef === "string") {
      const ref = (v as any)._envRef as string;
      const val = processEnv[ref] ?? dotenv?.[ref];
      if (val === undefined || val === "") { missing.push(k); continue; }
      env[k] = val;
    }
  }
  return { env, missing };
}

const reserved = (k: string) => envKeyProblem(k) !== null;

/**
 * 重算覆盖层。
 *  base        = 上一次拉起用的 env(含启动器自己加的东西)
 *  prevApplied = 上一次由配置带进来的键值
 *  next        = 这一次按磁盘配置解析出来的键值
 *  launcherEnv = 启动器进程自己的环境(配置删掉某键时恢复它)
 *  onlyKeys    = 只处理这些键(grok 的 agent-node 父进程只继承一份白名单)
 */
export function refreshProfileEnvOverlay(
  base: EnvMap,
  prevApplied: Record<string, string>,
  next: Record<string, string>,
  launcherEnv: EnvMap,
  onlyKeys?: ReadonlySet<string>,
): EnvMap {
  const out: EnvMap = { ...base };
  const inScope = (k: string) => !reserved(k) && (!onlyKeys || onlyKeys.has(k));
  for (const k of Object.keys(prevApplied)) {
    if (!inScope(k) || Object.prototype.hasOwnProperty.call(next, k)) continue;
    if (launcherEnv[k] !== undefined) out[k] = launcherEnv[k];
    else delete out[k];
  }
  for (const [k, v] of Object.entries(next)) {
    if (inScope(k)) out[k] = v;
  }
  return out;
}
