# CommHub v0.9.0-preview.220

This release carries the Hub changes merged since `0.9.0-preview.219`, built from main at `41992b29c`.

## What changed

- **`/health` 匿名投影：每个键都要指得出读者。**
  - 新增 `PUBLIC_HEALTH_KEY_READERS`（与 `PUBLIC_HEALTH_KEYS` 同集合），每键登记 `reader ∈ cli | probe | external | operator`。
  - 声明 `reader=cli` 的键会被**跨源核对**：必须在 `agent-network/src` 或 `bin/` 里真的出现，否则红。
  - 新增 `operator` 档：`mcp_inflight` / `mcp_inflight_peak` / `event_loop` / `build_identified` 在仓内没有代码读者（读它们的是人），此前被记作 `external`，属于虚高。
  - 匿名 `/health` 的键集与三分类（landmark / gauge / credential）未变。

- **`GET /api/providers` 的空数组说清「为什么空」。**
  - 新增 `source_table: "hub_provider_configs"`、`state: configured | unconfigured`、`counts { providers, providers_in_cli_registry }`。
  - `unconfigured` 时带 `hint`，并区分两种情况：另一张表（CLI 注册表 `providers`）有行 / 两张表都空。
  - 起因：两条「providers」读的是**不同的表**（REST 读 `hub_provider_configs`；MCP `list_providers` 读 `providers`），而空数组在载荷里长得一样。

- **新增 `PUT /api/providers`（写侧）。**
  - 此前读有 REST、写只有 MCP，客户端能显示「还没有 provider」却无法录入第一行。
  - 直接复用 `putHubProvider`（owner 权限、`revision` 乐观锁、模型名与 `baseUrl` 校验、密钥永不回显）。
  - `revision` 缺失 ⇒ 400；冲突 ⇒ 409；非本网络成员 ⇒ 403。

- **`list_providers`（MCP）同样自报状态。**
  - 新增 `state` / `counts` / `hint`，每个 provider 带 `models_state ∈ available | all_disabled | none_configured`。

- **`ToolCaller` 的 `"unknown"` 改名为 `"anonymous"`（`why: "no_identity"`）。**
  - 它描述的是「没有身份」（旧全局令牌 / 未开鉴权），不是「查不清」。

- 门与测试（不影响运行时）：`check-jq-default-operator`、`check-shell-empty-equality`、`check-control-run`、`check-diff-shape`（含 commit-msg 钩子安装器）、副本分叉时打印两侧路径、`list_providers` 与匿名投影的结构性键集断言。

Migration: none.

Behaviour to be aware of:

- `GET /api/providers` 的响应多了 `source_table` / `state` / `counts`，`state !== "configured"` 时多一个 `hint`。按字段读的客户端不受影响；把整个响应当固定键集比对的调用方需要接受这两种形状。
- `mcp_inflight` 等四个字段仍匿名可读，但它们的读者在仓内不存在（人或仓外系统）。

This note is not proof of publication. Publish only by running `release.yml` from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.220`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.220
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.220
```

No schema change. Existing settings keep working. Clients that render the provider list can now distinguish 「没配过 / 全停用 / 没模型」 and, with an owner token, create the first row over HTTP.

## Rolling back

`0.9.0-preview.219` starts on a database that `.220` has run on; nothing to undo. Its `GET /api/providers` omits `state` / `counts` / `source_table`, and `PUT /api/providers` is 404 — a client must fall back to the「没有」显示 rather than treating the missing fields as `ok`.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
