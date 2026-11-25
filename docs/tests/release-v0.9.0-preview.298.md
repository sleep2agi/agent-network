# commhub-server 0.9.0-preview.298

Since `.297`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.298
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.298
```

## What changed

```text
#3873 server/src/runtime-label.ts 补全 antigravity / antigravity-acp / antigravity-sdk 映射，
      /api/status（全量与 ?light=1）正确投影 runtime: "antigravity-acp" 而不再返回 null。
```

## Verified

```text
#3873 单测与 main CI 全量通过。
```
