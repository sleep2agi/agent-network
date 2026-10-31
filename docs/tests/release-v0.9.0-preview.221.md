# CommHub v0.9.0-preview.221

This release carries the Hub changes merged since `0.9.0-preview.220`, built from main at `7bed7dd7b`.

## What changed

- **CORS：Origin 改成「解析后比较」。**
  - 原来是字符串比较（`CORS_ORIGINS.includes(origin)`）。浏览器或客户端把默认端口显式写进 `Origin`
    （`https://host:443`）时，若清单写的是不带端口的形式，会**静默不匹配**，那批用户全部被挡，而地址栏看起来正常。
  - 现在 `new URL(x).origin` 两端都规范化：主机小写、丢弃默认端口、去掉尾斜杠与路径。
  - 回写的 `Access-Control-Allow-Origin` 也用规范化后的值。
  - 语义变更（更严）：非法条目（`*`、裸主机名、非 http(s)）会被**丢弃**而不是原样保留 ——
    保留一条永不匹配的项会让运维以为已经放行。

- **建标签接口的 code→status 改成穷尽表。**
  - 原来是三元式，未映射的错误码默认落 400；有些码 400 是错的（冲突应是 409）。
  - 现在 `Record<TagCreateError, number>`，漏一个码在 typecheck 时红（注意：`server` 目前没有 tsc CI 门，
    这条约束在编辑器与未来的 typecheck 里成立）。

- 仅测试与门（不影响运行时）：失败信息点名、selftest 断言理由串、扫描域排除集显式化。

Migration: none.

Behaviour to be aware of:

- 若 `COMMHUB_CORS_ORIGINS` 里写了非法条目（如 `*`），它现在会被丢掉，等于**没有放行**。生产未设置该变量时走 localhost 默认，不受影响。

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.221`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.221
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.221
```

No schema change. Existing settings keep working. If your deployment sets `COMMHUB_CORS_ORIGINS`, check it for entries that are not a bare `http(s)://host[:port]` — those are now ignored.

## Rolling back

`0.9.0-preview.220` starts on a database that `.221` has run on; nothing to undo. Its CORS check compares strings, so an `Origin` that carries the default port explicitly will be refused again.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
