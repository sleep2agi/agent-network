# agent-node 2.5.0-preview.192

Since `.191`: **普通（stock）构建终于能上报档位能力**，客户端因此能显示并更换思考档位。

## Why

`.191` 放开了档位写入与能力位的外层判断，但实测 `opencode_variant_config_capable` 仍是 `false`。根因在更里面：

```text
variantConfigReadback()
  → 读会话 / 读 catalog 都走 variantRequest()
  → variantRequest 第一行：if (!session.isRunning || !await testIdentityCurrent()) throw …
```

`testIdentityCurrent()` 校验的是 **test-build 身份**，stock 构建必然抛错 ⇒ readback 恒 undefined ⇒ 能力位恒 false。
这也解释了为什么装上 `.191` 后模型面板里仍然看不到档位可选。

## What changed

```text
runtime/opencode-copresence/v2-session.ts
  · readVariantSelection / catalog 读取：stock 构建改用 scopedRequest
    （test-build 仍走 variantRequest，身份钉住不放松）
  · 写路径不变：仍由 setSelectedVariant 的空闲闸门 + 回读校验把关
```

## 现场依据

当前模型 `deepseek/deepseek-flash` 的 catalog 明确带档位：`none / low / high / max` ——
所以此前"看不到档位"不是模型不支持，而是能力读回被身份闸门挡掉。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.192
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.192
```

⚠️ 与 CLI 精确配对：先 node 再 CLI（`2.3.0-preview.224`），否则 `anet node start` 会拒绝启动。

## What it does not do

- 不放宽 test-build 的身份钉住
- 不改变写入的空闲闸门与回读校验
- 不声称原子性（OpenCode 仍无会话 busy 标记）
