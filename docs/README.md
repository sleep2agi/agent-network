# docs/ — 仓库内部文档索引

> 用户向文档在 [docs-site](https://anet.sh)（源码 `docs-site/docs/`）。本目录写给**贡献者与维护者**：架构、机制、发版、运维、踩坑。
> 历史文档一律以 [`archive/`](archive/README.md) 为准，不当作现状引用。

## 先读这几份

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 架构总图：CLI / Hub / node / daemon，消息与任务链路 |
| [message-lifecycle.md](message-lifecycle.md) | 一条消息从 Dashboard 到 runtime 的完整路径 |
| [node-lifecycle.md](node-lifecycle.md) | 节点状态机与生命周期（v0.8.2 定稿） |
| [getting-started.md](getting-started.md) | 本地跑通 + 常用命令 |
| [pre-pr-selfcheck.md](pre-pr-selfcheck.md) | 开 PR 前的自查清单 |
| [pitfalls.md](pitfalls.md) | Channel 插件实现踩坑 |
| [RELEASE-SOP.md](RELEASE-SOP.md) | 跨包发版同步 SOP |

## 发版与运维

- [release/](release/README.md) — 版本号策略、tag 绑定 build sha、各版本记录
- [release-main-sha.md](release-main-sha.md) — npm preview release 的 source 与 sha
- [runbooks/](runbooks/) — 值班手册（Feishu 频道运维、OpenCode TUI 共存、registry readiness、**任务「在跑」还是「卡住」的判断**）
- [ops/](ops/) — 升级实操记录
- [sop/](sop/README.md) — 协作 SOP（Dashboard 回帖、Codex jam 重启、方法论）
- [troubleshooting/](troubleshooting/) — 连通性 / 事故复盘
- [stale-issue-review.md](stale-issue-review.md) — 陈旧 issue 复核方法
- [team-collab-playbook.md](team-collab-playbook.md) — Agent 团队协作模式

## 设计、方案与 RFC

- [design/](design/) — 现行设计（daemon provider 管理、side thread 四段契约、本地上传桥等）
- [plans/](plans/) — 实施计划与稳定性分层
- [rfcs/](rfcs/) — RFC-001 起的决策记录；编号即顺序，读最新未 supersede 的那份

## 实现切片（随代码同步更新，不是历史文档）

这些文件由对应 feature PR 一起更新，留在顶层便于同步；改相关代码时必须同 PR 更新：

- Provider / daemon：[daemon-provider-creation](daemon-provider-creation.md) · [daemon-provider-collection](daemon-provider-collection.md) · [daemon-existing-codex-discovery](daemon-existing-codex-discovery.md) · [hub-provider-management](hub-provider-management.md) · [daemon-lifecycle-reliability](daemon-lifecycle-reliability.md)
- Codex 共存：[codex-adoption-v2](codex-adoption-v2.md) · [codex-fork-transport](codex-fork-transport.md)
- 认证与任务：[design-auth-network](design-auth-network.md) · [requirements-assignments](requirements-assignments.md)
- 通道与客户端：[paired-agent-node-fetch](paired-agent-node-fetch.md) · [user-avatar-api](user-avatar-api.md)
- 交付物：[standalone-anet-binary.zh](standalone-anet-binary.zh.md) / [.en](standalone-anet-binary.en.md) · [grok-build-runtime](grok-build-runtime.md) · [grok-build-cli-preview](grok-build-cli-preview.md) · [saas-skills-mode](saas-skills-mode.md)
- 批量工作流：[batch.md](batch.md) · 节点改名：[rename-guide.md](rename-guide.md)

## 参考资料

- [qa/](qa/README.md) — QA 矩阵与 v0/v1 门禁快照
- [analysis/](analysis/) · [internal/](internal/) · [scenarios/](scenarios/) · [demos/](demos/) · [tests/](tests/) · [sdk/](sdk/) · [version/](version/README.md)
- [assets/](assets/) · [images/](images/) · [dashboard-screenshots/](dashboard-screenshots/) — 图片素材

## 历史与归置中

- [evolution-log.md](evolution-log.md) — 已停更，版本沿革看 [docs-site changelog](../docs-site/docs/changelog.md)
- [open-source-quality-review.md](archive/open-source-quality-review.md) · [open-source-security-risk-report.md](open-source-security-risk-report.md) — 2026-05 开源前的评审，[SECURITY.md](../SECURITY.md) 仍引后者作审计记录
- 顶层若干历史文档正按 #1035 归入 `archive/ research/ plans/ design/`（PR #2613–#2616）；合入前以各文件顶部 banner 为准

## 相关门禁（CI）

| workflow | 打什么 |
| --- | --- |
| `lint (docs integrity)` | 任意 PR 里的 `*.md`：UTF-8 + `docs/qa/**` 相对链接 |
| `docs locale parity` | `docs-site/docs/**` 中英配对 |
| `doc-symbol-anchors` | 符号锚文本与目标一致（required check） |
| `home-path-baseline` | 带用户路径的文件搬家必须同步 [home-path-baseline.txt](home-path-baseline.txt)（required check） |

路径搬家时先查 [home-path-baseline.txt](home-path-baseline.txt)，再跑 `.github/scripts/check-docs-integrity.py`。
