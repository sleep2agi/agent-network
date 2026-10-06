# agent-node 2.5.0-preview.116

自 `.115`（发版合并 `d49128cb`，#2431）以来，`agent-node/` 有 1 个改动（`git log d49128cb..origin/main -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| d174f894 | #2434 | #637 #638：节点启动时读取自己目录下的 `secrets.env`（必须是 `0600`）；daemon 建节点时把密钥写进这个文件 |

（同期合入、不在本包里的：#2432 只改 agent-network，见 anet `.149` 说明；#2427、#2433 只改 Hub。）

## 你会看到的变化

- **节点会读取自己的 `secrets.env`（#2434，#637）。** agent-node 启动时只读 `<节点目录>/secrets.env`（与 `config.json` 同目录，和 `anet node secret`（#2056）用的是同一个文件名），没有全机共用的文件。优先级从高到低：
  1. 进程启动时已经存在的环境变量（空字符串也算已设置）；
  2. `config.json` 里 `env` 指定的键（仍由原来的注入逻辑处理）；
  3. 这个文件，只补缺、不覆盖。
- **文件不安全就拒绝启动。** 文件不存在没关系；但如果它是符号链接、属主不是当前用户，或权限不是 `0600`，节点**拒绝启动且一个键都不加载**。保留键会被跳过。日志里只打印键名，从不打印值。
  - 🔴 升级前请检查已有的 `secrets.env`：权限不是 `0600` 的，升级后节点会起不来。修法：`chmod 600 <节点目录>/secrets.env`。
- **daemon 建节点时把密钥写进 `secrets.env`（#2434，#638）。** 以前 daemon 把建节点时带来的 env 写进一个 agent-node 从来不读的 dotenv 文件名；现在写进 `secrets.env`，权限 `0600`。

## 与 Hub 的配合

- 不需要升级 Hub。#2434 在 `server/` 里只改了两处注释（文件名），Hub 行为不变。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.116
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.149 @sleep2agi/agent-node@2.5.0-preview.116
```

升级后节点要重启才会读取 `secrets.env`；daemon 要重启（`anet daemon restart <名字>`）才会改用新文件名写密钥。
- 🔴 **两个包一起升级**（`agent-network@2.3.0-preview.149 ↔ agent-node@2.5.0-preview.116`）。
- 发布顺序：先 agent-node `.116`，再 agent-network `.149`，两者来自同一个合并提交。

## 证据

- #2434：`agent-node/src/node-secrets.test.ts` 埋入一个假密钥，断言子进程环境拿到了它、日志和 argv 里都没有它的值。Docker `oven/bun:1.3.14`：9 pass / 0 fail；去掉加载调用并把写入改回旧文件名：3 fail。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.116"`
