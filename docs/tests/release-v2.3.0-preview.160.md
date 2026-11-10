# ANet CLI 2.3.0-preview.160

只发布 CLI preview；配对保持已发布的 `agent-node@2.5.0-preview.126`。
不发布 Hub/runtime，不改变 `latest`，不自动升级运行中的节点。

## 本版内容

相对 `.159` 发版提交 `502390bfc79401935086f91455109fb6e96426ea`：

- PR #2530（main `1f638e4b67f063e26b4920b73599913b1c92e9d9`）：首次下载精确配对 runtime 的默认等待由 120 秒改为 300 秒，可用 `ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS` 配置；失败提示给出预取命令。已有代理环境仍透传。
- PR #2532（main `e60466ee4e1d3591a5c3fdd501eedc299cfdfc77`）：fork 恢复记录损坏或不可读时明确报错并保留原文件，在生成快照/调用 fork 前检查历史，写入时再次读取；只有文件不存在才允许首次创建。

## Upgrade notes

- 保留原 codex 二进制、版本、线程与节点启动方式。本版不修复损坏的 rollout，也不自动重建 fork 历史。
- 慢网可按实际需要设置 `ANET_AGENT_NODE_RESOLVE_TIMEOUT_MS`；不需要新增凭据或修改代理配置。
- Hub 批量改间隔 API 与客户端 fork 按钮不在本包交付范围。
- 不新增服务、端口、反代/隧道或数据库迁移；沿用仓库现有启动/部署方式。生产配置、会话和历史文件仍依赖既有备份，npm 包不包含这些数据。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.160 @sleep2agi/agent-node@2.5.0-preview.126
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.160 @sleep2agi/agent-node@2.5.0-preview.126
anet --version
```

已有 `.126` runtime 不需换版本。安装不等于正在运行的节点已更新；等待任务结束后逐个按原方式更新，保留节点身份和配置，不批量重启。

## 回滚

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.159 @sleep2agi/agent-node@2.5.0-preview.126
```

按原启动方式恢复节点。回滚会失去本次等待时长和历史保护修复，不能恢复已损坏的数据；数据恢复须使用备份，不应删除历史文件来绕过错误。

## 验证与发布边界

复用 #2530 / #2532 功能验收及 #2532 的 157 项成功 CI（含真实 Codex fork E2E）。版本 PR 只验证版本配对、文档断言和 CLI 构建，不重复扩大全套测试。
正式发布必须先合入 main，再按完整 40 位 main SHA 运行 `release.yml`，四道门通过后才发 preview；分支构建仅作测试。发布后另核 npm tag、tarball 和安装行为，本文件不宣称已经发布或生产部署。
