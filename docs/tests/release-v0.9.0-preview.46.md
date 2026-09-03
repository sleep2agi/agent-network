# commhub-server 0.9.0-preview.46

## 为什么发这一版

`.45` 对标准 MCP 客户端的 `tools/list` 直接抛 `MCP error -32603 … schema._zod`（#1756）：四处
`z.record(z.unknown())` 在 zod v4 下 value schema 是 undefined，SDK 生成 JSON Schema 时炸。
凡是按标准接入的客户端（Claude Code 的 MCP 配置、Inspector）拿不到工具清单；桌面端/anet
走直调 `tools/call` 不受影响，所以之前没人发现。修复在 #1763（`3edc357d` 之后合入，
`a60698a0`）。

`.45` 之后改到 `server/` 的提交（`files: ["src","bin"]`，源码直发）：

| 提交 | PR | 内容 |
|---|---|---|
| `a60698a0` | #1763 | **主角** —— 四处单参 `z.record` 改 `(z.string(), z.unknown())`；守卫测试 `src/tools-list-json-schema.test.ts`（每个工具单独 toJSONSchema + listTools 条数 == 登记表） |

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.46
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.46
# hub 需要重启才会用新逻辑;无新表、无迁移
```

验收（SOP §2.5 四步）：

```bash
npm view @sleep2agi/commhub-server dist-tags.preview        # 期望 0.9.0-preview.46
npm pack @sleep2agi/commhub-server@0.9.0-preview.46
tar -xzf *.tgz
grep -rc 'tools-list-json-schema'          package/src   # 期望 >0(.45 = 0,闸 4 原样命令验过)
grep -rc 'z.record(z.string(), z.unknown())' package/src # 期望 >0(.45 = 0)
grep -rc 'daemon_cannot_create_nodes'      package/src   # 正控:期望 >0
```

promote 时 `must_contain` = `tools-list-json-schema`（无正则元字符；`.45` 产物上 0 命中，用闸 4 原样命令验过）。

## 🔴 本次**故意没有**改 `PINNED_SERVER_VERSION`

同 `.44`/`.45` 的理由：gate 2 拿它核对**已发布**。先发 `.46`，出现在 npm 后再单独改常量
（含 `agent-network/src/hub-version-skew.test.ts` 的 `PIN`、`tests/test766-bunx-preflight/run.sh` 字面量、
`deploy/hub/hub-daemon.sh` 的 `RUNTIME_DIR` + 升级记录）。

## 生产升级备注

生产 hub 现在跑 `.45` + **bun 1.4.0**（#1769，bun 1.3.14 在 uWS onClose 上 panic 三次后切的）。
升 `.46` 照 `deploy/hub/README.md` 六步，`BUN_BIN` 已在 `hub.env` 里，不用再动。
