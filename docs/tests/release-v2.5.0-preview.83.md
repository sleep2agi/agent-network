# agent-node 2.5.0-preview.83

`.82` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 74af2fd7 | #1974 | #1645 models 缓存告警按「选中的 codex 版本 vs 写缓存的 codex 版本」判断,不再对新 codex 误报(#1973) |

## 本版修的是什么

`.82`(#1971)开始按需选用更新的宿主 codex。但 #1645 的告警用的是写死的推理档位表(codex 0.133 那一套:none/minimal/low/medium/high/xhigh),于是在新 codex 下,每个节点首件都会打两行 WARN:「上游 models 缓存里有本机 codex 不认识的推理档位: max, ultra」「resume 线程时 codex 会以 unknown variant 致命退出」——而缓存正是同一个 0.155.1 写的,resume 也成功了。

**改法**:把 #1971 选中的 codex 版本传进检查。选中版本 ≥ 写缓存的版本 → 不告警;更旧 → 告警并写出两个版本;任一版本未知 → 退回原来的写死表。告警措辞从「会致命退出」改为「可能不认识」。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.83
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.109 @sleep2agi/agent-node@2.5.0-preview.83
```

🔴 **两个包要一起升。** 配对是精确的(`.109 ↔ .83`)。

## 证据

- `codex-models-cache-check.test.ts` 7 → 11 全绿;变异「origin/main 模块」2 红、「比较方向反转」2 红、「未知选中版本当最新」2 红、「未知写入版本当 0.0.0」1 红;恢复全绿。
- codex 套件 142/142(三次中两次;一次 `codex-app-server-bridge.test.ts` 偶发,不 import 改动文件,已在 PR 注明)。
- typecheck 棘轮 81 = 基线;doc symbol/source pins rc=0。

## 未覆盖(明写)

- 发出后在 DEV 用本版滚动其余 codex-sdk 节点,并在一台 gpt-5.6-sol 节点上确认日志不再出现 #1645 两行 WARN。

## promote 时的 must_contain

`"version": "2.5.0-preview.83"`
