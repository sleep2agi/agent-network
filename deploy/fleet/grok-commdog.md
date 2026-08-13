# GrokTUI 狗节点恢复与渐进授权

本文记录 `通信狗`、`A站狗` 与 `P站狗` 的非密钥软件坐标、启动方式、行为验收、回滚和授权边界。
宿主机上的安装目录与 tmux 会话只是部署副本；Git 中的 source commit 与本文才是
恢复依据。本文不授权批量升级、生产数据库操作或其它舰团节点变更。

## 当前安全终态（2026-08-13 15:42 CST）

以下是本轮只读回查得到的**存活状态**，优先级高于后文按时间记录的历史基线：

| alias | Hub 状态 | 当前 session_id | tmux 状态 |
| --- | --- | --- | --- |
| `通信狗` | `offline` | `890fdcee-96d1-429e-991f-5bc09ad97722` | session `通信狗` 保留；`0:node` pane `%1107` 为 `dead=1`；无 live TUI window |
| `A站狗` | `idle` | `0bff8e47-ead8-4628-bea7-74b58335785a` | session `A站狗`；`0:node` + `1:tui`，均 `dead=0` |
| `P站狗` | `idle` | `f36fe2d9-166a-4b3e-b9c3-7ad065f60bc0` | session `P站狗`；`0:node` + `1:tui`，均 `dead=0` |

`通信狗` 是事故后的故意停机状态，必须等待已审修复发布并完成单节点 pilot；不得用后文旧
session、旧 pane 或旧 runtime 字节直接恢复。`A站狗`、`P站狗` 不在该 pilot 的变更范围内。

### 首轮已验软件坐标（历史证据，不是当前存活坐标）

三个节点曾使用相同的冻结软件制品，但每个节点拥有独立 workspace、node config、node/session
identity、tmux 和 Grok attach socket。下表保留首轮验收坐标用于审计；其中 `通信狗` 的 session
后来已被替换，不能作为当前启动参数：

| alias | node_id | session_id | workspace | tmux |
| --- | --- | --- | --- | --- |
| `通信狗` | `n_72be30e0` | `c47d3225-6d87-48a2-8c84-6c11db20a455` | `/home/vansin/grok-commdog-workspace` | `通信狗` |
| `A站狗` | `n_b2c53d33` | `0bff8e47-ead8-4628-bea7-74b58335785a` | `/home/vansin/grok-astation-dog-workspace` | `A站狗` |
| `P站狗` | `n_6fe8f9c0` | `f36fe2d9-166a-4b3e-b9c3-7ad065f60bc0` | `/home/vansin/grok-pstation-dog-workspace` | `P站狗` |

### Runtime 身份：TUI 共存，不是 ACP runtime

三个 config 的权威字段均为 `runtime="grok-build-cli"`、`grokCopresence=true`；它们不使用
Agent Network 的 `grok-build-acp` runtime，也不启动 `grok agent stdio`。实际进程链是
`agent-node → grok --leader → grok agent leader`，并通过 owner-only attach socket 把同一个
Grok TUI 暴露给 `anet grok attach`。`grok agent leader` 以及 Grok 日志中的内部 relay/ACP
事件名是 Grok CLI 的 TUI leader 实现细节，不能据此把节点误报成 `grok-build-acp`。

验真必须限定到目标 alias 的 config 与进程子树。不要用全舰队 `pgrep`/`grep` 搜索
`grok-build-acp`：宿主上其它历史节点会污染结果。最低核验形态为：

```bash
jq '{runtime, model, grokCopresence}' "$CONFIG_PATH"
pid="$(pgrep -af "agent-node.*--alias $ALIAS .*--runtime grok-build-cli" | awk 'NR==1{print $1}')"
test -n "$pid"
pstree -ap "$pid"
! pstree -ap "$pid" | grep -E 'grok-build-acp|grok agent stdio'
```

下面是三者共享的软件坐标；其中 alias、node/session、workspace 与 tmux 行仅是
`通信狗` 的首轮详细记录：

| 项 | 观测值 |
| --- | --- |
| alias | `通信狗` |
| runtime / model | `grok-build-cli` / `grok-4.5` |
| node / session | `n_72be30e0` / `c47d3225-6d87-48a2-8c84-6c11db20a455` |
| workspace | `/home/vansin/grok-commdog-workspace` |
| tmux | `通信狗` |
| source commit | `a7865a4316a17d38e4c8dfc4c2cebaceaba2c62c` |
| agent-network package | `2.3.0-preview.37`, tarball SHA-256 `56fdefbc14cba8de28f7bc037bc4d0911f7c79d16213152cc40167fa9ffe3743` |
| agent-node package | `2.5.0-preview.29`, tarball SHA-256 `6e4e434df475fa88b20557188d0f553116a92d7181b440d2c76a6eec377d844c` |
| installed anet CLI | SHA-256 `af3847dd1ddb75dd1265e995b1f2bd215df064e1b6c7e7aa823a1a96b270d7da` |
| installed agent-node CLI | SHA-256 `03e9bed6630530e8fb03420dba32c6e06a90ae8cbe3fcdf33541a047708a7bb4` |
| Grok CLI | `0.2.93`, binary SHA-256 `4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135` |

首次真实任务在 4 秒内完成，结果为：

```text
COMM_DOG_TURN_OK alias=通信狗 model=grok-4.5
CHECK=2+3=5
```

第二次任务复用了同一 session：节点正确还原上一轮 `CHECK=2+3=5`，运行日志出现真实
`tool_running` 阶段，并在 10 秒内返回官方页面 `https://x.ai/grok` 与 terminal reply。

这证明了该次节点注册、入站消费、连续 Grok turn、会话上下文、WebSearch 和 Hub 终态回执。
它不证明长期稳定性、heavy 会员的完整配额，也不授权生产写操作。

一次直接读取 GitHub PR 的试验触发了 `approval_boundary`：Grok 尝试
`run_terminal_command`，安全边界拒绝后 TUI 子进程退出，而 agent-node 一度仍显示 idle；
紧接着的无工具任务也失败。因此当前的阶段 1 能力只包括通用 WebSearch 和任务中直接提供的
审查材料，**不包括**任意 URL/PR 内容读取。不能把 Hub 的 idle 状态单独当成可用性证明。

该故障仅重启 `通信狗`，配置 SHA-256 保持不变、`grokCliSession` 仍为原值；重启后的
无工具行为探针在 2 秒内返回 `RECOVERED_AFTER_BOUNDARY session_preserved`。本次本地
owner-only 配置回滚点为
`/home/vansin/.commhub/rollback-commdog-boundary-20260813T014843Z/`。

随后又发现一个独立的“半恢复”形态：节点仍能从 Hub 接收入站任务，attach socket 与 TUI
也都存活，但恢复进程的 `PATH` 不包含 Bun。运行时生成的 CommHub MCP 配置使用
`command = "bun"`，因此 TUI 内搜索不到 `commhub_send_message` / `send_task`，而节点表面仍
显示在线或 idle。`grok mcp doctor commhub --json` 给出的决定性错误是 `command not found: bun`。

