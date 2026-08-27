# @sleep2agi/agent-network 2.3.0-preview.52 — release notes

本版与 `@sleep2agi/agent-node@2.5.0-preview.38` **配对发布**（两个包的版本必须成对，
`opencode-agent-node-pair.ts` 里的 `PAIRED_*` 常量把它们钉在一起）。
**只发 `preview` 通道**；promote 到 `latest` 需要 owner ACK。

## 本版包含

相对 `2.3.0-preview.51`，触及这两个包的改动（按合入 main 的提交列，不按印象）：

- **#1314** `create_node` 的 `model` 变成可选 —— 不传就不生成 `--model`，传了仍校验非空且合法。
  这是「复用已有登录态、不必自己填 key/url」那条路上的一步。
- **#1312** 「哪个运行时复用哪种外部登录态」收敛到单一来源。
- **#1301** 三处 runtime 闸口带着同一份过期的 trust 表，导致 **TUI 共存节点建不出来**。
- **#1292** `delete_node` 在 stop 之后什么都没做，却照样 ack。
- 版本号与 pin 同步（`PINNED_SERVER_VERSION` / `PAIRED_*`）。

## Install

```bash
npm install -g bun @sleep2agi/agent-network@2.3.0-preview.52 @sleep2agi/agent-node@2.5.0-preview.38
anet --version
```

🔴 **两个包必须同版本对装。** 只升其中一个会让 `PAIRED_*` 常量指向一个没装上的版本。

## Upgrade

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.52 @sleep2agi/agent-node@2.5.0-preview.38
```

🔴 **hub 不在这两个包里。** `anet hub start` 按 `PINNED_SERVER_VERSION` 去拉
`@sleep2agi/commhub-server`；**hub 侧的修复（时区/在线判定、未读数、桌面推送）要单独升 hub**，
装这两个包拿不到。

## Verification

判据是**产物存在 + 运行版本**，不是安装命令的退出码：

```bash
npm view @sleep2agi/agent-network@2.3.0-preview.52 version
anet --version
```

## 已知不支持

- `latest` 通道未动（promote 需 owner ACK）。
- Windows 上 `anet daemon` 仍被显式拒绝（#1290）。
