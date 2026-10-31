# CommHub v0.9.0-preview.227

This release carries the Hub changes merged since `0.9.0-preview.226`, built from main at `e0ee4fdb4`.

## What changed

- **`COMMHUB_CORS_ORIGINS` 里的非法条目改成「启动即拒绝」。**
  - `.221` 起非法条目会被**丢弃**（等于不放行）——那是「解除武装」，不是「修好」：
    配置仍然是错的，而且没有任何信号，运维只会看到「前端突然 CORS 不过」。
  - 现在启动时逐个检查：出现不是 `http(s)://host[:port]` 的条目 ⇒ **抛错，拒绝启动**，并点名那几个值。
  - 未设（走 localhost 默认）与设空（空清单，更严）都仍然合法。

Migration: none.

Behaviour to be aware of: **如果某个部署把 `COMMHUB_CORS_ORIGINS` 写成了 `*` 或裸主机名，升级后它不会启动。**
这是有意的：那样的清单本来就是错的（`*` 从来没有通配语义）。启动失败信息里会列出非法条目。

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.227`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.227
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.227
```

Before restarting, check `COMMHUB_CORS_ORIGINS` for entries that are not a bare `http(s)://host[:port]`;
the process now refuses to start with such a list.

## Rolling back

`0.9.0-preview.226` starts on a database that `.227` has run on; nothing to undo. Its behaviour returns to
"silently drop the invalid entries".

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