三个节点均已用包含固定 Bun 目录的 `PATH` 做单节点恢复，未使用 `--new-session`；配置哈希和
`grokCliSession` 保持不变。修复后每个节点从自己的 workspace 运行 MCP doctor，均得到
`healthy_count=1`、`failing_count=0`、`3 tools discovered`。`通信狗` 又从可见 TUI 真实调用
`commhub_send_message` 给 `通信龙`，Hub 落库的 message id 为
`16466c5f-7318-4126-bd4e-d211822a6831`。这证明的是 TUI 出站 CommHub 路径，不是仅靠进程或
静态配置推断。

本轮 owner-only 回滚坐标为：

- `/home/vansin/.commhub/rollback-commdog-mcp-path-20260813T021822Z/`
- `/home/vansin/.commhub/rollback-A站狗-mcp-path-20260813T022143Z/`
- `/home/vansin/.commhub/rollback-P站狗-mcp-path-20260813T022239Z/`

### 旧会话工具库存与 TUI 假健康事故

`通信狗` 后续执行 issue #811 的只读审查任务
`113210ae-54fb-46d3-925f-ad6091d9ee09` 时，旧 Grok session
`58df4026-95be-4610-a45c-194478727cc9` 仍带有历史工具库存。Grok 请求
`run_terminal_command` / `grep`，事件流出现
`permission_requested` 后立即 `permission_resolved decision=allow wait_ms=0`；Agent Network 以
`[grok_failure:approval_boundary]` 拒绝该 turn。随后 TUI/leader 子进程退出，但常驻
agent-node、Hub SSE 和 tmux `0:node` 仍在线。这再次证明“节点 online/idle”不能代替 TUI
进程、attach socket 和真行为探针。

Grok CLI 0.2.93 在恢复日志中明确警告：会话创建后工具库存固定，resume 不能应用已经变化的
工具 profile。保存旧 config、session 与进程坐标后，本次只对 `通信狗` 执行一次受控
`--new-session`，得到当时的新 session `c47d3225-6d87-48a2-8c84-6c11db20a455`；旧 session 保留为
事故证据。该 session 后来又被替换，不是当前运行坐标。owner-only 回滚点为
`/home/vansin/.commhub/rollback-commdog-tui-20260813T025425Z/`。

新 session 的最小 CommHub-only 行为验收任务
`ad2b376f-86ee-4bbf-b15f-d17d94c77ead` 在 7 秒内终态 `replied`。可见 TUI 只执行
`Commhub Send Message`，向 `通信龙` 落库 message id
`cd18fb21-51ce-4fde-bb79-30760749225f`，随后仍停在可交互提示符。该证据只放行
CommHub-only 协作；在新 session 的安全工具库存得到独立行为核验前，仍不得派发需要 shell、
文件系统或任意 PR/URL 读取的任务。

首个阶段 1 运维分析任务 `1f916e17-249e-4d1d-8b21-8ffa8703401e` 只向模型提供上述事件事实，
并明确禁止终端、文件与网页工具。它在 58 秒内终态 `replied`，正确把“CommHub 真发信且 TUI
事后仍存活”列为最强判活信号，把单独的 `0:node` 存活列为最弱信号；同时给出了普通故障与
固定工具库存不安全的分流、五步最小回滚/验收，以及未覆盖的根因和跨版本边界。TUI 完成后仍
停在可交互提示符。该结果证明它可在正文材料充分时参与受限运维分析，仍不证明 repo 读取或
生产执行能力。

随后任务 `c52fc921-61b9-49a0-8a01-35ab803df0de` 只允许 Grok 自带 WebSearch，检索 MCP
官方规范。它在 47 秒内终态 `replied`，TUI 显示只执行搜索并在完成后保持可交互。返回的
2025-11-25 lifecycle 与 tools 官方页面经独立回读确认：`initialize` 是首次交互，成功后 client
发送 `notifications/initialized`；`tools/list` 只负责发现，而 `tools/call` 才负责调用。该任务
证明当前新 session 的受限公开资料检索可用，不能外推成 WebFetch、任意 URL 读取或工具业务
调用已经验证。

在迭代评审任务 `f15552b3-5d97-4732-b01c-8e63a52819ee` 中，正文提供 #813 的真实关键
代码片段。`通信狗` 指出测试自行构造 doctor JSON 可能与生产 parser 形成自洽假绿，不能证明
Grok vendor doctor 兼容。随后 test813 增加了只读挂载的精确 Grok 0.2.93 keyless doctor 步骤；
新 exact-archive 运行由 vendor 原样返回 `command found`、`server started`、`handshake OK`、
`4 tools discovered`，再由生产 parser 验证通过。这是首条由 `通信狗` 的评审直接促成测试增强
并关闭证据缺口的记录；它仍是 prompt-contained advisory，不冒充独立源码审。

首个完整真实 PR delta 评审任务 `b79f3aa8-627a-42fb-a935-de4c2108c394` 使用 PR #798 的冻结
`source=2617987e75a6d5f3c0af3abc41709fad20176960`，把完整实现 diff 直接放进任务正文，并禁止
终端、文件与网页工具。`通信狗` 在 2 分 49 秒内终态 `replied`；任务后 tmux `通信狗` 的
`0:node` 与活动窗口 `1:tui` 均存活，Hub 为 idle、`in_flight=0`。它正确核出了逐文件 runner
的分母、mutation 命名红、串行独立 DB 与非 root/cwd 约束，同时把完整 workflow 旧 context
中不可见的 path 触发项列为待核。随后对 exact source 的独立 Git 对象核确认：69 个
`server/src/**/*.test.ts` 没有重复 basename；`pull_request` 与 `push` 两侧均已有 `server/**`
和 `agent-node/**`，本 PR 又补齐 `test798/**` 与 `test601/**`，所以 Dockerfile 的四类 COPY
输入全部被覆盖。前两项疑点因此分别是潜在结构风险与 prompt 边界下的 NOT COVERED，不是
当前实现缺陷。该记录证明它能参与有边界的真实 PR 审查，但最终裁定仍须由可读取 exact Git
对象的独立审查者作出。

第二个真实 PR delta 评审任务 `012ce584-cf36-4b48-8986-0f2fdb8c1b9d` 使用 PR #800 的
`source=1e9e75dab635dc03d12636232ebc2ac117c2dee6`，在 1 分 38 秒内终态 `replied`。它指出
两个 runner 的 `find ... -maxdepth 1` 不覆盖未来嵌套测试，因此 #800 单独不能保证整棵
`tests/` 永久完整；该角由依赖它的 #801 元门负责闭合，故合并顺序是证据的一部分。它还指出
`grep -q 'bun:test'` 是粗分类器。exact source 交叉核确认当前没有嵌套测试，现有 25 个文件也
全部正确分成 agent-node 六个脚本式，以及 agent-network 十六个脚本式和三个 `bun:test`；
现行 CI 两个 unit job 均绿。因此前者是当前真实的跨 PR 依赖，后者是未来脆弱性，不应冒充
当前误分缺陷。任务后 Hub 回到 idle、`in_flight=0`，tmux 的 node/TUI 两个 pane 仍存活。
这次结果同时暴露了 advisory 的边界：任务目标中“mutation 命名红收紧”被模型过度理解为
两侧都必须修改，而 PR 实际只在 test725 收紧该断言；最终回执必须用 PR body 和 exact source
纠正这种由任务措辞产生的过判。

