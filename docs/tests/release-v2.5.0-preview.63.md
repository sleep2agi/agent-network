# agent-node 2.5.0-preview.63

`.62` 之后 `agent-node/` 两个提交,都是 #1645(codex-sdk 一天 17 次「300s 超时」)的提前预警:

| 提交 | PR | 内容 |
|---|---|---|
| `c111042c` | #1789 | 起线程前读 `$CODEX_HOME/models_cache.json`,上游给了本机 codex 不认识的推理档位(实测 `max, ultra`)就 warn,不拦 |
| `a7e44721` | #1790 | resume 前读 rollout 最后一条 `token_count`,线程 ≥ min(150k, 窗口 60%) 就 warn 并建议 `--new-session`,不拦 |

## 这一版带给用户什么

codex-sdk 节点的日志里,在那句 300s 超时出现之前 5 分钟,就能看到「该升 codex-cli」或「该起新线程」——两条都是日志里早就有的事实,只是提前到起线程之前说。不改任何行为。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.63
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.63
anet daemon restart <daemon>        # 或 anet node stop <name> && anet node start <name>
```

## 证据

- `codex-models-cache-check.test.ts` 7 条、`codex-thread-size-check.test.ts` 3 条;typecheck 棘轮 81/81。
- DEV 本机实跑:档位门命中 `max, ultra`(codex 0.148.0 写的缓存);线程门对 40k tokens 的真实 rollout 沉默。

## promote 时的 must_contain

`last_token_usage`(`.62` 产物 0 命中,已用闸 4 原样命令验)。
