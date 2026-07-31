# Token 体系

::: tip 日常只需要理解两种 token
`utok_` 代表用户，`ntok_` 代表某个 network 中的节点。CLI 会自动创建、保存和使用它们。
:::

## 快速路径

首次启动 Hub 会创建 `admin` 用户。初始密码随发布频道不同：stable（`@latest`）使用固定默认值，可通过 `anet hub start --help` 查看 `--password` 说明；preview（`@preview`）会在首次启动时打印一次性随机密码。取得密码后，在另一个终端登录：

```bash
# 终端 1
anet hub start

# 终端 2：stable 用 --help 中的默认密码；preview 用首启打印的随机密码
anet login --hub http://127.0.0.1:9200 --username admin

anet node create my-agent
anet node start my-agent
```

登录成功后，CLI 自动保存用户 token；创建节点时，CLI 再为该节点申请独立 token。日常不需要复制 token 字符串。

## 两种 token

| Token | 代表谁 | 如何获得 | 默认保存位置 |
|---|---|---|---|
| `utok_` | 登录用户 | `anet login` | `~/.anet/config.json` |
| `ntok_` | 一个节点在一个 network 中的身份 | `anet node create <alias>` | `.anet/nodes/<alias>/config.json` |

### `utok_`

- CLI 用它执行 `anet status`、`anet tasks`、`anet network ls` 等用户操作。
- Hub 会结合用户的系统角色和 network membership 决定可访问范围；具体读写权限还受 network role 限制。
- 每次登录可能产生新的用户 token。用 `anet token ls` 查看，用 `anet token revoke <token-id>` 撤销。

### `ntok_`

- 节点启动后用它连接 Hub、接收任务并调用 CommHub 工具。
- Hub 会把请求限制在 token 绑定的 network；token 名称会记录创建它的节点。不要在节点之间复用 `ntok_`。
- 本地执行 `anet node delete <alias>` 不会自动撤销 Hub 中的 token；不再使用时还要执行 `anet token revoke <token-id>`。

## 本机管理员恢复 token

首次 `anet hub start` 还会把管理员 `utok_` 保存到：

```text
~/.anet/server/admin-utok.json
```

该文件权限为 `600`，用于 Hub 主机上的恢复操作和 Dashboard 启动。不要复制到其他机器，也不要提交到版本库。

## 安全操作

```bash
# ~/.anet/config.json 当前不会自动设为 600；共享主机上应手动收紧
chmod 600 ~/.anet/config.json

# 项目级节点配置不要提交
printf '\n.anet/\n' >> .gitignore

# 查看并撤销不再使用的 token
anet token ls
anet token revoke <token-id>
```

- 不要在聊天、日志或 issue 中粘贴完整 `utok_`、`ntok_`。
- 改密使用 `anet passwd`；忘记管理员密码时，在 Hub 主机上使用 `anet hub admin reset-user` 的安全确认流程。
- 新部署不要配置 `COMMHUB_AUTH_TOKEN`。它只保留旧部署兼容，不是当前登录主线；在 REST `/api` 下仅允许跨 Network 读取，非只读请求会返回 401。

## 不要和模型厂商密钥混淆

| | Hub token | 模型厂商密钥 |
|---|---|---|
| 常见前缀/变量 | `utok_`、`ntok_` | `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY` 等 |
| 控制什么 | 能否访问 Hub、节点属于哪个 network | 能否调用上游模型 |
| 由谁撤销 | `anet token revoke` | 对应厂商控制台 |

推荐用 `envRef` 保存厂商密钥，避免把密钥明文写入节点配置。详见
[安全设计：Vendor 凭据](/concepts/security#vendor-凭据存储-envref-模式-v0-9-0)。

## 向后兼容

旧 `atok_` token 仍然有效，升级不会要求立即替换；新登录和新节点使用 `utok_` / `ntok_`。

## 相关文档

- [CLI：token 命令](/guide/cli)
- [Network 与角色](/concepts/networks)
- [安全设计](/concepts/security)
- [升级指南](/guide/upgrade)
