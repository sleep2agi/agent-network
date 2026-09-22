# `@sleep2agi/agent-network@2.3.0-preview.103`

`.102` 之后 `agent-network/` **没有功能提交**。本版存在的唯一原因:**`.102` 在 npm 上变成了"幽灵 staged 版本"**——发布被接受(`+ @sleep2agi/agent-network@2.3.0-preview.102`,provenance 已进 sigstore 透明日志 logIndex 2909654339,14:37Z),但 40 分钟后 registry 读路径仍无该版本;重发同号得到 `E409 Cannot publish over previously staged version "2.3.0-preview.102"`;而 owner 账号 `npm stage list` 为空,无 stage-id 可 approve/reject。与 npm/cli#9889 的形态逐字相同(该 issue 无官方回复)。**`.102` 这个号作废,不再重试。**

配对不变的一半:`agent-node@2.5.0-preview.78` 已正常在 npm(发布后 4 分钟可见,tarball 已解包复核 0 处合作团队别名)。本版只把 `PAIRED_AGENT_NETWORK_VERSION` 改成 `.103`;`PAIRED_AGENT_NODE_VERSION` 仍是 `.78`。agent-node 不反向钉 anet 版本,所以 `.103 ↔ .78` 成立。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.103
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.103 @sleep2agi/agent-node@2.5.0-preview.78
```

🔴 **两个包要一起升。** 配对是精确的(`.103 ↔ .78`);本版内容与 `.101` 相同(`.102` 从未可安装),#1946 的修复在 `agent-node@.78` 里。

## 边界与证据

- 本包 `dist/` 与 `.101` 的差异只有 `opencode-agent-node-pair` 里的配对常量与 `getting-started` 的版本戳。
- 发版判据仍是 registry 直读;若本版再次出现"已接受但不可见",按 npm/cli#9889 处理:不重发同号,换号。
- doc 门(symbol pins / source pins / version claims)rc=0;pair parity 测试绿。

## promote 时的 must_contain

`"version": "2.3.0-preview.103"`
