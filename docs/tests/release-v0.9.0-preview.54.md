# `@sleep2agi/commhub-server@0.9.0-preview.54`

## 为什么发这一版:**响应 gzip + `?light=1` 的 task 截短**(#1897)

`.53` 之后 `server/src` 一个功能提交:

| PR | 内容 |
|---|---|
| #1897 | 客户端 `Accept-Encoding: gzip` 时对 JSON/文本 ≥1 KB 响应 gzip(`http-gzip.ts`;SSE / 流式 / 206 / Content-Range / Content-Disposition / 已编码 / HEAD 不碰,`Vary: Accept-Encoding`);`/api/status?light=1` 的 `task` 截到 160 字 + `…`(占 light 载荷 52%),全量 `/api/status` 不变 |

| 用户看到的 | `.53` | `.54` |
|---|---|---|
| 桌面端经 RELAY(~13 KB/s)拉 294 节点列表 | 128 KB,17 s,每 10 s 一次把链路占满 | ~30 KB(gzip)且 task 截短,配合桌面 0.2.69 的轮询退避 |
| 一页 20 条聊天记录 | 41 KB,5.6 s | ~15 KB |

## Install

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.54
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.54
# 生产 hub 走 deploy/hub/README.md 的六步(改 launcher 的 RUNTIME_DIR 那一行,pm2 restart),不要整文件覆盖
```

## 证据

- `http-gzip.test.ts` 4/4(往返解压、q 值、跳过类别),变异「不看 Accept-Encoding」见证红;`uploads-http.test.ts` 15/15(Range/附件不被压)。
- 一次性 hub 300 条 sessions 实测:`?light=1` 191 KB → 2.1 KB(gzip),解压逐字相同。

## promote 时的 must_contain

`"version": "0.9.0-preview.54"`
