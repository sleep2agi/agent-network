# ANet CLI 2.3.0-preview.159

配对保持已发布的 `agent-node@2.5.0-preview.126`。本次只发布 CLI，
不发布 Hub 或 agent-node，也不改变 `latest` 通道。

## 本版内容

相对 `.158` 的发版提交 `ef1e72828635b96665c0303e12995252c7f7a885`，
以下 CLI 行为改动已合入 main：

| 提交 | PR | 用户可见变化 |
|---|---|---|
| f1e526f9 | #2513 | 节点 config 的 `codexBin` / `codexVersion` 可固定可执行文件和预期版本；显式 `--codex-bin` 优先，版本不符时拒绝启动 |
| f1aa0e52 | #2520 | Codex TUI 必须出现输入区才报告就绪，避免只有启动画面就误报可用 |
| 9582c191 | #2521 | 识别并关闭已知模型迁移提示；未知提示不盲目发送按键 |
| 18a4d8a8 | #2517 | 桥 READY 且 TUI 的进程树/连接归属检查通过后释放恢复租约；前台 launcher 继续运行也不占住后续节点的恢复槽，失败和退出路径同样释放 |

#2522 只强化 tee 日志命令测试，没有额外产品行为。
同期 Hub 改动、agent-node 未发布的收编改动不属于本 CLI 包。

## Upgrade notes

- 保留节点原来的 codex 可执行文件、版本、线程和启动方式；不要因为升级 CLI 换掉共享 codex。
- 恢复槽容量、内存判据、租约 TTL 和心跳间隔不变。本版修的是释放时机，不是取消内存保护。
- 不需要数据库迁移或 Hub 升级。旧进程不会因安装新 CLI 自动换版；让正在处理的任务完成，再逐个使用新 CLI 停/启节点。
- 不要杀仍在运行的 launcher 来手动释放租约，它可能是节点的父进程。
- 曾使用每节点 `ANET_CODEX_RECOVERY_SLOTS_DIR` 绕过共享槽的部署，不会被安装命令自动修改；部署者需另行安排恢复共享槽并核验串行恢复，不能批量重启。
- 本次发布不修改生产启动器、端口/隧道、密钥来源、数据库或会话数据；软件包不包含这些运行状态，仍由既有配置和备份恢复。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.159 @sleep2agi/agent-node@2.5.0-preview.126
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.159 @sleep2agi/agent-node@2.5.0-preview.126
anet --version
```

已有 `.126` runtime 无需换 runtime 版本。运行节点的实际更新另行安排；本说明不宣称已完成生产升级。

## 回滚

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.158 @sleep2agi/agent-node@2.5.0-preview.126
```

再按原启动方式逐个恢复节点。回滚会失去上述四项 CLI 改进，尤其可能再次出现恢复租约占用；
不会修复已经损坏的 rollout，也不代表可以更换 codex 版本。

## 验证与发布边界

- 功能证据复用 #2517 最终提交的 155 项通过检查，包括 test1178、test738、test739 和共存启动用例；不重复跑无关全量测试。
- 版本 PR 仅补版本/配对与文档版本断言检查。发布须先合入 main，按完整 40 位 main SHA 执行 `release.yml`，四道现有发布门通过后才发 preview。
- 安装与产物核验结果在发版后补到发布记录；当前不是生产部署验收。
