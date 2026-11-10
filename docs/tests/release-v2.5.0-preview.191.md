# agent-node 2.5.0-preview.191

Since `.190`: **思考档位（variant）在普通构建上可切换**——用一条比测试版控制器更窄的写路径，而不是放宽原来的闸门。

## Why

普通（非 test）构建一直上报 `opencode_variant_config_capable=false`，客户端能显示档位却无法更换。
原闸门是有意的：V2 没有与人类 TUI 共享的**原子空闲租约**，写入可能与 TUI 正在跑的一轮相撞。

## What changed

```text
runtime/opencode-copresence/v2-session.ts
  · 记录「本进程已接受但未结算」的轮次（inFlight）
  · 新增 setSelectedVariant(variant|null)：inFlight>0 时拒绝（variant_busy）；
    写完整 model ref（id+providerID+variant，服务端是替换不是合并）；
    写后**必回读**，不一致抛错
  · variantConfigCapable：运行中即可（不再绑 test build）
  · variantConfigReadback：stock 构建也读（test build 仍要求身份校验）

runtime/opencode-copresence/variant-config-apply.ts
  · 无选择控制器时走 setSelectedVariant；busy ⇒ rejected:busy；回读不一致 ⇒ unknown
  · model+variant 同补丁仍 unsupported（只有 test 控制器能两者同时切）
```

## Known limit（写进代码，不藏着）

OpenCode 的 `GET /api/session/<id>` **没有 busy/running 标记**，所以「人类 TUI 在同一瞬间开始一轮」检测不到。
因此这是 **best-effort**，不是已证明的原子切换；我方轮次（含排队）会明确拒绝。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.191
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.191
```

⚠️ 与 CLI 精确配对：先 node 再 CLI（`2.3.0-preview.223`），否则 `anet node start` 会拒绝启动。

## What it does not do

- 不改变模型切换的既有判据
- 不声称原子性（见上）
- 不动 agent 切换
