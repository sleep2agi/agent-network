# `@sleep2agi/commhub-server@0.9.0-preview.48`

## 为什么发这一版:**/mcp 出错时客户端能拿到一句人话**(#695)

`.47` 之后 `server/` 只有一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| `f345b79a` | #1801 | `Bun.serve` 加 `error` 回调:fetch 处理器抛出时回 500 + `application/json`,body 带那个异常的 message(JSON-RPC 与 REST 双形状),不再是 Bun 默认的非 JSON 500 |

| 用户看到的 | `.47` | `.48` |
|---|---|---|
| hub 内部抛异常时 send_task 等 MCP 调用 | `-32603 Internal error`(一句话都没有) | `-32603` + `error.message` = 真正的异常信息 |

生产 hub 从 `.45` 直接升到 `.48` 可一并拿到 `.46`(#1756 tools/list schema)、`.47`(#1548 blocked 出口)。

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.48
```

## Upgrade

生产 hub 按 `deploy/hub/README.md` 六步;`PINNED_SERVER_VERSION` 暂留 `.47`(下一次 anet bump 再跟)。

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.48   # 自托管
```

## 证据

- `server/src/serve-error.test.ts` 2 条(纯函数 message 随异常变;真 Bun.serve port 0 抛出 → 500 + JSON + 同一条 message)。

## promote 时的 must_contain

`buildServeErrorResponse`(`.47` 产物 0 命中,已用闸 4 原样命令验)。