运维设计审任务 `100c530e-e405-493b-828b-ac4672e33db3` 让 `通信狗` 判断 #813 的 Grok MCP
假健康修复是否应顺带吞入另外三处裸 `command="bun"` 生成点。它在 1 分 9 秒内终态
`replied`，正确区分了 Grok TUI 的 canonical Bun + vendor doctor 门、Claude `.mcp.json` 的落盘与
迁移语义、以及 Codex config 的进程继承边界；建议 #813 保持 Grok-only，另外三处按消费路径
各配真实 subprocess witnessed-red。exact source 只读核确认三个坐标均存在，随后已将分母、
nvm-only 生产观测、跨平台/旧配置边界与三套行为门固化到 issue
[#821](https://github.com/sleep2agi/agent-network/issues/821)。这是又一条从正文 advisory 形成持久
工程输入的证据；它仍不代替实现、Docker 门或独立源码终审。

在 #813 冻结实现进入 Draft PR
[#822](https://github.com/sleep2agi/agent-network/pull/822) 后，`通信狗` 又完成了两层相互独立的
验收。首先，prompt-contained 对抗审任务 `30a03669-81fe-4e83-9ba2-6626cc6cd111` 在 1 分 22 秒
内终态 `replied`；它正确区分了“Bun 无法解析时不假注册”与“doctor/工具面必须在 TUI ready
之前真实通过”，并建议用 doctor 假健康或少工具的反向 mutation 攻击产品链。冻结测试已有
`upload-tool-removed` 与 `stale-three-tool-doctor` 两条 witnessed-red，因此终审焦点被收窄为：
这些纯探针是否还需进一步绑到真实 `dist/cli → doctor → TUI spawn` 链，而不是重复字符串门。

其次，操作者在 tmux `通信狗` 的真实 `1:tui` 输入框中直接要求模型调用
`commhub_send_message`。TUI 搜索到 CommHub 工具并在 6.3 秒内向 `通信龙` 发送慰问，返回 Hub
message id `948b5add-0f49-41e2-9e4b-3721866b2ec5`，完成后仍停在可交互提示符。这个验收没有
经过 agent-node 的任务回执代发路径，直接证明当时 TUI 会话的出站 CommHub MCP 工具可见且
可调用，关闭了此前“入站任务正常、TUI 搜不到 CommHub 工具”的用户侧故障。它仍不代替
#822 的 exact-source Docker 证据、CI 或独立源码终审。

下一档真实舰团只读巡检任务 `fc7bdc50-7d5d-4786-960c-8bb0b6cffe24` 要求
`commhub_get_all_status` 只核对三个狗节点，并明确禁止终端、文件和写操作。当时该工具没有 alias
过滤，返回全舰团后模型可见结果被截断；模型随后错误地尝试用 Run 解析落盘结果，运行时安全门
以 `[grok_failure:approval_boundary]` 终止 turn 和 TUI。没有发生写操作，证明安全门有效；同时也
证明当前工具形状不适合让受限模型直接做大舰团巡检。缺口已登记为 issue
[#824](https://github.com/sleep2agi/agent-network/issues/824)：要求服务端在序列化前按 alias/node_id
过滤并支持紧凑字段投影，不能把客户端后过滤冒充成防截断。

本次只恢复 `通信狗`，未动另外两个节点。配置 SHA-256 在恢复前后均为
`a8cbc30dc7d2466073c27f2e8499db598a8fc23c310ec121bb458919f775230b`，session 仍为
`c47d3225-6d87-48a2-8c84-6c11db20a455`；tmux 恢复为同名 `通信狗`，`0:node` 与 `1:tui`
均存活。owner-only 回滚点为
`/home/vansin/.commhub/rollback-commdog-fleet-audit-20260813T050200Z/`。在 #824 落地前，
不得把全量 `get_all_status` 直接派给通信狗；应由受控编排者先做服务端/可信侧过滤，再把小分母
事实交给它分析。恢复后的 TUI 又在 5.7 秒内直接调用 `commhub_send_message` 向 `通信牛`
发送恢复 ACK，返回 message id `9e3609d9-616c-4efa-b434-d242d9fc8811`；这排除了仅有 node/tmux
进程复活而 MCP 工具仍丢失的假恢复。

第三个真实 PR delta 评审任务 `04f6800a-8adb-46bb-912e-68573a58be5d` 使用 PR #803 的
`source=aeec4b9c130e6439feb622b1d2213f9f8f61d1fb`，在 1 分 25 秒内终态 `replied`。
它识别出 `recovered-suites` 虽是独立 job，但内部六个 build/run step 串行，前一套件失败会让
后两套件不再执行；这不会造成假绿，却意味着“job 已接入”不能表述成“每次三个诊断信号都
齐全”。exact source 交叉核同时确认：test224/test597 使用裸 `SOURCE_COMMIT`，test679 使用
`TEST679_SOURCE_COMMIT`；test224 的 run 确实带 `--network none`，build 保持联网；三个套件
的全部 COPY 输入在 pull 与 push 两侧均有 path trigger。`qa.sh` 当前十七个 L1 套件中，十三
个无对应 ARG，其余四个推导结果与旧硬编码链逐字一致，`|| true` 正确避免无 ARG 时被
`pipefail` 提前终止。任务后节点仍为 idle、`in_flight=0`，node/TUI pane 均存活。这证明它能
连续处理 runner、GitHub Actions 与安全前提的组合审查；同样要求 exact source 复核其因正文
未包含 Dockerfile 而暂列 NOT COVERED 的部分。

首个按“完整坐标 + 完整 delta + 权威事实”格式派发的纯文档语义审查是 PR #810，任务
`0336d126-7b3b-450e-9a3a-90a43c098197`。输入内含完整 base/source SHA、两个文档文件的四行
改动、`licenses` schema、`createNetwork()` 配额分支与旧行号实际落在发 token 代码上的事实；
同时硬禁终端、文件、Web、舰团状态和写工具。`通信狗` 给出 `CLEAN（附 MINOR）`：四处变更
均受输入事实支持，但中文“quota 在 createNetwork 里 enforced”范围过宽，容易把 license trial
的 `max_networks=3` 与 free plan 建网门 `max_networks_owned=2` 混成一层。它建议显式拆成
“建网配额按 plan 的 max_networks_owned 校验；trial limits 默认来自 licenses”。它还把
`createNetwork` 是否执行 `max_agents/max_tasks_day`、REST 映射和作者的 0.8.8 动态探测列为
NOT COVERED，没有冒充独立复验。全过程外部工具调用为零。

随后两条审查暴露了一个更重要的派单纪律：**正文必须是冻结 PR 的真实 delta，不能用“等价但
更强”的示例替代。** 首次派给 `通信狗` 的 PR #805 任务
`117975b4-d8ad-41a3-9939-fc90f0c9f434` 误把实际 shell 示例改写成了带名称清洗、
`-wal/-shm` 清理和退出码保留的理想版本；它给出的 `MINOR` 只说明该虚构输入内部自洽，已
明确撤销，**不得**作为 #805 的审查证据。按真实 source
`d570b957073e0876c36a6a41fc257646dddd6d0a` 重派任务
`3ff39711-f52e-4106-902d-6275641c13dc` 后，`通信狗` 判为 `MAJOR`：文档的整套循环使用
`bun test "$f" || echo "FAILED: $f"`，单测失败后脚本仍可能以 0 退出，把失败冒充成功。最窄
修复是累计失败并最终非 0，或首败直接非 0；只删主 DB、不清 sidecar、无 trap 和同 basename
碰撞另列为 `MINOR`。

PR #809 的真实 source `d9e5f50fbc38670fef8a33a9ffa169409cae6d99` 通过任务
`c2c3d09f-2ed1-4d2b-a3d8-426f874d09ab` 审查，同样得到 `MAJOR`：英文同页新增样例和表格
说 latest 0.8.8 未认证返回 `sse_sessions: {}`，旧正文却仍写 anonymous 请求不包含
`sse_sessions`。中文“键可出现但无 session 载荷”的方向正确，空对象不等于泄漏；“其余十三
个键都有”只能作为带版本和日期的单次 capture 观测，不能冒充永恒 API 契约。两条任务均明确
禁止外部工具并以 `NO_EXTERNAL_TOOL_USED` 收尾。

该任务同时实测到当前任务回执正文约 2000 字符后会被截断。后续长审查必须要求分段或先给
短结论，不能把截断后的半段当完整裁定；本轮用不超过 350 字的收口任务
`59147851-0e10-496c-a75f-9285887ea721` 取得最终等级与边界。这是任务编排约束，不是模型推理
失败。

PR #805 随后把真实缺陷修到 head
`c6d2c78ff1a94e91094fd18a5f3100e5dab459ec`。复核任务
`668d04b5-2204-4ee1-9d71-3894577170af` 仍只提供 exact delta，并禁止外部工具；`通信狗`
判为 `CLEAN（附 MINOR）`：任一 `bun test` 失败只会把累计 `rc` 置为 1，后续成功不会清零，
末尾 `[ "$rc" -eq 0 ]` 因而在脚本中返回非零，在交互 shell 中也可由 `$?` 读取而不会退出
操作者的 shell。无 `trap`、只做跑前的 DB/WAL/SHM 清理，以及 nullglob、文件名前缀与
`qa.sh` 同步仍是 `MINOR`/`NOT COVERED`。该闭环证明 `通信狗` 能复核作者是否真正关闭自己
先前指出的缺陷，而不是只会首次挑错。

完整 75 行节点判活文档 PR #812 通过任务
`b6503c90-8dfe-4533-9fb0-1ac92351b2e6` 做了下一档 prompt-contained 审查。输入钉死
`base=034f00647d42d38d5086d7fc057eb7824a441791` 与
`head=7b1855fc227a68af017e2b6baef08edf369c24fb`，并包含全文而非摘要。`通信狗` 在约 35 秒内
返回 `MINOR`：主线“看产物推进，不看进程数/started”自洽；但 `task_events.actor`“伪造不了”
没有鉴权、重放或 DB 写入证据，`capture-pane | tail` 可能回显任务正文，而“有桥、无
app-server 的 codex 节点就是此故障”应收窄为契约上预期有 appsrv 且长期缺失时的高度可疑
故障类。它还把 queued→600 秒只支持排队与超时、不能单独证明唯一因果列为边界。该结果已用
`send_message` 回传维护者；它是完整语义审查证据，仍不是 merge authority。

PR #815 新增 267 行自检方法论文档，超过单条任务正文的可靠长度；编排者没有截断后冒充全文
审查，而是把原文按完整章节边界分成 A（1–145 行）与 B（146–267 行），再要求同一 Grok
session 做跨段综合。任务分别为 `32646fab-6d92-4a32-9d8f-0cc4c00907f7`、
`962d7068-24a2-42ed-b7af-b37364ea4195` 与
`be4e1544-faed-44ff-9ddf-20f17c8d5155`，三条均禁止外部工具并以
`NO_EXTERNAL_TOOL_USED` 收尾。A 段为 `MAJOR`、B 段为 `MINOR`，全文综合仍为 `MAJOR`：文档
一边规定 report-only 子提交位于被测 `SRC` 之上，一边又强制报告锚点等于当前 `HEAD`，会把
合法 report-only/stack 拓扑系统性判成假红。最小修法是要求锚点唯一且等于实际被测/build-arg
`SRC`，同时明确报告提交后的 `HEAD` 可以位于 `SRC` 之上。`git show | grep` 只能作为必要非
充分条件、109 条日志不等于 109 个独立任务、`import` 不等于路径覆盖，以及破坏性删测 mutation
必须在隔离 worktree 等边界也被准确分层为 `MINOR`。这证明 `通信狗` 已能在有长度约束时完成
分段审查和跨段矛盾综合；事实坐标仍须 exact Git 审查者复验。

针对 Grok TUI 出站假健康的 #813 已从旧候选分出新 Draft PR
[#825](https://github.com/sleep2agi/agent-network/pull/825)：冻结 source
`8186b79de8e2f904c28bec268d93a523503a6845`，新增产品链 doctor 4→3 反向门，并把 TUI-ready
判据锚定为完整时间戳日志行，避免 minified source stack 里的同名字面量骗过 grep。repo-read
阶段 2 随后重放为依赖 #825 的 Draft PR
[#826](https://github.com/sleep2agi/agent-network/pull/826)，冻结 source
`449683586a5a2ba44e99eb8c595be25d7467c967`。其 exact-source Docker 证据为 agent-node
`1284 pass / 0 fail / 4406 expect / 91 files`，#813 readiness 四条 mutation 全红，repo-read
selector 命名 mutation 也红，镜像回取文件 `17/17 MATCH`。该证据生成时两条均等待独立审
和合并；在该证据生成时，live `通信狗` 继续使用已验证的 `x-search`/CommHub-only 边界，**不得**因 Draft PR
或本段记录提前改成 repo-read。

独立审随后闭环：#825 裁定 `CLEAN`，durable comment 为
`https://github.com/sleep2agi/agent-network/pull/825#issuecomment-5276444160`；#826 stacked 裁定
同为 `CLEAN`，durable comment 为
`https://github.com/sleep2agi/agent-network/pull/826#issuecomment-5276485812`。#826 的 Hosted CI
也已全部通过。审查确认 #825 source 是 #826 的 ancestor，且 #826 不得先于 #825 合并；两条
Draft 截至该裁定仍未合并、未发布。技术门通过不等于 rollout 授权，live profile 仍不得改变。

### repo-read pilot 前的只读基线

2026-08-13 13:48 CST 在未停止进程、未创建备份、未读取 token 的条件下，live `通信狗` 基线为：

```text
config=/home/vansin/grok-commdog-workspace/.anet/nodes/通信狗/config.json
config_sha256=a8cbc30dc7d2466073c27f2e8499db598a8fc23c310ec121bb458919f775230b
config_owner=vansin:vansin
config_mode=0600
node_id=n_72be30e0
runtime=grok-build-cli
model=grok-4.5
tools=[WebSearch]
grok_session=c47d3225-6d87-48a2-8c84-6c11db20a455
cwd=/home/vansin/grok-commdog-workspace
parent_pid=1933093
agent_node_pid=1933163
tmux=通信狗
node_pane=%1107
tui_pane=%1108
```

该时点的部署副本与哈希：

```text
/home/vansin/commniu-grok-candidate-a7865a43/runtime/node_modules/@sleep2agi/agent-network/dist/bin/cli.js
sha256=af3847dd1ddb75dd1265e995b1f2bd215df064e1b6c7e7aa823a1a96b270d7da

/home/vansin/commniu-grok-candidate-a7865a43/runtime/node_modules/@sleep2agi/agent-node/dist/cli.js
sha256=03e9bed6630530e8fb03420dba32c6e06a90ae8cbe3fcdf33541a047708a7bb4
```

PID 与 pane id 只是该时点的观察值，不能当重建身份；恢复权威仍是 config/node_id/session、部署
副本路径与文件哈希。该快照**不是** pilot 备份或启动许可。真正切换前还必须创建 owner-only
rollback 目录，字节复制 config，记录旧启动命令和当前进程出生时间，并回报绝对路径后再停
单一 `通信狗`；任何一项与本快照不符都应先解释漂移，而不是照抄旧 PID 操作。

## 从 Git 恢复软件

当前 `grok-build-cli` 是 source-only 路径。宿主部署副本
`/home/vansin/commniu-grok-candidate-a7865a43/` 不能作为唯一来源；从空机恢复时必须从
Git 取冻结 commit：

```bash
git clone https://github.com/sleep2agi/agent-network.git
cd agent-network
git checkout --detach a7865a4316a17d38e4c8dfc4c2cebaceaba2c62c
git status --short
```

`agent-network/package-lock.json` 在该 commit 中存在；`agent-node` 当时没有独立 lockfile。
因此当前只能按下列命令做功能级源码重建，不能宣称依赖闭包或制品字节已由 Git 完整冻结：

```bash
npm ci --prefix agent-network
npm run build --prefix agent-network
npm install --prefix agent-node
npm run build --prefix agent-node

mkdir -p /tmp/anet-grok-release/packages
npm pack ./agent-network --pack-destination /tmp/anet-grok-release/packages
npm pack ./agent-node --pack-destination /tmp/anet-grok-release/packages
```

把两份新 tarball 安装到独立 release 目录。恢复者必须回读版本并记录新制品 SHA-256；若要宣称与
2026-08-13 部署字节完全相同，还必须与上表 tarball及 installed CLI 哈希逐项匹配。
只做到“源码相同、重新构建成功”不能冒充 byte-identical。

`agent-node` 的依赖闭包冻结仍是 **NOT COVERED**，需要后续补 lockfile 或可验证的 release
artifact；本文不会用一段看似精确的命令掩盖这个缺口。

Grok CLI 从官方渠道安装固定版本 `0.2.93`，并核对上表二进制 SHA-256。官方分发 URL、
签名/校验和的 Git 权威副本目前 **NOT COVERED**；在补齐前，Git-only 恢复可复现
Agent Network 侧源码与配置流程，但不能证明 Grok 闭源二进制的供应链来源。

## 创建配置（不把密钥写进 Git）

配置目录与 token 是运行数据，不提交仓库。空机恢复有两种合法来源：

1. 从 owner 控制的加密备份恢复 `.anet/nodes/通信狗/config.json`；或
2. 通过 `anet login` 后重新注册同名节点，接受新的 `node_id` 与 token。

不得从会话记录、旧日志或别的节点复制 token。新建命令使用已构建的 CLI：

```bash
mkdir -p /home/vansin/grok-commdog-workspace
cd /home/vansin/grok-commdog-workspace
node /absolute/release/agent-network/dist/bin/cli.js \
  node create 通信狗 \
  --runtime grok-build-cli \
  --model grok-4.5 \
  --tools WebSearch
chmod 600 .anet/nodes/通信狗/config.json
```

网络选择必须由 owner 会话完成。不要加 `--batch` 来绕过交互选择：2026-08-13 的实测中，
该组合仍进入 vendor selector，不能当成无人值守恢复接口。

## 首次建机的精确启动

`agent-network` CLI 与 `agent-node` 必须来自同一冻结 release。若省略
`ANET_AGENT_NODE_BIN`，宿主可能误用不支持 `grok-build-cli` 的旧全局 agent-node，出现
命令返回但节点未上线的假成功。

下面的 `--new-session` **只用于首次创建 Grok CLI 会话**。已有 config/session 的故障恢复
不得照抄该参数；恢复路径见下一节。

```bash
export ANET_RELEASE=/absolute/release
export GROK_BINARY=/absolute/path/to/grok-0.2.93
export ANET_AGENT_NODE_BIN="$ANET_RELEASE/agent-node/dist/cli.js"
export BUN_DIR=/absolute/directory/containing/verified-bun
export NODE_DIR=/absolute/directory/containing/verified-node
export PATH="$BUN_DIR:/absolute/directory/containing/grok:$NODE_DIR:/usr/local/bin:/usr/bin:/bin"

command -v bun
test "$(bun --version)" = "1.3.14"
command -v node
command -v "$GROK_BINARY"

cd /home/vansin/grok-commdog-workspace
tmux new-session -d -s 通信狗 -n node \
  "env PATH='$PATH' GROK_BINARY='$GROK_BINARY' \
       ANET_AGENT_NODE_BIN='$ANET_AGENT_NODE_BIN' \
       node '$ANET_RELEASE/agent-network/dist/bin/cli.js' \
       node start 通信狗 --new-session"

# attach socket 是最低就绪门；有 tmux 窗口但 socket 未就绪不能算 TUI 共存。
CONFIG=/home/vansin/grok-commdog-workspace/.anet/nodes/通信狗/config.json
ATTACH_SOCKET="$(jq -er '.grokAttachSocket' "$CONFIG")"
for _ in $(seq 1 60); do
  test -S "$ATTACH_SOCKET" && break
  sleep 0.5
done
test -S "$ATTACH_SOCKET" || { echo "Grok attach socket not ready" >&2; exit 1; }

# 让 `tmux attach -t 通信狗` 默认进入真实 TUI，而不是节点日志窗口。
tmux new-window -d -t 通信狗 -n tui \
  -c /home/vansin/grok-commdog-workspace \
  "exec node '$ANET_RELEASE/agent-network/dist/bin/cli.js' grok attach 通信狗"
tmux select-window -t 通信狗:tui
```

该布局中 `0:node` 是常驻通信节点，`1:tui` 是同一 Grok session 的交互界面；两者不是两套
模型会话。运维者进入 `tmux attach -t 通信狗` 后应直接看到
`attached to Grok TUI "通信狗"`。用 `Ctrl-b 0` 查看节点日志、`Ctrl-b 1` 回到 TUI；
TUI 内 `Ctrl-]` 只断开 attach，不停止节点。`A站狗`、`P站狗` 使用相同两窗口布局，只替换
alias、workspace 与 tmux 名。

不要仅凭命令退出码或 tmux 名称宣告成功。启动后至少核对：

```bash
tmux has-session -t 通信狗
tmux list-windows -t 通信狗 \
  -F '#{window_index} #{window_name} active=#{window_active} panes=#{window_panes}'
tmux capture-pane -t 通信狗:tui -p -S -80
ps -eo pid,ppid,lstart,args | grep '[a]gent-node.*--alias 通信狗'
sha256sum "$ANET_RELEASE/agent-network/dist/bin/cli.js" \
          "$ANET_RELEASE/agent-node/dist/cli.js" \
          "$GROK_BINARY"
```

再从 Hub/Dashboard 核对 alias 在线、runtime=`grok-build-cli`、model=`grok-4.5`、
`node_id` 与配置一致，并派一条无副作用任务验证真实 turn 与 terminal reply。

### CommHub MCP 是独立就绪门

attach socket、TUI 和 Hub 入站任务都正常，仍不能证明 TUI 的出站 CommHub MCP 正常。必须从
**目标节点自己的 workspace**（不是任意 cwd）运行 doctor；Grok 的 folder trust 会使错误 cwd
产生无关失败：

```bash
cd /home/vansin/grok-commdog-workspace
GROK_HOME=/absolute/grok-home-for-this-node \
PATH="$PATH" \
  "$GROK_BINARY" mcp doctor commhub --json > /tmp/commdog-mcp-doctor.json

jq -e '
  .healthy_count == 1 and
  .failing_count == 0 and
  ([.servers[] | select(.name == "commhub")][0].healthy == true) and
  ([.servers[] | select(.name == "commhub")][0].checks |
    any(.label == "3 tools discovered" and .passed == true))
' /tmp/commdog-mcp-doctor.json
```

最后从可见 TUI 发一条无副作用 `commhub_send_message`，并从 Hub 侧按返回的 message id 回读
`from_session`、`session_name`、`type=message`。只有 doctor 与真实出站消息都通过，才可宣告
TUI/节点通信共存恢复完成。反向见证应移除 Bun 所在目录后确认 doctor 在
`command found` 这一项转红；不能只检查 MCP 配置文件里出现了 `command = "bun"`。

## 停用与回滚

这是新增节点，没有需要恢复的旧 `通信狗` 运行时。失败时的安全回滚是只停该 tmux/进程、
保留配置与会话供取证，不删除 workspace，不重建 Hub，不碰其它节点：

```bash
tmux send-keys -t 通信狗:node C-c
# 确认该 alias 的 agent-node 退出；若仍在，记录 PID 后只对精确 PID 做 TERM。
ps -eo pid,ppid,lstart,args | grep '[a]gent-node.*--alias 通信狗'
```

不要使用宽泛 `pkill`、fleet restart、数据库清理或 `docker prune` 作为回滚。重新上线时仍按
“同一 source commit → 制品哈希 → 单节点 → 真实任务”的顺序执行。

普通故障恢复必须先记录已有会话，再用**不带 `--new-session`** 的相同启动命令恢复：

```bash
CONFIG=/home/vansin/grok-commdog-workspace/.anet/nodes/通信狗/config.json
SESSION_BEFORE="$(jq -er '.grokCliSession' "$CONFIG")"

# 仅在上面的精确进程退出核验通过后，清掉该 alias 的残留 tmux attach 窗。
tmux has-session -t 通信狗 2>/dev/null && tmux kill-session -t 通信狗

# 只重建目标节点；env 与二进制路径沿用“首次建机”一节，但不得带 --new-session。
tmux new-session -d -s 通信狗 -n node \
  "env PATH='$PATH' GROK_BINARY='$GROK_BINARY' \
       ANET_AGENT_NODE_BIN='$ANET_AGENT_NODE_BIN' \
       node '$ANET_RELEASE/agent-network/dist/bin/cli.js' \
       node start 通信狗"

SESSION_AFTER="$(jq -er '.grokCliSession' "$CONFIG")"
test "$SESSION_AFTER" = "$SESSION_BEFORE" || {
  echo "unexpected Grok session replacement" >&2
  exit 1
}
```

随后仍需等待 attach socket、创建 `tui` 窗，并完成 `capture-pane`、CommHub MCP doctor 与 Hub
真任务终态核验。
**反向见证**是：把恢复命令误改为带 `--new-session` 时，会话保持断言必须转红；若只看
tmux 窗口存在而仍判成功，该验收就是空门。

唯一例外是：事件日志已经证明旧 session 的固定工具库存违反当前安全 profile，且对应 Grok
版本明确报告 resume 无法应用工具变化。此时必须先保留旧 config/session/事件证据与回滚坐标，
再对**单一 alias**执行一次 `--new-session`。新 session 不是自动成功：仍须重建 `0:node` +
`1:tui`，核 node_id 不变，并通过受限的真行为任务；不得借该例外批量换 session。

## 渐进参与边界

三个狗节点按证据逐级参与 AgentNetwork，不因会员额度增加而自动扩大权限：

1. **阶段 0（已通过）**：单轮回复、身份/模型/终态回执。
2. **阶段 1**：任务明确授权时可用 `WebSearch` 做通用公开资料检索，或审查任务正文中直接
   提供的 issue/PR 材料，报告事实与 NOT COVERED；当前不允许打开任意 URL、WebFetch 或
   PR 抓取，禁止写 GitHub。`WebSearch` 不是通用网页浏览授权。
3. **阶段 2**：在独立 clean worktree 起草 patch，Docker 验证并由另一节点独审；禁止自行合并。
4. **阶段 3**：经明确授权后执行一个有回滚点的单点运维动作，先回 preflight、后切换。
5. **舰团级动作**：批量配置、批量重启、发布、生产 DB、云资源与密钥操作始终需要单独授权，
   不由前一阶段的成功自动继承。

当前工具面只允许 Grok 自带的检索/任务工具与 `WebSearch`，没有文件系统、shell、媒体、
宿主 MCP 或子代理权限。任何扩权都要先更新本文、补行为门并留回滚坐标。

### `通信狗` 常规评审值班契约

截至 2026-08-13，`通信狗` 已连续完成至少三次真实 PR delta 评审，任务后 node/TUI 均存活；
后续次数以本文任务记录和 Hub task 为准。它可进入阶段 1 的常规评审队列，但**尚未进入阶段
2**。派单必须满足以下条件：

1. 正文钉死 base、source 与 report-only 的完整 SHA；报告提交不能冒充被测源码。
2. 把判定所需的完整实现 delta 和目标声明放进正文。只给局部 hunk 时，缺失 context 必须记
   `NOT COVERED`，不得据此给实现下 BLOCKER。
3. 若完整材料超过单条任务的可靠正文长度，必须按完整章节/文件边界编号分段，并在每段明确
   “非全文裁定”；未收齐全部分段不得给全文 `FINAL/CLEAN`。回执疑似被截断时先取短收口，
   不得把半段当完整结论。
4. 明确禁止终端、文件、任意 URL/WebFetch/PR 抓取、GitHub 写入、合并、部署和生产操作；仅当
   任务明示阶段 1 公开检索时允许 `WebSearch`。允许的工具以 TUI 启动 banner 中的固定
   inventory 为准。
5. 输出至少分 `BLOCKER / MAJOR / MINOR / NOT COVERED`，并区分“当前实现缺陷”“未来脆弱性”
   “任务声称证据不足”，不能把三者混成同一等级。
6. 回执后由具备 exact Git 对象读取能力的审查者核当前 PR head、完整 context、分母与 CI；
   `通信狗` 的结果是 advisory，不是 merge authority。
7. 每个任务验收同时核 Hub 终态、`in_flight=0`、tmux `0:node` 与 `1:tui` 均 `dead=0`。只收到
   文本而 TUI 已退出，或 Hub idle 但 TUI 不在，都算失败；若任务依赖 CommHub 工具，还要用
   MCP doctor 或一个限定目标的真实出站探针证明工具面可用。#824 落地前不得用全量
   `get_all_status` 充当该探针。
8. 发现缺口时用 `send_message` 向维护者回报事实与证据边界；状态同步不得再制造一条审查任务。

以下任一情况都不得直接派给当前 profile：需要 checkout/repo 搜索、运行 Docker、编辑 patch、
读取任意 URL、访问凭证或改变外部状态。此类任务先由具备对应能力的节点提取最小材料；若要让
`通信狗` 自己执行，必须按“扩权是新能力”另行设计、测试和授权，不能把正文里出现过代码等同于
已经获得仓库能力。

### 阶段 2 repo-read 候选（未部署）

旧 Draft PR #820 已被重放后的 [#826](https://github.com/sleep2agi/agent-network/pull/826)
取代，不再是合并或部署坐标。#826 严格依赖 #825；权威源码锚为
`449683586a5a2ba44e99eb8c595be25d7467c967`，report-only 子提交为
`114967626f20c7ef036c3d0e0dab295e1f983a89`。该候选只接受配置中的精确工具向量
`["Read","Grep","Glob"]`；顺序变化、缺项、增项和近似拼写全部 fail-closed。模型工具库存为
`todo_write/search_tool/use_tool/read_file/grep/list_dir`，不含 shell、写文件、Web、媒体或子代理。

Grok CLI 0.2.93 的 `workspace` sandbox 允许读取工作区外路径，因此 repo-read **不得**沿用
阶段 1 的 workspace profile。#826 将它映射到生成的 custom strict profile。exact-source Docker
门为 `1284 pass / 0 fail / 4406 expect / 91 files`；把 repo-read 错接回 workspace 的 mutation
命名红为 `Expected: "anet-strict" / Received: "anet-workspace"`。隔离的真实 Grok TUI PTY
实验属于旧 source，不能冒充 #826 的真 vendor 证据；#826 当前只继承 exact-source Docker 与
selector 行为门。完整证据与限制在
`docs/tests/report-grok-copresence-repo-read-stage2.txt`。

发布前的只读版本核验必须从冻结 Git 对象读取，不能从共享脏 worktree 读取。2026-08-13 的
`origin/main`、#825 source 与 #826 source 三者均为 `agent-network=2.3.0-preview.39`、
`agent-node=2.5.0-preview.31`、`commhub-server=0.9.0-preview.29`，并与当时 npm preview
dist-tag 一致；共享 worktree 因未解决冲突一度显示旧的 `.22/.20/.13`，该值不是发布坐标。
#825/#826 改动 CLI/runtime 的 C1 契约，因此新 preview 必须让 agent-node 与 agent-network
一起升版，server 不因本次改动重发；具体下一个版本仍须在发布瞬间重新查询 registry 防竞态。

registry 对上述 preview 只返回 tarball/integrity，未返回可用 `gitHead`，所以 npm metadata 不能
代替 Git provenance。release 必须在 fresh worktree 先形成包含版本与兼容矩阵的构建 commit，
再发布 preview，并用远端 immutable tag 回读验证它剥出的 SHA 等于构建 commit；不得只验本地
tag，也不得从未提交工作区发包。仓内校验器为 `scripts/verify-release-tag.sh`。

这只是候选，不是上线授权。在下述 dry-run baseline 采集时，live `通信狗` 仍使用已验的
x-search profile；事故后的当前安全终态是停机。repo-read pilot
必须同时满足：

1. #825 与 #826 依次经过独立对抗审，source/report 坐标未漂，并按正常流程合并、发版；不得
   把源码 worktree 直接覆盖到 live 节点。
2. 只对 `通信狗` 建 owner-only 配置、session 与启动坐标回滚点；node_id、workspace、tmux 名
   `通信狗` 均保持，绝不动 `A站狗`、`P站狗` 或其它舰团节点。
3. 因 Grok resume 不能改变固定 sandbox/tool inventory，切换时必须显式新建一个 Grok session；
   旧 session 保留作回滚与审计，不得伪称“保 session 且扩权”。
4. 启动后先从 TUI 事件核到 `ProfileApplied` 且 `enforced=true`，再核 banner/tool inventory 精确；
   任一缺失立即停目标节点并回旧 runtime/session。
5. 行为门须同时证明：仓内合成 marker 可读、仓外 sibling marker 不可读、受保护凭证 marker
   不可读、shell/写文件/Web 工具不存在。只看工具名或配置文本不算通过。
6. 最后用真实 Dashboard-origin 任务完成“读仓内指定文件 → 只用 `file:line` 回答 → 通过
   CommHub 回执”，并核 Hub 终态、`in_flight=0`、tmux node/TUI 两窗仍存活。
7. pilot 通过后仍只放行只读源码审查；编辑 patch、Docker、GitHub 写入、merge、deploy、生产
   DB、密钥或云资源权限都要另立能力门，不能从 repo-read 成功自动继承。

凭据路径 probe 必须区分“内容被拒”与“目录不可枚举”。#826 生成的 argv 对 credentialDir 有
`Read/Grep/Edit` 路径 deny，但没有 `list_dir` 对应规则；因此当前只能声明 **credential content
read/edit denied**，不能声明整个路径对模型不可见。真 vendor pilot 至少逐项验证：

1. 对已知 credentialDir 的 `.env` 执行 `read_file`，回复和事件中不得出现任何 token 或正文；
2. 对该目录及 `/**` 执行 `grep`，不得返回 token 命中或文件内容；
3. 执行 `list_dir`：若只返回 `.env` / `node-server.js` 固定文件名，记录为 residual metadata；若
   产品口径要求目录隐身，则这一步必须被拒，否则 pilot 不通过；
4. Write/Edit 工具必须不存在或明确拒绝，磁盘 marker 哈希保持不变；
5. 未把 credentialDir 传入任务时，模型不得主动给出随机目录路径、token 或凭据片段。

递归深度、symlink 跟随、size/mtime 元数据和拒绝错误是否回显绝对路径，在真 Grok 行为前均为
`NOT COVERED`，不得用 argv 单测代替。

2026-08-13 在任何切换前完成了一次只读 dry-run baseline，未建备份目录、未停止或重启进程、
未读取 token/env 值。结果如下，后续 pilot 必须以这些值作切换前复核与回滚基线：

```text
node_id=n_72be30e0
session_id=c47d3225-6d87-48a2-8c84-6c11db20a455
runtime=agent-node:grok-build-cli
model=grok-4.5
workspace=/home/vansin/grok-commdog-workspace
tmux=通信狗; windows=0:node,1:tui; panes=%1107,%1108; dead=0,0
config=/home/vansin/grok-commdog-workspace/.anet/nodes/通信狗/config.json
config_mode=600
config_sha256=a8cbc30dc7d2466073c27f2e8499db598a8fc23c310ec121bb458919f775230b
agent_network_cli_sha256=af3847dd1ddb75dd1265e995b1f2bd215df064e1b6c7e7aa823a1a96b270d7da
agent_node_cli_sha256=03e9bed6630530e8fb03420dba32c6e06a90ae8cbe3fcdf33541a047708a7bb4
```

进程树实测为 `agent-node -> bwrap -> Grok TUI leader -> Grok agent leader`，并存在 MCP Bun
子进程；这证明当前基线是真 TUI 共存，不是 ACP runtime。配置的非密钥投影仍为
`copresence=true`、`tools=[WebSearch]`，repo-read 尚未上线。切换时不得重新读取或回显配置中的
token/env 值，只能核 mode、hash 与上述非密钥字段。

### 2026-08-13 `run_terminal_command` 事故与恢复

一条明确要求 prompt-only、禁止外部工具的 PR #810 文档审查仍让 Grok TUI 显示
`Run No-op; review is prompt-only`。该 session 的 `events.jsonl` 给出决定性顺序：

```text
permission_requested tool_name=run_terminal_command
permission_resolved tool_name=run_terminal_command decision=allow wait_ms=0
tool_completed tool_name=run_terminal_command outcome=success
```

当时启动 argv 只拒绝跨 runtime 的策略名 `Bash`，没有拒绝 Grok 0.2.93 实际上报的 vendor
tool name `run_terminal_command`。监督层随后以 `grok_failure:approval_boundary` fail-closed 并停止
TUI，但发生在工具已报告成功之后。因此此前“shell unavailable”的 banner/文档声明被实证推翻；
在修复经真 vendor pilot 前，不再向该节点派任何工作任务。

恢复只涉及 `通信狗`。旧配置备份在 owner-only 目录
`/home/vansin/.commhub/rollback-commdog-approval-boundary-20260813T061442Z/`，其中
`config.json.old` mode 600、SHA-256 为
`a8cbc30dc7d2466073c27f2e8499db598a8fc23c310ec121bb458919f775230b`。精确停止旧 PIDs 后，使用
`/home/vansin/.grok/bin/grok-0.2.93`（`grok 0.2.93 (f00f96316d)`）和原 agent-node 构建创建新
session `890fdcee-96d1-429e-991f-5bc09ad97722`。恢复后 tmux 仍严格名为 `通信狗`，`node/tui`
两窗为 `%1107/%1109` 且 `dead=0`。

新 session 会按设计把 `grokCliSession` 写回配置，所以恢复后的 live config SHA-256 是
`719aec58f991816c524e7890fafcaf8744b6cc368e6e6b416e97bec736d07220`；不能把“非密钥能力字段
未变”误写成“配置逐字节未变”。后态仍是 `runtime=grok-build-cli`、`model=grok-4.5`、
`grokCopresence=true`、`tools=[WebSearch]`、mode 600。

修复 Draft PR 为 #830，严格堆叠顺序是 #825 → #826 → #830：

```text
source=433b4af44bdcc09145c75b697634f74aec42a7df
report-only=d51a4473f6aea75547437150dba729524506062b
image=sha256:df3b83526409d21ece60f0a5a12589e0fc0933616af617ea83abd6e1416deb1c
```

后续核验还证明 Grok agent profile 的 `tools` 列表不是完整的 native tool 权威边界。最终 source
以 pinned 0.2.93 的真实 `AvailableCommandsUpdate._meta.tools` 25-name 清单为分母：每个名称必须
属于所选 profile 的明确允许集，或在最后启动 argv 中被明确拒绝。18 个非 read/search 名称进入
common deny，另有 10 个 binary/repository alias 作预防性拒绝；`commhub-only`、`x-search`、
`repo-read` 再分别约束 read_file/grep/list_dir/web_search。只有 `run_terminal_command` 已在 live
lifecycle 中出现；其余规则不能写成“已证明每个名称可达”。

Docker 证明完整 unit domain 为 `1284 pass / 0 fail / 4609 expect / 91 files`，聚焦门为
`54 pass / 0 fail / 655 expect / 2 files`。七个独立 production mutation 分别破坏 common
`run_terminal_command`、`write`、`scheduler_create`、`web_fetch`、`image_edit` 和 profile-specific
`read_file`、`web_search`；每条均在 fresh container 中按缺失工具名转红。这些仍只证明 argv
构造，不冒充真 vendor：上线前必须用新 session 重放 prompt-only 审查并覆盖 terminal、write、
scheduler/control、fetch、media、read 与 web-search 行为，events 不得出现被拒工具的
request/resolution/completion，且磁盘、网络与 scheduler 侧不得产生副作用。

同一冻结 head `d51a4473f6aea75547437150dba729524506062b` 的 GitHub Hosted CI 随后全部通过：
两条完整 E2E 分别为 `10m36s` 与 `10m20s`，L0/L1、agent-network unit、agent-node unit、
两条 rename-ghost gate 和两条 lint gate 均为 `pass`。这补充证明该 stack 没有破坏仓库当前的
自动化回归门，但仍不代替 pinned Grok 真机行为验收，也不构成合并、发布或节点重启授权。
旧 `f407ed96/78a6de9c` 的独立 `CLEAN` 已被 durable supersede；只有针对当前
`433b4af4/d51a4473` 坐标的新独立裁定才可作为审查门。

当前坐标的独立只读审查随后裁定 `CLEAN`（无 BLOCKER/MAJOR/MINOR），durable comment 为
`https://github.com/sleep2agi/agent-network/pull/830#issuecomment-5277364559`。审查从远端 Git
对象重新核了 base/source/report 拓扑、25-name 分母、三 profile 的 allow/deny partition、七条
named-red、数字/provenance、secret sweep 与 merge-tree；没有复用旧候选的结论。技术审查通过
仍不等于合并、发布或 pilot 授权。原审查评论曾误写 `28=25+3`，其 append-only 纠错
`https://github.com/sleep2agi/agent-network/pull/830#issuecomment-5277409033` 已独立复算并确认正确
集合为 `25 captured = 7 allowed + 18 observed denied`、`28 vendor denies = 18 observed + 10
preventive aliases`；该错误只在审查转述，不在报告或实现中。

恢复取证完成后，节点仍运行未修复字节；继续在线会让后续任务再次触发同一 shell 面。因此在
14:38 CST 对 PID `2067974` 发送精确停止，进程在 barrier 内退出，未使用 `pkill`、未修改配置、
未触碰其它节点。当前安全终态是 tmux session `通信狗` 保留、`node` pane `%1107` dead、Hub
节点等待修复发布后重启；不是“在线可用”。不得为了恢复绿色状态用未审源码覆盖 live runtime。

## 数据与密钥边界

Git 只恢复软件和非密钥流程，不恢复以下数据：Hub 数据库、node token、Grok 登录/会员状态、
`grokCliSession`、任务历史与用户生成内容。它们必须来自经过批准的备份或重新注册。
文档只记录密钥来源和恢复动作，永不记录密钥值。

## A站狗与 P站狗的首轮证据

两节点均以 `grok-build-cli` / `grok-4.5` / `WebSearch` 创建并在独立 tmux 中启动。
Hub 显示各自的 `project_dir` 与上表一致，真实任务分别完成：

```text
ASTATION_DOG_OK alias=A站狗 model=grok-4.5
CHECK=7+8=15

PSTATION_DOG_OK alias=P站狗 model=grok-4.5
CHECK=9+6=15
```

任务完成后两个 tmux pane 均 `dead=0`，两条独立 attach socket 均仍为 Unix socket，证明
节点通信与可 attach 的 Grok TUI 同时存活，而非“任务跑完后 TUI 被替换”。

`A站狗` 创建时曾把 config 写入全局 `~/.anet/nodes/A站狗`，从独立 workspace 启动会
fail-closed 报 `Node "A站狗" not found`。配置经 SHA-256 字节比对后迁入目标 workspace；
未使用的原始全局副本保存在 owner-only 回滚坐标
`/home/vansin/.commhub/rollback-Astationdog-global-config-20260813T015544Z/`。恢复时必须核对
实际 `config_path`，不能只采信 create 命令的成功文案。
