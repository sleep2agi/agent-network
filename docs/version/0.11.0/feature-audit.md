# v0.11.0 功能靠谱度盘点（用户旅程真机走查）

> 0号工作流产出。判定针对**用户按文档实际走**：✅ 能用 / ⚠️ 带坑能用（坑写明）/ ❌ 不能用 / ⏳ 待走查。
> 判定分 **latest**（用户默认装到的）与 **preview** 两列——规则0：latest 只留 ✅。

## 基础旅程

| 旅程 | latest | preview | 证据/坑 |
|---|---|---|---|
| 安装 CLI（Linux/macOS） | ✅ | ✅ | 真机隔离装 2.2.21，`anet --version` 正常 |
| 安装 CLI（**Windows**） | ❌ 跨盘即崩 | ✅ | #446：cwd 盘≠安装盘 ENOENT；preview.29+ 已修并真 Windows 验证；**latest 等 v0.10.16 热修** |
| `anet login`（全新机器） | ⚠️ | ⚠️ | 必须带 `--hub`（裸 login 报 No hub configured）；文档已全改带 --hub，hub start 提示语也已修（preview） |
| `anet doctor` / `whoami` / `--help` | ✅ | ✅ | 真机验：无配置时优雅报错并给下一步指引 |
| `anet upgrade` | ✅ | ✅ | 真机验 dry-run/--no-auto-self/channel 判定；默认自动装+自升（#154） |
| `anet status` / `tasks` / `network ls`（登录后查询三件套） | ✅ | ✅ | 真机验（2026-07-16，隔离 hub）：三条对新 hub 均正确渲染（0 agents/无任务/默认网络⭐） |
| `anet hub start`（自建 hub 全流程） | ✅ | ✅ | 真机从零走通（2026-07-16）：hub start(指定端口) → health 200 → 默认 admin/anethub 登录（带 --hub）→ node create → node ls 全链 PASS；坑：latest banner 的登录提示缺 --hub（preview 已修，照文档走没问题） |

## 建节点 & 跑任务（按 runtime）

| runtime | latest | preview | 证据/坑 |
|---|---|---|---|
| claude-code-cli | ✅ | ✅ | 生产 fleet 每天在跑（Tier 0）；首跑 dev-channels 确认框需 TTY（文档已写） |
| claude-agent-sdk | ⏳ | ⏳ | 待走查：vendor picker→envRef→跑任务全程；行为依赖厂商 |
| codex-sdk | ⏳ | ⏳ | 待走查：`codex login` 态复用→派任务；OAuth 无 CI |
| grok-build-acp | ⚠️ | ⚠️ | 真机走查 PASS（2026-07-16，Docker 隔离，证据 docs/tests/p-0.11.0-grok-acp-journey/）：全链路真通、grok 真回复（15s replied）、grokSession 持久化与文档一致。坑：① 文档 REST 示例缺 network_id 原样必失败（已修文档）+ hub 报错文案在单网络下自相矛盾（业务，待立案）② $ANET_TOKEN 等变量全站未定义获取方式（已修文档）③ /api/networks 返回 name:null（业务，待立案）④ latest 的 create 提示打的是错误的 `grok auth login`（preview 已修，等 canonical）。headless 鉴权：复制 ~/.grok/auth.json 可用 |
| codex-app-server | —（latest 不含） | ⚠️ | 真 Windows 验过一轮（含共存 attach 命令）；未泡验；flag 已实现 |
| opencode-cli | —（latest 不含） | ⚠️ | release ops 官方 registry 冷装 E2E PASS（test385）；需精确 pin |

## 通信 & 面板

| 旅程 | 判定 | 证据/坑 |
|---|---|---|
| dashboard 发消息→agent 回复显示 | ⚠️ | 机制通（真机验）；坑①agent 必须终态 status 回（[已成文](../../sop/agent-reply-to-dashboard.md)+进 MCP 上下文）坑② prod 传输(HTTP/2/SSE)待 infra 修，拥塞降级 PR#37 待合 |
| dashboard 节点操作（重启/停止/删除） | ✅ | 生产在用（RFC-027） |
| dashboard 长会话历史 | ⚠️ | 大会话加载超时（根因 prod 传输，hub 本身 3ms）；PR#37 降级兜底待合 |
| Telegram channel | ⚠️ | 本迭代全程在生产用（可靠）；坑：per-node state 目录、allowlist 可被 git clean 卷走（文档已写） |
| Feishu channel | 🚫/❌ | 安全走查完成（2026-07-16，未触任何 live 群/生产节点/secret 值）：🚫 缺测试飞书 App，真实鉴权/WS 未验；已确认 ❌×2：① Docker 从零旅程阻断——文档把 allowlist 写可选但 CLI 要求至少一个 --allow（否则 exit 1），entrypoint 又吞错继续启动=channel 静默漏绑，且多 ID 逗号串存成单元素不命中；② "bridge online"/"client ready" 是假阳性（SDK start 即置 connected，dummy 凭据也 online），无可信鉴权成功标志。另：权限文档缺 p2p/group_at 接收权限、长连接域名应为 open.feishu.cn 非 api、订阅顺序有坑。**需要：测试企业 App + onReady 成功日志，然后重验** |
| 文档站 anet.sh | ❌ | 部署冻结在 7/2，40+ 修复未上线（等 Vercel 后台 redeploy）；GitHub 侧文档 ✅ 是新的 |

## 走查方法（补 ⏳ 时照此）

1. 干净环境（Docker/新用户目录），只照公开文档操作，不用内部知识。
2. 每步记录：命令→预期→实际；卡壳即坑，坑即记录。
3. 结论回填本表 + 证据（输出/截图/报告路径）。
