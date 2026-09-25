# 更新日志

按时间倒序列出面向用户的变化。查通道此刻指向哪个版本：`npm view @sleep2agi/agent-network dist-tags`（`agent-node`、`commhub-server` 同理）；每一版 npm 包的完整发布说明在仓库的 [`docs/tests/release-v<版本号>.md`](https://github.com/sleep2agi/agent-network/tree/main/docs/tests)，桌面端见 [agent-network-app releases](https://github.com/sleep2agi/agent-network-app/releases)。

## 节点可见性：规则文件、技能、项目文件夹——preview（2026-09-23 至 09-25）

三包配套发布：`commhub-server@0.9.0-preview.56–.60`、`agent-node@2.5.0-preview.85–.88`、`agent-network@2.3.0-preview.110–.115`（`agent-node@.84` 未在 npm 上可见，由 `.85` 取代）。

- **项目文件夹只读浏览**（#1999）：新 hub 工具 `list_node_files` / `read_node_file`，可逐层浏览节点工作目录、查看文本文件（≤256 KiB）。`.env*`、私钥、`auth.json` 等凭据类文件只列名、不给内容；路径与软链接不得逃出工作目录；节点 token 不能发起浏览。需要 hub `.59` + agent-node `.88`（或 anet `.115`）+ 桌面端 0.2.94
- **节点技能只读查看**（#1984）：`list_node_skills` / `read_node_skill`，按各运行时（codex / grok / opencode / Claude Code）真实加载位置列出技能并读取 SKILL.md
- **Claude Code 会话也能远程读写 CLAUDE.md**（#1977）：`read_node_rules_file` / `write_node_rules_file` 新增 `alias` 参数，可定位没有节点行的会话；已在跑的会话需重启到 anet `.111` 才会上报能力
- **暂存内容自动清理**（#2001，hub `.60`）：规则文件、SKILL.md、文件读取结果在请求方取到后 60 秒清空，未被取走的 24 小时后清空，30 天后删行；首次部署会一次性清掉 24 小时以上的旧内容
- **取件按 token 绑定的节点解析**（#1994，hub `.58`）：同一别名在库里有多行时，规则文件 / 配置更新请求不再被派到旧行、空等 60 秒
- **codex-app-server 启动更稳**（#1988 / #1989 / #1991）：新增 `ANET_QUEUE_TIMEOUT_MS`（排队截止）与 `ANET_CODEX_RESUME_TIMEOUT_MS`（启动恢复会话，默认 120 秒，超时重试一次）；恢复失败先向 hub 报离线再退出，hub 不再把死节点显示成 idle；未绑定的旧 token 只停出站对账、不再连收件箱补偿一起停
- **daemon 开机后仍能建节点**（#1976，anet `.110`）：经 `anet node start/restart` 或开机扫起的 daemon 同样钉死 anet 二进制，不再「在线但建不了节点」

---

## 桌面端 0.2.85–0.2.97（2026-09-24 至 09-25）

macOS（Apple Silicon）与 Windows（x64）签名更新。

- **界面**：更简洁的配色与层次（背景色区分层级、正文对比度 ≥4.5:1），细滚动条悬停才出现；长代码、哈希、URL 在气泡内换行
- **节点页重做**（0.2.87–0.2.88）：头部卡片 + 分区导航（概览 / 模型与运行时 / 规则文件 / 技能 / 任务 / 危险操作）；任务按进行中、排队、可能卡住、最近完成分组；宽窗口居中铺开
- **规则文件编辑器**（0.2.85–0.2.93）：Codex / OpenCode / Claude 节点均显示；默认「阅读」模式按排版渲染，支持全屏带目录、双击段落跳到对应源码编辑；修复定时刷新冲掉未保存内容；agent-node 过旧时直接提示需要的版本，不再空等 60 秒
- **技能与项目文件夹**：只读技能区（0.2.87）与项目文件夹浏览（0.2.94），版本不够时提示要升级什么
- **未读与通知**：修复 macOS 菜单栏未读数不消失、面板只列 20 个会话（0.2.92）；节点列表顶部新增「新消息」组（0.2.95）
- **规则文件查找与替换**（0.2.97）：`Ctrl+F` / `⌘F` 在阅读、编辑、全屏里都能查找并在结果间跳转，编辑模式可替换，只改草稿、保存后才写回节点；读取最多 90 秒内一定出结果或原因，内容过期时不再显示成可编辑的空文件
- **新建 Grok 节点默认 ACP 模式**（0.2.97）：共存模式移到「高级」并标为实验性
- **其他**：设置 → 关于的检查更新总有明确结果（0.2.88）；全屏阅读时 macOS 红绿灯与 Windows 窗口按钮不再被遮挡（0.2.96）；Grok TUI 共存运行时在向导中标为「预览」

---

## 队列正确性与运行时修复——preview（2026-09-22 至 09-23）

`agent-node@2.5.0-preview.76–.83`、`agent-network@2.3.0-preview.100–.109`（`.102` 在 npm 上作废，由 `.103` 取代）。

- **codex 队列不再白跑或偷跑**（#1939 / #1945）：所有终态路径都会摘掉本地排队行；排队行出队前先问 hub，已被确认或已终态的任务不再起一轮 turn
- **grok-build-acp 真正使用配置的模型**（#1961）：启动时传模型并调用 `session/set_model` 回读核对，不一致则在任何 prompt 之前报错；hub 上报的是实际生效的模型
- **codex 二进制可显式选择**（#1971）：按 `codexBin` 配置 → `ANET_CODEX_BIN` → PATH 上不低于内置版本的 `codex` → 内置 的顺序选择，启动日志打印路径与版本；解决干净安装内置 codex 过旧、新模型报「requires a newer version of Codex」的问题。配套 #1974 不再对新 codex 误报推理档位告警
- **opencode 共存远程改模型后能恢复**（#1950 / #1964 / #1966）：重启不再因自己上一代留下的 `ANET-COMMHUB.md` 拒启；旧的 attach TUI 被精确停掉，并在原 tmux pane 里重新接上新会话
- **`anet node codex fork` 补齐五处**（#1954，anet `.104`）：自动创建 `--workdir`、改写项目表头、`--model` 覆盖与不一致警告、预探空闲端口、`AGENTS.md` 随 fork 走
- **grok 共存标为预览**（#1968）：`anet setup` / `anet node create` 与文档中 `grok-build-cli` 标「预览」，推荐稳定的 `grok-build-acp`；未验证 grok 的拒起报错附可复制的 `GROK_BINARY=… anet node start` 恢复命令

---

## codex 共享登录检测 + 长回合可观测——preview（2026-09-19 至 09-20）

`agent-node@2.5.0-preview.73–.75`、`agent-network@2.3.0-preview.97–.99`。

- **多节点共用同一份 codex 登录会被点名**（#1920 / #1928 / #1931）：启动时按 refresh token 指纹检测，命中即告警并列出共用的节点（只告警、不拒启）。检测在 agent-node 内执行，直接启动的节点同样覆盖；比较范围为整台主机（`~/.anet/codex-auth-fingerprints/`）。要完整功能请用 anet `.99` + agent-node `.75`
- **刷新失败给出命名原因**：`rotation-conflict`（token 已被别的节点用过，需重登一次）与 `token-endpoint-unreachable`（出网到不了 token 端点）分开说明；文案明确不要去拷别的节点的 `auth.json`
- **长回合心跳**（#1919）：grok 节点在回合进行中每 30–60 秒写一行 `in-flight: … elapsed=… last=…`，「看着不动」与「真的卡住」可以区分
- **stderr 降噪**：已知无害的 grok stderr 每回合折成一行 INFO，不再刷满 WARN
- **`ANET_LOG_LEVEL`**：新增 `ANET_` 前缀的日志级别变量，非法值会告警一次（此前 `LOG_LEVEL` 写错会静默回落到 info）

---

## 附件、跨 WAN 起节点、未读清零——preview（2026-09-14 至 09-17）

`commhub-server@0.9.0-preview.54–.55`、`agent-node@2.5.0-preview.69–.72`、`agent-network@2.3.0-preview.90–.96`（`.94` 未在 npm 上可见，由 `.95` 取代）。

- **回复里的本机文件链接自动变附件**（#1869 / #1876）：任何运行时在回复中写 `[名字](/绝对路径)`，桌面端即显示可下载的附件卡片；上传不了会注明原因（不在工作目录/家目录内、超 12 MB 等）；claude-code-cli 节点的 `attachments` 写成字符串也不再丢
- **跨 WAN 连 hub 不再被误判**（#1882）：`anet node start` 的 hub 健康探测对非回环地址默认 10 秒，可用 `ANET_HUB_HEALTH_TIMEOUT_MS`（1000–60000）覆盖
- **hub 响应 gzip**（#1897，hub `.54`）：≥1 KB 的 JSON/文本响应按需压缩，`/api/status?light=1` 截短任务文本，慢链路上节点列表与聊天记录明显变小
- **按 agent 一键标已读**（#1909，hub `.55`）：`POST /api/messages/ack` 支持 `{ "agent": "<alias>" }`，一次清空该 agent 的全部未读（桌面端 0.2.73+ 使用）
- **已终态任务不再重跑**（#1902）：串行队列出队前查一次任务状态，已回复/已关闭的任务只 ack 不起 turn
- **claude-code 节点收件箱一次取空**（#1901）：每个新任务事件把积压取完，第 6 条起不再拖到下一个事件
- **opencode 共存回件归属**（#1912）：经上下文压缩的长回合不再被误判为「非本任务回复」而丢掉答案；仍被拒时原文附在错误件里
- **共存身份回收器只认本节点进程树**（#1872）：继承了节点标记的无关进程不再被当作上一代杀掉；grok 共存两类常见启动失败附恢复命令（#1882 / #1888）；`anet grok --help` 列出 `model` 子命令（#1886）

---

## 桌面端联动与 Codex 生命周期控制器——preview（2026-09-06 至 09-10）

`commhub-server@0.9.0-preview.50–.53`、`agent-node@2.5.0-preview.67–.68`、`agent-network@2.3.0-preview.86–.89`。

- **`anet node codex` 生命周期命令**（#1856，anet `.89`）：`preflight` / `verify` 只读体检；`start` / `restart` / `resume` 确定性启停并失败回滚；`fork` 继承历史建新节点；`account register|list|install` 与 `rollback` 管理登录；`canary` 顺序验证。另有 `anet node edit --workdir`
- **回复附件显示在正确的气泡**（#1824，hub `.50`）：agent 回复的附件不再画进提问者的气泡，也不再覆盖提问者自带的附件
- **按 agent 的权威未读数**（#1838，hub `.51`）：`GET /api/messages?scope=user` 返回 `unread_by_agent` / `unread_total`，ack 同步到所有设备
- **向导能看到建节点失败原因**（#1843，hub `.52`）：新增 `GET /api/node-create-requests?request_id=`，直接显示 daemon 回报的错误
- **OpenCode 共存支持 macOS**（#1847 / #1848 / #1849）：包身份校验、启动隔离、进程身份三层补齐 darwin（Windows 仍不支持）
- **模型名允许 `provider/model`**（#1853）：hub 与 daemon 同步放行一个斜杠，向导可建带 `opencode/…` 模型的节点

---

## 共存节点与 CLI 可靠性——preview（2026-09-03 至 09-04）

`commhub-server@0.9.0-preview.46–.49`、`agent-node@2.5.0-preview.59–.66`、`agent-network@2.3.0-preview.77–.85`。

- **标准 MCP 客户端恢复工具清单**（#1763，hub `.46`）：修复 `tools/list` 抛 `schema._zod`，Claude Code 的 MCP 配置、Inspector 等能正常列出工具
- **`blocked` 有出口**（#1793，hub `.47`）：节点发出终态回复或派任务后自动回到 `idle`；hub 内部异常时 MCP 调用返回真正的错误信息（#1801）
- **grok 共存不再一条条超时**（#1774 / #1775 / #1776）：通过校验的 grok 可执行文件被钉住；`turn_ended` 缺失时有界等待后放弃该轮；人在 TUI 输入到一半离开 10 分钟后自动让路。停止后不再残留 5 个占位文件（#1784 / #1817）
- **共存节点不再重复回复**（#1770）：模型自己发给任务发起方的重复消息被改写成不推送的进度上报（需 anet `.77` + agent-node `.62`，并重启节点）
- **CLI**：`anet node start` 拒绝对已在跑的节点起第二个会话（#1804）；优先使用与 anet 同装的 agent-node（#1813）；`anet node edit` 支持 `--runtime` / `--model`；`--force` / `--yes` 不再吃掉下一个参数；agent 可直接用 `attachments` 发文件（#1186）；Mac / Windows 可起 grok 共存节点（带隔离弱化提示）
- **名册信息更完整**：claude-code 节点上报遥测与 model（#1787 / #1799）；换手上报不再清空 version 与遥测（#1810）；codex 共存就绪探测按端口判定，秒级就绪（#1798）
- **派单误判修复**（#1805）：「让/请 X …」只在句首/行首才算派单，散文中提及他人不再生成幽灵任务

---

## agent-network 2.3.0-preview.76 升为 latest（2026-09-02）

`npm i -g @sleep2agi/agent-network` 默认获得 `2.3.0-preview.76`。包含截至 2026-09-02 的全部 CLI 改进，重点是本页下方 08-29 至 09-02 各条目中的报错、帮助与排版修复。

---

## agent-node 2.5.0-preview.58 升为 latest（2026-09-02）

`@sleep2agi/agent-node` 的 `latest` 指向 `2.5.0-preview.58`，带节点规则文件远程读写支持。`commhub-server` 的 `latest` 在本期未变动（仍为 `0.9.0-preview.30`），需要新 hub 能力请安装 `preview`。

---

## 节点规则文件远程读写 + CLI 文案大修——preview（2026-09-02）

三包配套发布：`commhub-server@0.9.0-preview.45`、`agent-node@2.5.0-preview.58`、`agent-network@2.3.0-preview.76`。

- **节点规则文件**（#1755）：桌面端可远程读写节点的 `CLAUDE.md` / `AGENTS.md`；hub 新增 `read_node_rules_file` / `write_node_rules_file` 等工具，节点只在自己的工作目录内读写，整条链路没有路径参数
- **did-you-mean 与子命令帮助**：敲错 `daemon` 等命令给出正确建议；`anet goal/token/batch/opencode/network/channel/session --help` 打印各自的帮助
- **节点找不到时给出相近名称**，按「没有节点 / 有相近的 / 没有相近的」分别说明
- **表格排版**：中文别名、长运行时名、多行任务文本不再把 `node ls` / `status` / `tasks` 打歪；`anet demo` 不再输出字面量颜色码
- **时间与诊断**：hub 时间戳显式标 UTC 并附相对时长；`anet doctor` 说清各项量的是什么，列出运行时 CLI 实际版本，0 个节点不再报错

---

## 建节点能力可见 + grok 共存体验——preview（2026-08-30）

`commhub-server@0.9.0-preview.43–.44`、`agent-node@2.5.0-preview.53–.57`、`agent-network@2.3.0-preview.68–.75`。

- **daemon 能否建节点一目了然**（#1545）：`anet daemon list` 以五种明确说法报告创建能力及其测量时间；hub 在派发 `create_node` 前按 daemon 自报能力拦截并给出原因（#1510 / #1511 / #1588）
- **`anet daemon restart <name>`**（#1601，anet `.74`）：一条命令重启 daemon；起不来时明确提示「它现在是停着的」及重试命令（#1616）
- **grok 共存**：`anet grok attach` 使用备用屏幕，断开后原样还原终端（#1514）；recovery TUI 退出时显示 grok 真实输出（#1518）；grok 1.0.5 等 leaderless 版本不再被恒报 `blocked`（#1609）
- **报错指向正确方向**：401 不再说成「连不上 hub」（#1581）；daemon 启动时提示「装了 grok 但不在 PATH」（#1586）；grok 找不到时区分未在 PATH / 不可执行 / 启动失败（#1582）；`anet_bin_source` 的修复命令可直接执行（#1521）
- **`anet status` 不再把卡住/出错显示成在干活**（#1577）；非 claude-agent-sdk 节点拒绝配置飞书通道（#1575）
- **`anet node stop`** 不再因残留的无监听 socket 路径误报失败（#1526）

---

## grok 共存修复、Windows 可用、桌面消息持久化——preview（2026-08-29）

`commhub-server@0.9.0-preview.39–.42`、`agent-node@2.5.0-preview.44–.52`、`agent-network@2.3.0-preview.60–.67`。

- **grok 共存 TUI**：斜杠命令被拦时即时提示（#1404）；干净的 `/model <id>` 由运行时代为执行（#1408）；attach 后不再黑屏（#1412）；换模型不再使节点崩溃（#1416）
- **Windows 可用**（#1137 / #1489 / #1494 / #1504）：`anet` 能调起 npm/npx 等外部启动器，daemon 能在 Windows 上 fork 出节点且子节点不再因缺少 `HOME` 崩溃。需同时升级 anet `.66` 与 agent-node `.51` 以上
- **桌面消息不再丢**（#1481 / #1485 / #1488）：`send_desktop_message` 先持久化再推送，新增 `GET /api/messages?scope=user` 与 `POST /api/messages/ack`，带未读数并在回读时遮蔽 token 形状的字符串
- **无非回环 IPv4 的机器能起节点**（#1498 / #1506）：hub 接受 `host.ip = null`，节点对可选遥测字段的分歧改为降级重试
- **daemon 回归纯程序**（#1418）：自由文本任务不再调用大模型，只执行结构化生命周期命令；stop/start/delete 门铃支持 SSE 重连补偿（#1450）
- **安全**：删除节点时按真实工作目录清理，不再残留节点凭据（#1478；升级前在 cwd ≠ home 的机器上删过的节点请手工检查 `.anet/nodes/`）
- **CLI**：`anet node create --resume` 推断 `claude-code-cli`（#1420）；交互向导与带名路径共用环境检查（#1473）；`--copresence` 启动失败会指出失败步骤并给出日志路径（#1500）

---

## 可靠性冲刺：删除收敛 + 节点日志 + 超时防线——preview（2026-08-28 晚）

三包配套发布：`commhub-server@0.9.0-preview.36–.38`、`agent-node@2.5.0-preview.40–.43`、`agent-network@2.3.0-preview.54–.59`。

- **create_node 门铃补偿**（#1362，收编 #1364）：SSE 断连窗口内错过的 create_node 门铃不再永久丢失——daemon 重连后调用新 hub 工具 `list_my_pending_create_requests` 补偿派发（`.38`/`.43` 配对）

- **stop/delete 收敛**（#1286 三件套）：daemon 侧 ack 全链路留痕、hub 侧 `ack_stop_request` 六出口埋点、卡死的 deleting 记录可 `force` 重派（>5 分钟陈旧判据）
- **claude-code-cli 节点日志**（#1345）：stdio proxy 把日志双写进 `.anet/nodes/<alias>/logs/`（UTC 日期文件），该模式首次可按 alias 读节点日志；含 stop 竞态防护（节点目录被拆除后绝不复活）
- **callCommHub 超时**（#1357）：30s `AbortSignal.timeout`，hub 挂起不再静默吞掉 doorbell
- **daemon 能力可见性**：`runtimes_supported` 放开到 7 种（#1376）、创建失败原因四类错误码上报（#1377）、hub `lifecycle_controllable` 标志（#1374）配合桌面端按钮置灰（app#197/#200——三个 TUI 共存 runtime 进入建节点向导，零 key 跟随宿主登录）
- **agent 主动推送**：`send_desktop_message` 文档化（guide/channels）

---

## BTW 精确任务边界——Hub preview（2026-08-28）

`commhub-server@0.9.0-preview.34` 为任务记录增加可选的 `thread_id` / `turn_id`，并在 REST 与 MCP 任务投影中返回它们。Hub 只接受节点对已消费任务上报的、归属一致且不冲突的边界；旧节点和历史任务继续兼容，缺失时明确保持为空，不做猜测或回填。配套的 `agent-node@2.5.0-preview.39` 与 `agent-network@2.3.0-preview.53` 将在 Hub 发布后按依赖顺序跟进。

---

## Codex 共存 TUI 耐久化与安全停机——preview（2026-08-26）

本轮 preview 三包配对发布：`agent-network@2.3.0-preview.46` / `agent-node@2.5.0-preview.34` / `commhub-server@0.9.0-preview.30`。Hub 增加不可变节点游标和终态序列，丢失 SSE 门铃后可耐久补偿；任务投递返回经 network 权限校验的 `actual_to`。Codex 共存路径保留单 bridge、共享 `CODEX_HOME` 与 thread/history，`node stop` 会收敛受管的 app-server / bridge / TUI 资源。Linux 与受保护 Windows Codex 0.148 门禁覆盖升级恢复、活跃 turn steer 和历史保留。

---

## grok-tui liveness — Hub 不再把死 TUI 报成 idle（#1005）

`runtime=grok-build-cli` + `grokCopresence`：心跳 / 任务收尾的 `report_status("idle")` 现在走 liveness 快照。TUI 子进程不在、composer 未就绪、或缺少按名存在的 `attach.sock` / `leader.sock` 时，Hub 状态是 `blocked` 而不是 `idle`。composer 就绪后再报一次 `idle`。`anet grok attach` 的资格判断抽成 `resolveGrokAttachTarget`。

---

::: info 版本号体系说明
本日志按时间倒序排列，**版本号经历过一次重新规划**：
- **2026-05 起**：采用 v0.6 → v0.7 → v0.8 → v0.9 → v0.10 → v0.11 渐进发布，`v0.X.Y` 格式对齐 `commhub-server` 的 `0.X.Y` semver 风格
- **2026-04 之前**：曾使用 `v1.0.0-preview.N` / `v2.1` 等过度承诺型版本号，已废弃
- **当前 stable**：npm `latest` tag（按 [版本号体系](/guide/upgrade#channels) 查 npm latest 即为权威）；v0.8.1 是 Apache 2.0 OSS 首发版本
- **当前 preview**：以 npm `preview` dist-tag 为准。2026-08-18 实测 `agent-node@2.5.0-preview.31` 的 `--help` 已列出 `grok-build-cli` + `ANET_CAPABILITY_GROK_COPRESENCE_V2`，`anet@2.3.0-preview.39 grok` 打印 `Usage: anet grok attach <node>`。现在 `latest` 与 `preview` 都包含 `grok-build-cli` 与 `anet grok attach`（实验能力；默认推荐仍是 `grok-build-acp`），状态见 [Grok 节点](/guide/grok#copresence)。
- v0.9.2 及更早的条目（含 v1.0.0-preview / v2.1 / v0.x）见本页末尾的[更早的版本](#older)
:::

## Grok 人机共存 TUI（`grok-build-cli`）—— preview（2026-07-15）🟡 preview

::: danger 2026-07-31 更正
下文记录的是当时的候选里程碑。其中的安装与运行命令是当时的写法，请勿照抄；`grok-build-cli` / `anet grok attach` 后来已进入 npm 发布包（实验能力），现状与用法见 [Grok 节点](/guide/grok#copresence)。
:::

**版本同步**（npm `@preview` tag）：
- `@sleep2agi/agent-network@2.3.0-preview.23`
- `@sleep2agi/agent-node@2.5.0-preview.21`

> 说明：`preview.2`–`preview.22` 为增量迭代，详见 git 历史；本条记录**人机共存功能落地**这一里程碑。

### 🌟 Highlights

#### Grok 人机共存：attach 到 agent-node 持有的真实 Grok TUI

新 `grok-build-cli` runtime + `anet grok attach <alias>`：你和 CommHub 网络任务**共享同一段 Grok 会话**——网络任务实时渲染在终端、完成后把答复回传给发起者，你随时能一起看、一起打字。

```bash
anet node create grok-shared --runtime grok-build-cli
anet node start grok-shared        # 等日志：attach with anet grok attach grok-shared
anet grok attach grok-shared       # Terminal 2，真实 TTY、同机同用户同项目目录
```

限制：仅 Linux、需精确 `grok 0.2.93 (f00f96316d)`、固定 text-only `[todo_write]` profile（无 fs/shell/network/MCP 工具）、只连可信 Hub、**preview 非 latest/生产**。完整用法与 caveats 见 [Grok 人机共存 TUI](/guide/grok)。

---

## opencode-cli —— 第 5 个 Runtime（RFC-029）—— preview（2026-07-09）🟡 preview

新增 `opencode-cli` runtime：用公版 [sst/opencode](https://github.com/sst/opencode) CLI 当**多 vendor 前端**（统一 session / auth 抽象），是 anet 的第 5 个 runtime。**仅 preview 渠道（RFC-029 迭代中）—— npm `latest` 尚未包含**：装 latest 后 `anet node create` 选单只有前 4 个正式 runtime（`claude-code-cli` / `claude-agent-sdk` / `codex-sdk` / `grok-build-acp`），稳定后再进 latest。

### 🌟 Highlights

- **`anet node create --runtime opencode-cli`**（preview 渠道）：`anet node create` 交互式向导升级为 **5-way picker**（新增 opencode-cli 一项；npm `latest` 仍是 4-way）。
- **vendor preset**：选完 runtime 后选 `anthropic`（读 `ANTHROPIC_API_KEY`）或 `openai`（读 `OPENAI_API_KEY`）preset —— key 从 env 读、不 prompt。
- **父进程中介模型**：与 `codex-sdk` 同款 —— opencode 作为纯 LLM 工作器跑任务，commhub 的 SSE / inbox / reply 由 agent-node 父进程承担（opencode 侧不挂 commhub MCP server）。
- **版本 pin**：spawn 本机 `opencode` 命令，固定 `opencode-ai` 版本 pin（首次 `anet node create` 会提示 `npm i -g opencode-ai@<pin>`）；free-model keyless 全链路已 e2e 验通（2026-07-09）。

用法与对照见 [节点 Runtime — 五种 Runtime 对比](/guide/runtimes)、设计见 [RFC-029](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-029-opencode-runtime-integration.md)。

---

## v0.11-preview2 — **`/loop` 全 runtime 通 + 安全批 + RFC-024 hub config-apply foundation**（2026-06-28）🟡 preview

**版本同步**（npm `@preview` tag, 三包齐发）：
- `@sleep2agi/agent-network@2.3.0-preview.1` ← bumped (CLI: 加 `anet node loop` 子命令)
- `@sleep2agi/agent-node@2.5.0-preview.1` ← bumped (runtime: /loop 全 runtime 通)
- `@sleep2agi/commhub-server@0.9.0-preview.1` ← bumped (hub: 安全批 + RFC-024 PR A)

`PINNED_SERVER_VERSION` 同步到 `0.9.0-preview.1`，`anet hub start` 自动 lazy-fetch 匹配 hub 二进制。

### 🌟 Highlights

#### `/loop` 现在所有 runtime 都能跑

preview2 之前 `/loop` 自调度只在 `claude-code-cli` runtime 工作；agent-node 驱动的 runtime（`claude-agent-sdk` / `codex-sdk` / `grok-build-acp`）会**静默跳过** goal tick。preview2 拿掉那个 runtime-bucket skip，每个 runtime 都能把 `/loop` 任务端到端跑完。

加：**新 `anet node loop` CLI**，从节点外管理 goals — set / list / cancel 一个节点正在跑的 `/loop` jobs，不用进交互 session。

```bash
anet node loop my-codex "监控 PR #271 进展" --every 5m
anet node loop researcher "扫一遍 twitter 上 grok 的最新进展" --every 30m
anet node loop daily-bot "发布今日早报" --every 2h
```

完整用法 + 触发机制见 [Agent Node — 循环任务](/guide/agent-node#循环任务-loop-调度器)（ZH + EN parity）。

### 🔒 安全批

公网 hub 多用户 / 多 network 部署的 4 个 cross-tenant / data-integrity gap 修了：

- **cross-tenant 写防护带**（[#287](https://github.com/sleep2agi/agent-network/issues/287)，RFC-024 PR A）：4 个新 MCP tool（`update_node_config` / `get_config_update` / `ack_config_update` / `restart_node`）每个写操作都 gate `node.network_id == caller.effectiveNetId`，对齐 [#275](https://github.com/sleep2agi/agent-network/issues/275) 模式。`report_status` upsert 不再让节点 row 跨 network 漂移。SQL 层信任根用 `upsertNodeWithSec1Guard` helper 保护 + 5 个 real-driver regression + 6 个 inline-mirror 回归
- **`retention sweep` + incremental VACUUM**（[#282](https://github.com/sleep2agi/agent-network/issues/282)）：hub 后台周期性 sweep 旧 task / inbox row，`agent_telemetry` index 拆开防 READ write-amp。多租户部署 CPU 更稳
- **read-path stale-marker 修**（[#283](https://github.com/sleep2agi/agent-network/issues/283)）：sessions stale-mark 从 read path 挪到单一后台 sweeper，`/api/status` 不再 write-amp
- **password KDF 强化**（[#285](https://github.com/sleep2agi/agent-network/issues/285)）：scrypt 参数升 verified-modern, 向后兼容（老 hash 仍可 verify, 新 hash 用强参数）

### Engineering hardening

- **`superviseChild()` 共用 helper**（[#284](https://github.com/sleep2agi/agent-network/issues/284)）：`connectFeishu` + `connectSSE` 的 supervisor 逻辑（while-loop 重生 + jittered backoff + stable-uptime reset + shutdown gate + abandon-after-timeout）抽到一个 helper。同期加 2 个 connectSSE 改进：±25% jitter 防 hub 重启 thundering-herd / backoff 不在裸 HTTP 200 重置 (只认 SSE `"connected"` 事件)，修热 ~1s 重连循环
- **RFC-024 hub config-apply foundation**（[#287](https://github.com/sleep2agi/agent-network/issues/287)）：4 MCP tool + schema (`nodes.config_revision` / `nodes.config_snapshot` / `node_config_updates` table) 在 preview2 落地。Dashboard 改配置真生效是消费侧 (PR B + PR C)，跟在 preview2.x / preview3 后续 land

### 不在 preview2 里

- RFC-024 PR B（agent-node config-apply runtime + W1 supervisor）— 独立 [PR #290](https://github.com/sleep2agi/agent-network/pull/290)，依赖 PR A (在 preview2 里)。排 preview2.x / preview3
- Dashboard 改配置真生效 end-to-end — PR C 是 sleep2agi/agent-network-dashboard 里 1 行 const swap，PR B merge 后跟进

### 安装 / 升级

**Clean install (新用户)**：
```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.1
npm install -g @sleep2agi/agent-node@2.5.0-preview.1
npm install -g @sleep2agi/commhub-server@0.9.0-preview.1
```

**升级 (现有用户跟 preview channel)**：
```bash
anet upgrade --channel preview
```

升级后重启正在跑的节点接新版：
```bash
anet node stop <alias>
anet node start <alias>
```

详细 upgrade 流程 + 跨版本迁移 → [升级指南](/guide/upgrade)。

---

## v0.10.15 — **Wave 2 CLI UX 收尾（9 项）**（2026-06-10）✅ stable

**版本同步**（npm `latest` tag）：纯 CLI 包升级，无 agent-node / commhub-server 变更、无 PINNED bump、无需重启 hub/runtime。
- `@sleep2agi/agent-network@2.2.12` ← bumped（from 2.2.11）
- `@sleep2agi/agent-node@2.4.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.5` ← unchanged（PINNED）

### 🌟 Highlights

#### `anet hub status` 可信化（P1.1 / #214 F7-04）

容器环境（node:24-slim、alpine 等）缺 `lsof` 时旧版会谎报 "Hub not running"（即便 `/health` 返回 200），且 busybox `lsof` 会把流式 fd 编号当 PID、渲染成 60+ 项乱码。修复（commit `d33bbfc`）：`/health` 作 ground truth，不再 false negative；PID 列表 sanity-filter，>5 时折叠成 "top-3 + count"；三态输出明确（healthy / port 被占但不健康 / 未运行，各带对应 hint）。

#### Did-you-mean 命令纠错（P1.2 / #214 F7-02/10/11）

Levenshtein 距离 ≤2 的 typo 自动建议，替代旧的 50 行 help dump。顶层 / `anet node` / `anet project` 三处 default 分支都接上：

```
$ anet creat
Unknown command "creat". Did you mean: anet create?
```

#### `anet node restart <alias>`（P1.3 / #173）

跟 `anet project restart` / `anet batch restart` 对称，单节点重启不用敲 stop + start 两条。

#### `-V` 与 `anet help` 别名（P1.4 / #192）

`-V`（大写，cargo/git/docker 惯例）等价 `-v` / `--version`；`anet help`（无 dash）等价 `--help` / `-h`。

### 🐛 Bugs Fixed

- **#214** hub status PID 列表破损（容器 lsof 流式 fd 编号污染）
- **#214** hub status 谎报 not running（`/health` 200 但 lsof 不可用环境）
- **#214** 拼错命令无提示（F7-02/10/11）

### 📦 Install（全新安装）

```bash
npm i -g @sleep2agi/agent-network@latest
anet --version          # agent-network v2.2.12 ⬆
```

---

## v0.10.14 — **回执可靠性 / 派单去重 / idle 超时 / `--help` 安全 四件套**（2026-06-10）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-node@2.4.10` ← bumped（from 2.4.9）
- `@sleep2agi/commhub-server@0.8.5` ← bumped（from 0.8.4，PINNED 同步对齐）
- `@sleep2agi/agent-network@2.2.11` ← bumped（from 2.2.10）

### 🌟 Highlights

#### #168 回执可靠性（codex / claude / grok 全 runtime）

**症状**：节点按时把产物写到 `/tmp`，但完成回执从未到达 dispatcher，运营侧只看到 "idle / no output"，得手动 `ls /tmp` 才找到产物。根因在共享的 `agent-node` callCommHub + sendReply + processInbox 链，非 runtime-specific。修复（commit `5b61d1c`）：新增 `reply-reliability.ts`（`CommHubError` typed class + `classifyCommHubResponse` 分类器 success/retryable/appLevel + `PendingReplyQueue` 磁盘持久化幂等队列，跨重启保留 attempts）；`processInbox` 改为 drain-pending → inflight guard → process → persist + send + clear-on-success → ack。新增 20 test cases（bun test 111 pass / 0 fail，0 schema 改动）。服务端配套（#216）：`send_reply` 三分语义 —— `not_found` 不入库 / `offline` 入库显式 `queued` / 结构化错误，修掉之前 false-positive `ok:true` 的误报。

#### #212 派单去重（commhub-server guardrail）

server-side dedup per `(from, to, content-hash)`，默认 5min 窗口，in-memory 零 schema 改动（commit `1f3ae1e`）。agent 自己 retry / 用户误触发重复 prompt 时，同窗口内只过一次。窗口可用 `COMMHUB_SEND_DEDUP_WINDOW_MS` 调。

#### idle 超时 + `--help` 安全

四件套的其余两件：节点 idle 超时处理，与 `--help` 输出的安全收敛。

### 📦 Install（全新安装）

```bash
npm i -g @sleep2agi/agent-network@latest @sleep2agi/agent-node@latest
anet --version          # agent-network v2.2.11 ⬆
agent-node --version    # agent-node v2.4.10 ⬆
```

---

## v0.10.13 — **grok-build-acp `session/prompt` 300s timeout 卡死修复（P0 hotfix）**（2026-06-08）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-node@2.4.9` ← bumped（[#210](https://github.com/sleep2agi/agent-network/issues/210) / #204 runtime — ACP `handleServerRequest` 非整数错误码 coerce 修复）
- `@sleep2agi/agent-network@2.2.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.4` ← unchanged（PINNED）

### 🌟 Highlights

#### `grok-build-acp` 节点 hang 至 `session/prompt timed out after 300000ms` 根因 + 修复

**症状**：`grok-build-acp` runtime 节点接到第二个 task 后 hang ≈5 min，最终 agent-node 报 `grok ACP request 'session/prompt' timed out after 300000ms` —— ai-insight 用户的一个 Grok 节点（grok 0.2.29 alpha）2026-06-07 19:53:09 抓到的精确日志：

```text
ERROR failed to parse incoming message: invalid type: string 'ENOENT',
expected i32 at line 1 column 48.
Raw: {'jsonrpc':'2.0','id':5,
      'error':{'code':'ENOENT',
               'message':'ENOENT: no such file or directory, open ...'}}
```

**根因**：ACP server-request 响应（比如 `read_file` 失败）携带 JS-native 字符串错误码 `'ENOENT'`，但 Grok agent 端 protocol 要求 `code` 字段必须 i32 整数。旧 agent-node 直传 → Grok agent 解析失败 → 进入未定义状态 → hang 直到 client-side 300 s 超时。

**修复**（commit [`4818776`](https://github.com/sleep2agi/agent-network/commit/4818776)）：`client.ts:handleServerRequest` 加 `Number.isInteger(rawCode)` 守卫。非整数 code → coerce 成 `-32000`（JSON-RPC 标准 reserved range），原 code 字符串保留到 `data.originalCode` 不丢信息。

**新增回归测试**：+2 cases，bun test 89/89 pass。

**实战验证**（维护者本机，2026-06-07 19:50–19:55）：
- 同型 `read_file` 失败重试：立返结构化 `code: -32000` + `data.originalCode: "ENOENT"`
- grok turn 继续不 hang，任务正常 done/failed（47 s 完成，不到 300 s 超时门）
- ai-insight 用户的 Grok 节点全局装 `2.4.9-preview.0` 后 UAT 通过

### 🐛 Bugs Fixed

- [#210](https://github.com/sleep2agi/agent-network/issues/210) / #204 runtime — `grok-build-acp` ACP server-request 响应携带非整数错误码（如 `ENOENT`）致 Grok agent 解析失败 hang 至 300 s timeout

### 📦 Install（全新安装）

```bash
npm i -g @sleep2agi/agent-network@latest @sleep2agi/agent-node@latest
# 验证版本
anet --version          # agent-network v2.2.10（未变）
agent-node --version    # agent-node v2.4.9 ⬆
```

`anet hub start` 自动拉取 `commhub-server@0.8.4`（PINNED, 未变）。

### 🔄 Upgrade（老用户升级）

**最窄路径**（推荐 — 仅此 hotfix 必需）：

```bash
npm i -g @sleep2agi/agent-node@2.4.9
# 重启所有 grok-build-acp 节点
cd <your-anet-workdir>
anet node stop <grok-node-alias> && anet node start <grok-node-alias>
```

**全包升级**（一并刷 README / metadata）：

```bash
anet upgrade
```

⚠️ Node 版本：agent-node 兼容 Node ≥ 18；本 hotfix 在 Node 20.20 / 24.16 双跑 Docker smoke 通过。

详细排错入口见 [troubleshooting → grok-build-acp 节点任务挂死](/troubleshooting#grok-build-acp-节点任务挂死-session-prompt-timed-out-after-300000ms-json-rpc-error-32603)。

### 🙏 Credits

bug 复现 + root cause + UAT：本机活体抓 19:53:09 日志 + 一个用户 Grok 节点上的 47 s pilot；fix 实现：commit `4818776` + 2 回归测试；release ops：Method B 两阶段 + Install/Upgrade 分块 release notes。

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.12...v0.10.13>

---

## v0.10.12 — **Grok-build runtime 场景化能力 + 0.2.8 alpha 回归验证**（2026-05-30）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-node@2.4.8` ← bumped（场景化文档 + 0.2.8 alpha 回归基线 tag）
- `@sleep2agi/agent-network@2.2.10` ← unchanged
- `@sleep2agi/commhub-server@0.8.4` ← unchanged

### 主要内容

- **视频生成场景（0 改动可用）**：给 Grok 节点发送带图片 URL 的任务，后端自动路由到 `grok-imagine-video` 模型，产出 mp4。anet 端零代码改动，已用 ffmpeg 第一帧视觉验证。详见 [research/grok-video-gen-capability-probe.md](https://github.com/sleep2agi/agent-network/blob/main/docs/research/grok-video-gen-capability-probe.md)（含 Erratum）+ [scenarios/video-gen-marketing.md](https://github.com/sleep2agi/agent-network/blob/main/docs/scenarios/video-gen-marketing.md)。
- **基础 X 搜索（开箱即用）**：按 keyword / handle 找 X URL + 标题 + 摘要 —— LLM 自动用 `web_search` + `allowed_domains=["x.com"]` 命中，无需预置。
- **实时 X 高级搜索（需工作区预置）**：实时推流 + 帖子 faves/retweets/replies metadata + `since:` / `min_faves:` 高级语法 —— 需用户预置 twitterapi.io API key + fetcher 脚本，LLM 用 `run_terminal_command` 调。详见 [scenarios/x-search-informant.md](https://github.com/sleep2agi/agent-network/blob/main/docs/scenarios/x-search-informant.md)。
- **0.2.8 alpha 回归验证**：87/87 bun 单元测试通过，#201 委派识别 + #204 `.mcp.json` 隔离修复在 Grok 0.2.8 alpha 上确认无回归。详见 [tests/p-grok-028-regression-verify/report.md](https://github.com/sleep2agi/agent-network/blob/main/docs/tests/p-grok-028-regression-verify/report.md)。
- **RFC-021 §12 / §13**：ACP 能力档案补充 Path D（工作区预置 + 终端兜底）+ XSearch ACP 暴露实测（XSearch 后端工具在 0.1.219 → 0.2.12 alpha 一致不通过 ACP 暴露，属结构性，长期解在 xAI 上游 PR #1302）。

### 📦 Install / 🔄 Upgrade

升级无破坏性，0.2.8 alpha 回归已过，可安全升级：

```bash
anet upgrade
```

或手动单包：`npm i -g @sleep2agi/agent-node@2.4.8`

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.11...v0.10.12>

---

## v0.10.11 — **#204 grok-build-acp 节点身份隔离 + #194 commhub broadcast 归属 hotfix**（2026-05-28）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.10` ← bumped（`anet hub stop` / `anet hub status` 子命令 [#200](https://github.com/sleep2agi/agent-network/issues/200) + `anet hub start` stderr inherit [#199](https://github.com/sleep2agi/agent-network/issues/199) 静默挂修 + PINNED commhub-server `0.8.3` → `0.8.4`）
- `@sleep2agi/agent-node@2.4.7` ← bumped（[#204](https://github.com/sleep2agi/agent-network/issues/204) grok-build-acp per-node `.anet/nodes/<alias>/runtime-cwd/` 隔离 + [#201](https://github.com/sleep2agi/agent-network/issues/201) Grok delegate parser 3-layer broaden）
- `@sleep2agi/commhub-server@0.8.4` ← bumped（[#194](https://github.com/sleep2agi/agent-network/issues/194) broadcast `channel_meta_json` sender 归属 hotfix —— `from_session` 注入不再覆盖真实 LLM agent alias）
- `@sleep2agi/agent-network-dashboard@0.5.6` ← unchanged

### 🌟 Highlights

#### [#204](https://github.com/sleep2agi/agent-network/issues/204) — grok-build-acp per-node isolated cwd

**问题**：`grok-build-acp` runtime 节点共享 `.mcp.json` 发现路径，导致 stale `.mcp.json` identity pollution —— 一个节点的工作目录里如果存在旧的 `.mcp.json`，新启的 grok 节点会被误认成那个旧节点的身份。

**修复**：每个节点 fork 独立 cwd（`.anet/nodes/<alias>/runtime-cwd/`），与发现路径解耦，彻底解决 stale `.mcp.json` 干扰。

**E2E 验证**：在真节点跑通跨节点 dispatch —— channel sender attribution 正确归属到发送节点 alias，证实 LLM 层 attribution 链路无污染。

#### [#194](https://github.com/sleep2agi/agent-network/issues/194) — commhub broadcast 发送者归属 hotfix

**问题**：跨节点 broadcast 时 `channel_meta_json` 的 sender 字段经过 `from_session` 注入路径，导致 real LLM agent 名字被覆盖。

**修复**：commhub-server `0.8.4` 修正 from-name 注入逻辑，保留真实 sender alias。

### 🐛 Bugs Fixed

- [#199](https://github.com/sleep2agi/agent-network/issues/199) — `anet hub start` 静默挂修：`spawn` 的 `stdio` 从 `"pipe"` 改为 `"inherit"`，commhub-server bunx fetch 失败时立即可见错误
- [#200](https://github.com/sleep2agi/agent-network/issues/200) — `anet hub stop` / `anet hub status` 子命令补全：之前用户需手动 `lsof + kill`；现在 `anet hub stop [--port <p>]`（SIGTERM → 3s grace → SIGKILL）+ `anet hub status`（PID + port + `/health` version）
- [#201](https://github.com/sleep2agi/agent-network/issues/201) — Grok runtime 拒绝 delegate：explicit delegation parser 3-layer wrapper broaden + prompt softening 全 case 覆盖

### 📦 Install（全新安装）

```bash
npm i -g @sleep2agi/agent-network@latest
# 验证版本
anet -v  # 应显示 v2.2.10
```

`anet hub start` 会自动拉取 `commhub-server@0.8.4` (PINNED) + 首次 node 启动会自动拉取 `agent-node@2.4.7`。

### 🔄 Upgrade（老用户升级）

```bash
anet upgrade
# 或手动
npm i -g @sleep2agi/agent-network@latest
```

`anet upgrade` 会同步 agent-network + agent-node + commhub-server 到最新 latest 版。

### 🙏 Credits

Shipped by 团队 Agent Network — 设计 + lead review / agent-node `#204` fix / agent-network release ops + `commhub-server` promote / 测试 + 文档 全程协作完成. 个人贡献明细见 [v0.10.11 GitHub release page](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.11). LLM E2E attribution 由真节点跨 hub dispatch 验证.

**Full Changelog**: <https://github.com/sleep2agi/agent-network/compare/v0.10.10...v0.10.11>

---

## v0.10.10 — **小米 MiMo 5 模型完整支持 + envRef wizard-to-start 自动衔接**（2026-05-27）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.9` ← bumped（envRef Option A 自动 source + `anet -v` 显示完整 prerelease 后缀 + Grok delegation parser broaden）
- `@sleep2agi/agent-node@2.4.6` ← bumped（envRef Option A 实施 + Grok 节点延续 stabilization）
- `@sleep2agi/commhub-server@0.8.3` ← unchanged
- `@sleep2agi/agent-network-dashboard` ← unchanged

### P0 — 小米 MiMo Vendor Preset 完整

- 新增 `mimo-v2.5-tts-voicedesign`，凑齐官方 5 个模型
- `anet node create` 选 `claude-agent-sdk` runtime → 「小米 MiMo」vendor → 5 模型任选：`mimo-v2.5-pro`（默认）/ `mimo-v2.5` / `mimo-v2-pro` / `mimo-v2-omni` / `mimo-v2.5-tts-voicedesign`
- endpoint `https://token-plan-cn.xiaomimimo.com/anthropic` 完整对接 Anthropic Messages 协议
- 📌 注：`voicedesign` 是 TTS 语音设计模型，Anthropic Messages 文本请求 vendor 大概率不支持；文本对话请用前 4 个模型

### P0 — envRef wizard-to-start 自动衔接（[#193](https://github.com/sleep2agi/agent-network/issues/193)）

**痛点**：`anet node create` 完后同 shell 立即 `anet node start` 报 FATAL `env var not set`，必须手动 `export ANTHROPIC_AUTH_TOKEN_N_<id>=...`。

**现在的行为**：

- wizard create 时 API key 自动写入 `.anet/nodes/<alias>/.env`（mode 0600，自动加入 `.anet/.gitignore`）
- `anet node start` 启动前自动 source 该 `.env`，无需手动 export
- 跨机部署仍支持（wizard 仍 print 一次 export 命令，可手动 copy 到另一台机）
- Debug 日志只输出 `loaded N key(s) from .anet/nodes/<alias>/.env`，**不 echo key 值**
- 向后兼容：已有 `ANTHROPIC_AUTH_TOKEN_N_*` shell export 继续 work；老节点 plain `config.json` 模式继续 work

适用所有 `claude-agent-sdk` 类型节点（MiMo / MiniMax / 书生 / GLM / 任意 Anthropic Messages 兼容 vendor）。

### Bug fixes

- **[#192](https://github.com/sleep2agi/agent-network/issues/192)** `anet -v` 不显示完整 prerelease 后缀已修，现显示 `v2.2.9` 完整版本号（含 `-preview.N` 后缀 when applicable）
- **[#189](https://github.com/sleep2agi/agent-network/issues/189) Grok runtime** `grok-build-acp` 全面稳定化：explicit delegation parser broaden 覆盖含「你和 X 沟通一下…」「send_task X 一下…」等无标点尾随 body 句式，跨节点 delegation 路由可靠

### Known Issues

`agent-network` 内部 `npx` fallback 仍 pin `@sleep2agi/agent-node@preview` 标签 —— 未来 preview 推进可能让 latest 用户拉到不稳版本。本 release 不存在 regression（preview 2.4.6-preview.2 内容接近 latest 2.4.6），但需后续 RFC 处理（follow-up tracking 待 issue 开；**与同号 [RFC-021 ACP capability profile expansion](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-021-acp-capability-profile-expansion.md) 为 X-search unlock 主题不同**）。

---

## v0.10.9 — **Dashboard 图片发送 + CommHub 附件元数据 + codex-sdk 图片输入**（2026-05-25）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.7` ← bumped（PINNED server 切到 `@sleep2agi/commhub-server@0.8.3`）
- `@sleep2agi/agent-node@2.4.3` ← bumped（codex-sdk runtime 读取结构化图片附件）
- `@sleep2agi/commhub-server@0.8.3` ← bumped（`meta_json` 持久化 + MCP/REST 附件元数据）
- `@sleep2agi/agent-network-dashboard@0.5.4` ← bumped（TaskChatPanel 图片上传/粘贴发送）

### P0 — Dashboard 指挥链路支持发送图片

Vincent catch：Dashboard 聊天里已经能上传/预览图片，但任务发送到 agent 后只剩文字路径，codex-sdk runtime 没有拿到图片输入。结果是移动端/网页指挥时无法把截图、设计稿、报错图直接交给团队处理。

**Implementation**：
- Dashboard `TaskChatPanel` 上传/粘贴图片后发送结构化 `attachments`，同时保留文本中的本地路径和预览 URL 作为兼容 fallback。
- Hub `send_task` / REST `/api/task` 接收 `meta.attachments`，写入 `inbox.meta_json` 与 `tasks.meta_json`；`get_inbox` 返回解析后的 `meta`。
- agent-node 从 `meta.attachments` 中抽取本机可读图片路径，传给 codex-sdk/studio 的 image input。
- 修复 Telegram 图片通道参数顺序，避免 channel image 参数被误放到 `contextFrom`。

### Rollout + Smoke

- 本机 CommHub 已升级并重启到 `0.8.3` 源码状态。
- Dashboard 已升级并重启，图片发送链路走结构化附件。
- 27 个 host codex-sdk agent-node 进程已按新版代码滚动重启。
- P0 smoke：向 `test-node` 发送 `/tmp/anet-image-smoke.png`，节点日志显示 `+1 image(s)` / `→ processing [codex] +1 image(s)`，回执 `图片通道OK`。

### Known Limits

- Dashboard 上传的图片当前以同机文件路径交给 hub/agent，最适合 hub 与 agent 共享本机文件系统的部署；跨机器对象存储分发留后续版本。
- 已运行的旧容器镜像不会自动获得本次代码，需要重新安装/重启到 latest。
- 本 release 解决“图片能送到 agent runtime”；图片消息的富媒体历史展示、移动端 IM 化体验仍留在 dashboard 后续 issue 中推进。

详见 [v0.10.9 tag](https://github.com/sleep2agi/agent-network/tree/v0.10.9)。

---

## v0.10.8 — **Dashboard Servers 面板 UI 文案修 + TopoGraph density tier polish**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.6` *(无变化，v0.10.7)*
- `@sleep2agi/agent-node@2.4.2` *(无变化)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.3` ← bumped（UI copy + Playwright attrs + polish fold-in）

### Fix — [#157](https://github.com/sleep2agi/agent-network/issues/157) Dashboard Servers 面板 UI 文案修正（Root cause #1）

Vincent 实测 catch（附 dashboard 截图）：Servers 面板对每台 hub 显示 `agent rollup pending hub ≥ 0.8.2-preview` / `disk metric pending hub ≥ 0.8.2-preview`，但生产 hub 已经全部 ≥ 0.8.2，**文案过时且误导**，让 Vincent 一度以为版本控制台数据完全错误。

**Root cause #1（本 patch）**：ServersDrawer UI 早期为 0.8.2 升级 window 而埋的占位文字。0.8.2 早已上线，但占位文字未删，对 ≥ 0.8.2 hub 仍显示 "pending"，误导用户认为 hub 数据缺失。

**Implementation**（`app/components/ServersDrawer.tsx`）：

```diff
- <div ...>agent rollup pending hub ≥ 0.8.2-preview</div>
- <div ...>disk metric pending hub ≥ 0.8.2-preview</div>
+ <div ... data-server-agents-missing="true">agent rollup not reported by hub</div>
+ <div ... data-server-disk-missing="true">disk metric not reported by hub</div>
```

文案精准反映"该 hub 此刻未上报"语义，不再 imply 版本不够。新增 `data-server-agents-missing` / `data-server-disk-missing` Playwright 钩子供下一轮 e2e 验证 hub-side telemetry coverage。

::: info Root cause #2 + #3 已定位但 defer
- **#2**（v0.10.9 候选）：同 hostname 多实例时 dedupe 缺失，可能 double-count 服务器 —— Dashboard 团队修复方案已就位，待 v0.10.9 ship
- **#3**（v0.11.0 候选）：`status=offline` 与 telemetry 报告 mismatch（telemetry 仍上报但 SSE last_seen 超时）—— 系统级 status 协调
:::

### Polish fold-in — TopoGraph density tier（纯 additive）

Dashboard 团队 commit [`3f73810`](https://github.com/sleep2agi/agent-network-dashboard/commit/3f73810) （0.5.3-preview.16）—— Canvas state attr `data-topo-fleet-density-tier` ∈ `{empty, sparse, normal, dense, very-dense}` 暴露第 12 个 observable testing surface。Tier 边界（sparse 1-3 / normal 4-15 / dense 16-30 / very-dense 31+）跟 dense-layout collapse gate 对齐。**纯 additive，无 UX 改变**，配 numeric counts 提供 e2e selector 完整 canvas state snapshot 能力。

### Quality gates + lessons

- **Source-grep verify**：`grep -rh "not reported by hub"` 命中 + 旧文案只在 JSDoc 注释 ✅
- **Docker preview 实测**：`docker run --rm node:24-slim sh -c "npm install -g @sleep2agi/agent-network-dashboard@0.5.3-preview.15 && grep..."` ✅
- **JSX 文案 verify 走 source level**：在 `app/components/ServersDrawer.tsx` source 验，不依赖 `.next/server` bundled output
- **v0.10.x patch density 单日 8 patch** 验证 audit-first cadence 可持续

### 发布统计 — v0.10.8

- **18 累计 `@latest` publish**（v0.9.0 → v0.10.8）：0 split-brain / 0 rollback / 0 retry
- **2026-05-17 当日 v0.10.x**：v0.10.1-8 = **8 ships in ~11 hours**（audit-first cadence）
- Vincent catch + Vincent [#158 LOCKED directive](https://github.com/sleep2agi/agent-network/issues/158) 同 cycle 闭环

详见 [release v0.10.8](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.8)。

---

## v0.10.7 — **codex-sdk batch path yolo flags parity**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.6` ← bumped（codex-sdk batch path yolo parity）
- `@sleep2agi/agent-node@2.4.2` *(无变化)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(无变化)*

### Fix — [#156](https://github.com/sleep2agi/agent-network/issues/156) codex-sdk batch path yolo flags parity

Vincent catch："fast 也要开新一下默认 / codex 默认 fast 啊"。

**Pre-fix vs Post-fix matrix**：

| Path | Pre-fix | Post-fix |
|---|---|---|
| `anet node create --runtime codex-sdk` | ✅ 4/4 yolo flags（[#149](https://github.com/sleep2agi/agent-network/issues/149) v0.10.3 ship） | ✅ 4/4 yolo flags（不变）|
| `anet create --batch --runtime codex-sdk` | ❌ **仅 1/4**（`dangerouslySkipPermissions` baseline only） | ✅ 4/4 yolo flags（跟 single-node 对齐） |
| `anet [...] --runtime codex-sdk --no-yolo` | （无此 flag） | ✅ 1/4 baseline（opt-out for CI/scripted）|

**Implementation** — clean helper extraction at `bin/cli.ts:125-131`：

```ts
function codexSdkYoloFlags(noYolo?: boolean): Record<string, string | boolean> {
  if (noYolo) return {};
  return {
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
    skipGitRepoCheck: true,
  };
}
```

Source-of-truth helper：single-node path（`cli.ts:1146`）+ batch path（`cli.ts:6223`）都 call 同一个，**阻断 v0.10.6 1/4-vs-4/4 drift**。`dangerouslySkipPermissions: true` 是 baseline，在每个 call site 单独 set，1+3=4 yolo total。

### 用户影响

- **batch + codex-sdk 用户**：之前 batch wizard 出的 codex agents 在 tool approval popup / sandbox / git check 处 block，失去 yolo autonomous 状态 → 现在 4/4 flags 全 set，autonomous 行为跟 single-node 一致
- **single-node 用户**：不受影响（path 不变）
- **CI / scripted 用户**：新 `--no-yolo` flag 提供 explicit safe-mode opt-out
- **非 codex-sdk runtime**（claude / sdk）：完全不变（helper gated on `runtime === "codex-sdk"`）

### Quality gates + lessons

- **Source-grep verify**：`grep -n` 对 `bin/cli.ts` HEAD 5 sites 全 PASS（helper + 2 call sites + wiring + field）
- **Docker container smoke**：Cell A `anet login` setup failed（test infra blocker, not a fix bug）→ Gate 2 source-grep evidence accepted as substitute per v0.10.6 precedent
- **Docker smoke 用 curl 直调 API 拿 token**（本次新增）—— Docker smoke entry script 用 `curl` direct API call `/api/auth/register` + `/api/auth/login` 写 token，**不要** interactive `anet login`（在 non-TTY container 容易 stall，hub login 调用阻塞）

### 发布统计 — v0.10.7

- **17 累计 `@latest` publish**（v0.9.0 → v0.10.7）：0 split-brain / 0 rollback / 0 retry
- **2026-05-17 当日 v0.10.x**：v0.10.1-7 = **7 ships in ~10 hours**（audit-first cadence）
- **10 项用户反馈全闭环**：包括 v0.10.7 #156

详见 [release v0.10.7](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.7)。

---

## v0.10.6 — **`anet upgrade` Option B detached spawn + `anet create --batch` wizard silent-exit 修**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.5` ← bumped（CLI upgrade + wizard fixes）
- `@sleep2agi/agent-node@2.4.2` *(无变化，v0.10.3)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(无变化，v0.10.4)*

::: warning Chicken-and-egg 升级注 — 仅本次需手装 1 次
v0.10.4 的 [#151 Option A](https://github.com/sleep2agi/agent-network/issues/151) 只改了 verbiage（`anet upgrade` 显示 "⚠️ NEEDS MANUAL UPGRADE"），**chicken-and-egg deadlock 没解** —— 你的当前 `2.2.2 / 2.2.3 / 2.2.4` binary 跑 `anet upgrade` 还会沿用旧 "skipped (would replace running CLI)" 行为（这条 frozen 在 npm 上的老逻辑）。

```bash
npm install -g @sleep2agi/agent-network@2.2.5    # 只需一次手装
anet --version                                    # 期望 v2.2.5
```

之后再有新版本（e.g. 2.2.6+），直接跑 `anet upgrade` 就会**自动 detached spawn** 升级，不再手装。
:::

### Fixes

- **[#154](https://github.com/sleep2agi/agent-network/issues/154) `anet upgrade` Option B detached spawn 默认开启**（Vincent catch）：之前用户跑 `anet upgrade` 看到 `anet (self): skipped (would replace the running CLI).` + `[anet] Done.` 以为成功，实际 anet binary 没变（chicken-and-egg deadlock —— Node 进程无法 in-place 替换自己 binary）。`bin/cli.ts:3873-3874` 改成 `spawn(forkScript, [], { stdio: "inherit", detached: true })` + `child.unref()` + 主进程 `process.exit(0)`，detached child 后台跑 `npm install`。新版本一两分钟后生效，无需用户 `--self` flag。
- **[#155](https://github.com/sleep2agi/agent-network/issues/155) `anet create --batch` wizard silent-exit 修**（Vincent catch）：workdir mode `select()` 之后 `process.stdin` 状态变化，readline-based `ask()` helper 在 EOF 立即 return → 整个 wizard 在 `Node prefix` prompt **静默退出**（同 [#137 v0.9.2 preview.5 anet create regression](https://github.com/sleep2agi/agent-network/issues/137) 同根问题，不同代码路径再发）。Fix：post-select prompts 全 migrate 到 `inquirer.input()`，stdin handling 跟前面的 select 保持一致；catch fallback 保留 legacy `ask()` for non-TTY / 无 inquirer 环境。

### Quality gates + lessons

- **Docker smoke gate 永不跳过**（Vincent）—— v0.10.4 紧急 trust path **SUSPENDED**，Docker smoke gate 永不跳。
- **测试节点全在 Docker**（Vincent）—— 红线：测试节点全 Docker，不许 connect 本机 hub。
- **dist 是混淆 bundle、code verify 走 source**（本次新增）—— `dist/bin/cli.js` 是 esbuild bundled + obfuscated（rotating string-table, identifiers mangled, string literals encoded），静态 grep 对 dist 完全失效。Code-path verify 一律 grep `bin/cli.ts` source（HEAD = preview build source）。

### 发布统计 — v0.10.6

- **16 累计 `@latest` publish**（v0.9.0 → v0.10.6）：0 split-brain / 0 rollback / 0 retry
- **2026-05-17 当日 v0.10.x**: v0.10.1 + v0.10.2 + v0.10.3 + v0.10.4 + v0.10.5 + **v0.10.6** = **6 ships in ~9 hours**（audit-first cadence）
- **9 项用户反馈全闭环**：Install/Upgrade 文档分块 + #149 / #150 / #151 / #152 / #153 / #154 / #155 + 安全红线 SOP

详见 [release v0.10.6](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.6)。

---

## v0.10.5 — **`anet create --batch` wizard 双修**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.4` ← bumped（CLI wizard 修）
- `@sleep2agi/agent-node@2.4.2` *(无变化，v0.10.3 ship)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.2` *(无变化，v0.10.4 ship)*

### Fixes

- **[#152](https://github.com/sleep2agi/agent-network/issues/152) `anet create --batch` wizard 加 workdir mode 选择**（Vincent push）：`--workdir-mode <shared|separate>` flag 早就 ship（[#55](https://github.com/sleep2agi/agent-network/issues/55)）但 interactive wizard 从来没 prompt → 用户必须知道 flag 名才能改 default `separate`。`createBatchWizardCommand` 加 inquirer select（`separate` 默认 / `shared` 共 cwd），TTY-aware（flag set / non-TTY 都 fallback `separate` + INFO hint）。agent-node / server / dashboard 不动 —— 纯 CLI wizard UX。
- **[#153](https://github.com/sleep2agi/agent-network/issues/153) codex-sdk / claude-code-cli 选完不再误问 `ANTHROPIC_AUTH_TOKEN`**（Vincent push）：runtime-first wizard ([#133](https://github.com/sleep2agi/agent-network/issues/133)) 选 codex-sdk / claude-code-cli 时仍调 `selectVendorAndModel()` → 问 API key（只 claude-agent-sdk 需要）。Wizard 选 codex / claude-code-cli 后 skip API key prompt + print `codex auth login` / `claude auth login` 一行提示。

详见 [release v0.10.5](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.5)。

---

## v0.10.4 — **`anet upgrade` UX 警告 + Dashboard orphan-band 布局**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.3` ← bumped（[#151](https://github.com/sleep2agi/agent-network/issues/151) anet upgrade UX）
- `@sleep2agi/agent-network-dashboard@0.5.2` ← bumped（[#150](https://github.com/sleep2agi/agent-network/issues/150) orphan-band layout）
- `@sleep2agi/agent-node@2.4.2` *(无变化，v0.10.3 ship)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*

### Fixes

- **[#151](https://github.com/sleep2agi/agent-network/issues/151) `anet upgrade` self-skip 警告更明确**（Vincent push）：之前 `anet (self) — self-skip` 行没解释 why & how，用户照着 plan 跑完发现自己版本没升。现在加 explicit warning + 引导 `--self` flag。
- **[#150](https://github.com/sleep2agi/agent-network/issues/150) Dashboard 拓扑图 orphan 节点收到 "其他" cluster box**（Vincent push）：之前 orphan 节点（无 prefix 分组）散落画布各处难找；现在收到统一 "其他" cluster box 跟其他 group 一起渲染。

::: warning Vincent 紧急 trust path
v0.10.4 Vincent 紧急 ship 跳过 测试团队 Docker smoke gate（不在生产跑测试的规矩不豁免，但 Vincent lead-scope 决定 trust path）。Docker smoke 仍是 release-gate playbook 标准卡控点，不变。
:::

详见 [release v0.10.4](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.4)。

---

## v0.10.3 — **codex-sdk default model gpt-5.5 + yolo flags 可见**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.2` ← bumped（cli.ts vendor preset）
- `@sleep2agi/agent-node@2.4.2` ← bumped（codex-sdk runtime + flags）
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.1` *(无变化)*

### Fixes

- **[#149](https://github.com/sleep2agi/agent-network/issues/149) codex-sdk 默认模型修 + yolo flags 写进 config**（Vincent catch）：
  - cli.ts codex vendor preset 默认 model placeholder `gpt-5.4` → 真实 `gpt-5.5`
  - codex-sdk runtime 加 `yolo: true` flags（跟 Claude Code preset 的 `dangerouslySkipPermissions` + `teammateMode` 同概念）—— 跳过权限交互弹窗便于 multi-agent batch 跑
  - flags 写进 `config.json` 而非 ephemeral runtime arg，用户能 inspect / 编辑

详见 [release v0.10.3](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.3)。

---

## v0.10.2 — **Hero A disk telemetry + Hero D 拓扑图标签 UX**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.1` *(无变化，PINNED_SERVER_VERSION 仍 `0.8.2`)*
- `@sleep2agi/agent-node@2.4.1` ← `2.4.0`（Hero A disk telemetry additive，commit [`50d25b2`](https://github.com/sleep2agi/agent-network/commit/50d25b2)）
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.1` ← `0.5.0`（Hero D 拓扑图前缀标签 Option C + disk render + 100+ 轮 polish）

### Hero A — agent-node disk telemetry（[#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 Phase 2 host metrics 闭环 final 10%）

`agent-node/src/host-telemetry.ts` 新增 `readDiskStats()`（`execFileSync('df', ['-k', '/'])`，+33 lines）：

- **POSIX `-k`** 标准化 KB 输出，Linux + macOS 同一 parse 路径
- **不走 shell pipe**（per recent shell-audit safety review），`execFileSync` direct call
- Windows / 解析失败：**graceful null**（dashboard 渲染 `—` 不误导成 0）
- `HostTelemetry` interface 加 `disk_total_gb` / `disk_used_gb` / `disk_avail_gb`，`getHostTelemetry()` 通过 `toGb()` 同 mem/cpu 同 path 合成
- **Backward compat**：老 server 端 schema silent-drop unknown keys；agent / server 可独立升

接 [RFC-014](https://github.com/sleep2agi/agent-network/issues/99) — `/api/server/:host/health` 响应现在带 disk 三字段 + 24h 分桶 history 也含 `disk_avail_min` / `disk_used_max`；`alert_level` 加 `disk < 1GB critical / < 5GB warn` 触发（[`server/src/index.ts:253-258`](https://github.com/sleep2agi/agent-network/blob/22ed1886/server/src/index.ts#L253)，钉在当时的提交 `22ed1886`；该文件此后已被拆分，main 上只剩 16 行，所以这里不指向 main）。

测试团队 Docker Linux smoke 3/3 PASS（disk 299.8 GB total / 216 used / 71.5 avail，alert green，backward compat verified）。

### Hero D — Dashboard 拓扑图前缀标签 UX Option C（dashboard `0.5.1`）

[#147](https://github.com/sleep2agi/agent-network/issues/147)（5/16 ack）+ Option C 落地：

- 拓扑节点前缀标签（[节点 → group 边的 label distinguishability）实装 Option C 设计（Dashboard 团队 design pass）
- disk telemetry hover card 渲染（`disk_total_gb` / `disk_used_gb` / `disk_avail_gb` 三字段对接 [`GET /api/server/:host/health`](/api/rest-data#get-api-server-host-health) 响应）
- 100+ 轮 typography + corner-radius cascade polish

Dashboard 团队 design pass + 4/4 verify（commit `7de97ee` + screenshot evidence，local ship `f9c83cd`）。

### Closed issues

- [#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 Phase 2 close gate met（host metrics 闭环 final 10%，Hero A disk ship）
- [#147](https://github.com/sleep2agi/agent-network/issues/147) Hero D（5/16 ack 后 Option C 落地）

### RFC artifacts preserved（v0.12.0 scope）

本轮 v0.10.2 是 hotfix scope（不含 v0.11.0 系列 RFC ship），3 个 RFC artifact 保留进 v0.12.0 candidate：

- [RFC-013 v5](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-013-rename-hot-reload.md) rename hot-reload（third-pass review 整改完）
- [RFC-014 v2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-014-daemon-phase2.md) daemon Phase 2 host metrics（v0.10.2 Hero A 已 ship final 10%）
- [RFC-015 v2](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-015-token-usage-telemetry.md) #114 token usage UI（first-pass REVISION 完）

### Upgrade

```bash
anet upgrade                                     # 升 agent-node 2.4.0 → 2.4.1 + dashboard 0.5.0 → 0.5.1
anet project restart                             # 重启项目（拉新 agent-node + dashboard）
```

### Migration / Breaking

- **No breaking changes** —— disk 字段是 additive (`HostTelemetry` interface 扩 3 字段，server schema silent-drop unknown keys backward compat)；agent / server 可独立升级，老 agent 不带字段时 SQL `NULL` → dashboard 渲染 `—` 不误导

发布流程沿用 [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) 的两 phase publish SOP。

---

## v0.10.1 — **Hotfix: PINNED_SERVER_VERSION 跟 v0.10.0 ship chain-bump**（2026-05-17）✅ stable

**版本同步**（npm `latest` tag）：
- `@sleep2agi/agent-network@2.2.1`
- `@sleep2agi/agent-node@2.4.0` *(无变化)*
- `@sleep2agi/commhub-server@0.8.2` *(无变化)*
- `@sleep2agi/agent-network-dashboard@0.5.0` *(无变化)*

### Fix

[`agent-network/bin/cli.ts` 的 `PINNED_SERVER_VERSION`](https://github.com/sleep2agi/agent-network/blob/3a387204/agent-network/bin/cli.ts#L61)（钉在当时的提交 `3a387204`，第 61 行） 跨 v0.9.x + v0.10.0 promote 漏 bump，仍 hardcode `0.8.0` —— `anet hub start` 实际 `bunx --bun @sleep2agi/commhub-server@0.8.0` 启服务（[`cli.ts` 里 `anet hub start` 的 `bunx --bun @sleep2agi/commhub-server@…` 那处](https://github.com/sleep2agi/agent-network/blob/3a387204/agent-network/bin/cli.ts#L2589)（同一提交，第 2589 行）），跑的是老 server 不是 v0.10.0 ship 的 `0.8.2`。直接影响：

- [#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 endpoint family `GET /api/server/:host/health` + `GET /api/server/:host/agents` 在 0.8.0 不存在 → **404**
- [#142](https://github.com/sleep2agi/agent-network/issues/142) server schema align `process_telemetry` 字段在 0.8.0 没接 → 老 schema silent-drop 字段
- dashboard `0.5.0` §3.F server-health ring tint **数据源失败** / §3.E hover card `process_telemetry` 字段全 `null`

v0.10.0 announced functionality regression in **default-path `anet hub start`** workflow（手动 `bunx --bun @sleep2agi/commhub-server@latest` 不受影响）。

修复（commit [`4d24024`](https://github.com/sleep2agi/agent-network/commit/4d24024)）：

```diff
- const PINNED_SERVER_VERSION = "0.8.0";
+ const PINNED_SERVER_VERSION = "0.8.2";
```

### Upgrade

```bash
anet upgrade                                     # 升 agent-network 2.2.0 → 2.2.1
anet project restart                             # 重启项目（拉新 commhub-server）
```

或 fresh install：

```bash
npm install -g @sleep2agi/agent-network@latest
```

### Lessons

- **release-gate playbook 加 case** —— 每次 promote latest 时 `PINNED_*_VERSION`（server pin / dashboard pin / agent-node pin）必跟 chain-bump，否则默认路径仍跑老 ship。跟 [#80 PINNED bump SOP](https://github.com/sleep2agi/agent-network/issues/80) 一致但 Hero 4 release-gate playbook 当时漏覆盖；本 hotfix 后已加 case ([见 lesson memory](https://github.com/sleep2agi/agent-network/blob/main/docs/sop/methodology.md))。

发布流程沿用 [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) 的两 phase publish SOP。

---

## v0.10.0 — **Direct Runtime + Observability Foundations**（2026-05-16）✅ stable（Phase 1，3 包 promote）

**版本同步**（npm `latest` tag，Phase 1）：
- `@sleep2agi/agent-network@2.2.0`
- `@sleep2agi/agent-node@2.4.0`
- `@sleep2agi/commhub-server@0.8.2`
- `@sleep2agi/agent-network-dashboard@0.5.0` ✅ Phase 2 ship

::: tip 主题：治本
v0.7 → v0.9.2 累积 11 release、5 P0 chain（[#135-#139](https://github.com/sleep2agi/agent-network/issues/135)）暴露 runtime 架构债。v0.10.0 治本 —— runtime 架构债（codex-sdk wrapper bypass，opt-in）+ observability 基础（守护节点 endpoint + per-agent process telemetry）+ release-gate playbook。为 v0.11.0 多厂商 AI Agent 社会 24/7 直播打地基。详见 [v0.10.0 release tracker #140](https://github.com/sleep2agi/agent-network/issues/140)。
:::

### 5 features

**A. [#141](https://github.com/sleep2agi/agent-network/issues/141) codex app-server stdio direct（opt-in `ANET_CODEX_STDIO_DIRECT=1`）**
之前 codex runtime 走 `@openai/codex-sdk` npm wrapper，wrapper 的 `--mcp-config` HTTP transport bug 是 [#102](https://github.com/sleep2agi/agent-network/issues/102) hang root cause family。v0.10.0 新增直 `spawn('codex', ['app-server'])` + 最小 stdio JSON-RPC client (~155 LOC) 路径，**bypass wrapper 整个绕过这 family bug**，同时拿到完整 67-method v2 protocol surface（thread / turn / item / realtime 等），不再受 codex-sdk breaking change 牵制。**v0.10.0 默认仍是 wrapper 路径**（先收 preview 反馈），显式 `ANET_CODEX_STDIO_DIRECT=1` 开启直 stdio；v0.11.0 计划 default flip。

**B. [#99](https://github.com/sleep2agi/agent-network/issues/99) 守护节点 Phase 1 scaffold（监测 only）**
新增 server-side endpoint family（commit [`e575cc6`](https://github.com/sleep2agi/agent-network/commit/e575cc6)）：
- `GET /api/server/:host/health` — host CPU / mem / disk / process 健康
- `GET /api/server/:host/agents` — agent list per host + telemetry 历史

dashboard 集成留 Phase 2（[#119](https://github.com/sleep2agi/agent-network/issues/119) ServersDrawer 整合）。控制层（kill / restart / redeploy）defer 到 v0.11.0。

**C. [#142](https://github.com/sleep2agi/agent-network/issues/142) Per-agent process telemetry**
agent-node 每次 `commhub_report_status` 心跳带上 `process_telemetry`：`rss` / `cpu_pct` / `uptime_seconds` / `in_flight_count`。零 sysmon 依赖、零特权。commhub-server schema 端对齐（commit [`209cac7`](https://github.com/sleep2agi/agent-network/commit/209cac7)），dashboard 渲染 hover card Phase 2（[#119](https://github.com/sleep2agi/agent-network/issues/119) sibling）。跟 [#119](https://github.com/sleep2agi/agent-network/issues/119) host fields 是 sibling 关系（host step 1 ✅ 之前 ship，agent step 2 本 release ship）。

**D. Dashboard 网络节点前端展示升级（Hero 3 — 8/8 surface complete，dashboard `0.5.0`）**
- §3.A prefix-group fix（Vincent #1 catch）
- §3.B sweep retire（旧 sweep 路径并入 grid）
- §3.C recent-panel hide
- §3.D grid default view
- §3.E hover detail card
- §3.F server-health ring tint（接 #99 endpoint）
- §3.G fullscreen mode
- §3.I canvas brand mark
- *(§3.H 砍 per RFC Q2 review)*

随包附 **19+ 轮 typography + 圆角级联 polish**（4 typography family + corner radius cascade 系统化重整）。dashboard `0.5.0` 已通过 npm `latest` tag promote，跟随 v0.10.0 Phase 2 docs sync 落地。

**E. 发布前轻量级测试 playbook（release-gate Phase 1+2）**
[`docs/tests/release-gate-playbook.md`](https://github.com/sleep2agi/agent-network/blob/main/docs/tests/release-gate-playbook.md) — 测试团队 lead 维护，覆盖 hub / dashboard / login / node lifecycle / runtime smoke / vendor verify 等关键路径。本次 v0.10.0 ship 是首次完整跑通该 playbook 的 release，为后续每次 latest promote 卡 release-gate。

### Breaking changes / Migration

- **`codex` runtime 默认行为不变**：仍走 `@openai/codex-sdk` wrapper；要切直 stdio 必须显式 `ANET_CODEX_STDIO_DIRECT=1`。`ANET_CODEX_LEGACY_SDK=1` 之前 preview chain 的 fallback 命名在 latest 改成 opt-in `ANET_CODEX_STDIO_DIRECT=1` 反向开关，含义更直接。
- **agent-node `commhub_report_status` payload 加 `process_telemetry` 子对象**：commhub-server `0.8.2` schema 已对齐；老 server 版本（≤ `0.8.1`）会忽略未知字段不会 fail。
- **`/api/server/:host/health` + `/api/server/:host/agents` 是新 endpoint**：rate limit / auth 行为跟现有 `/api/servers` 同（admin or self-network member），不破坏现有 client。

### Known follow-ups

- ~~**Phase 2 dashboard `0.5.0` promote**~~ ✅ 已 ship（dashboard `0.5.0` 跟随 v0.10.0 Phase 2 docs sync 落地，8/8 Hero 3 surface complete + 19+ 轮 polish）
- **#102 / #103 hang 关闭凭证**（codex direct stdio 路径回归 #102 hang 场景 verify）—— preview chain 内 Phase 1.5 已规划，待 latest opt-in 路径回归 verify 完成关闭。
- **Sessions NETWORK 列显示 bug**（Vincent catch）—— defer 到 v0.10.x patch 或 v0.11.0。
- **#117 `anet project up` detached tmux follow-up**（macOS bun setRawMode 已 #136 修，但 detached 模式 follow-up 仍欠）—— v0.11.0 配套 control 层一起做。

发布流程沿用 [v0.9.0 split-brain lessons #126](https://github.com/sleep2agi/agent-network/issues/126) 的两 phase publish SOP：先 `--tag preview` 上传 tarball + curl verify HTTP 200，再 `npm dist-tag add @<v> latest`。Phase 1 三包（agent-network / agent-node / commhub-server）clean semver promote 完成；dashboard Phase 2 待 §3.D/F/G ship。

---

## 更早的版本 {#older}

v0.9.2（2026-05-16）及更早的条目和当时的路线图已移到仓库的 [changelog 存档](https://github.com/sleep2agi/agent-network/blob/main/docs/archive/changelog-pre-v0.10.zh.md)。

## 下一步

- [升级指南](/guide/upgrade) — v0.7 → v0.8 行为变化 + 标准步骤
- [架构概览](/guide/architecture) — 各版本是怎么累积成现在这套系统的
- [npm 版本列表](https://www.npmjs.com/package/@sleep2agi/agent-network?activeTab=versions) 与 [桌面端 releases](https://github.com/sleep2agi/agent-network-app/releases)
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — v0.8 ~ v1.0 master token 废弃路线图
