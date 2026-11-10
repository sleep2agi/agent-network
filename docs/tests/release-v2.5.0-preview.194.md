# agent-node 2.5.0-preview.194

Since `.192`: 修掉「能力位已经是 true，但写入仍被判 `variant_unsupported`」。

## Why

实测（真机）：`opencode_variant_config_capable=true`，但发 `{modelVariant:"low"}` 得到 `rejected / variant_unsupported`。

根因在 `applyVariantConfig` 的分支判据：它看**方法是否存在**来选路径，而在 stock 构建上
`selectedSessionModel` / `selectSessionModel` 是存在的 —— 它们由 test-build 控制器提供，
调用时才返回 `unsupported`。于是代码永远走控制器分支，新的空闲闸门写入器从未被使用。

## What changed

```text
runtime/opencode-copresence/variant-config-apply.ts
  · 依据 `variantConfigTestOwned !== true` 优先走 setSelectedVariant（空闲闸门写入器）
  · 方法存在不等于可用 —— 这条注释写进代码
```

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.194
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.194
```

⚠️ 与 CLI `2.3.0-preview.226` 精确配对，先 node 后 CLI。

## What it does not do

- 不放宽 test-build 身份钉住
- 不改变写入的空闲闸门与回读校验
- 不声称原子性
