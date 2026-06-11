# Agent 团队协作 Playbook

> 通信产研团队 + N站 团队在 anet 上跑了几周打磨出来的协作模式。汇总成文档供 A站 / B站 / P站 团队负责人参考，帮助新团队跑顺。
>
> **维护**：通信龙（anet Agent Network 负责人）· **首版**：2026-05-15

---

## 0. 一句话总结

**以 GitHub issue 为中心、commhub 为协作管道、Tier review 为质量门、每个 lead 有更大自主性。所有协作都围绕「事事可追溯 + 不阻塞 Vincent + ship 前自验」展开。**

---

## 1. 团队结构

### 1.1 角色范式

每个产研团队建议骨架（按业务调整）：
- **负责人 / lead**：策略 + 方向 + dispatch + review verdict，不主动写业务码
- **产品 / 内容 / 研发 / 工程 / 测试 / 运营 / 运维**：按业务垂直拆，每条 lane 一人

实际例子：
- 通信团队：通信龙(lead) + SDK马 + 工程马 + 文档马 + 测试马 + demo马 + 通信牛(review)
- N站团队：N站马(dashboard 前端) + N站牛(codex-sdk)
- B站课程产研：B站马(lead) + 课程研发 + 产品经理 + 工程师 + 运营 + 测试 + 运维（7 人）
- A站团队：A站运营马(lead) + 数据 + 内容 + 评测 + 设计 + 工程师

### 1.2 命名

- **内部 dispatch / commhub alias 用「X马」** 短名（B站马 / 通信SDK马），方便快速派单
- **user-facing 文档 / RFC / demo 用正常职位名**（B站工程师 / B站产品经理），不暴露内部 alias
- 见 memory `feedback_no_x_horse_in_user_facing.md`

### 1.3 Lead 的真正职责

不是技术执行，而是：
1. **dispatch**：把任务派给合适的人，明确范围 + ETA
2. **review**：交付物过 verdict（pass / request-changes / blocker），不放过 schema 错、逻辑漏洞
3. **方向**：策略级取舍（要不要做、做哪条路径、什么优先级）
4. **测试**：交付前 gate test（不自己跑，派给测试号）
5. **协调**：跨团队资源 + 阻塞上报 Vincent

---

## 2. 协作管道 — CommHub

### 2.1 三动作循环

每次接到任务必须：**确认 → 执行 → 汇报**。

```
收到任务（commhub channel message）
  ↓
立即用 commhub_send_task 回 lead "ack"（30s 内）
  ↓
执行（中途 commhub_report_status 报进度）
  ↓
完成用 commhub_send_task 回 lead 完整结果（链接 + 验证 + 备注）
  ↓
阻塞用 commhub_send_task 立即报 lead，不要憋着
```

### 2.2 工具用法

| 场景 | 工具 |
|---|---|
| 给 lead / 队友发消息 | `commhub_send_task(alias, task)` |
| 上报自己状态 | `commhub_report_status(status, task)` |
| 查谁在线 | `commhub_get_all_status` |

**回复人类（指挥室 / Vincent）用 `commhub_send_task` 不用 `commhub_reply`** —— `reply` 不推送。

### 2.3 已知坑

- **commhub_get_all_status 的 `last_seen_at` 字段会 stale** —— 判断 agent 死活前必先 `tmux capture-pane` 看真实 pane（issue #108）
- **commhub 消息有延迟投递 / 偶尔丢失** —— 重要消息 1-2 轮没回，先 capture-pane 看对方 pane 状态再下结论
- **codex-sdk runtime** 当前 session 工具可用性会变（commhub_send_task 可能在某 session 不可用）—— 见 issue #102

---

## 3. 工作流 — 以 Issue 为中心

### 3.1 任何工作都从 issue 起

Vincent 4504 定调：**GitHub issue = 项目 single source of truth**。

```
有问题/想法
  ↓
先 gh issue list 搜（dedup！）
  ├─ 已有 issue → 评论 / sub-task / 在该 issue 推进
  └─ 没有 → 开新 issue（body 写清楚：问题、期望、优先级、owner、Related）
  ↓
进度及时更新到 issue 评论（不只 telegram / commhub）
  ↓
完成 → 评论验证结果 + close
```

### 3.2 Dedup 规则（开 issue 前必做）

Vincent 4471+4474：开新 issue 前**必先**搜：

```bash
gh issue list --search "<关键词>" --state open
gh issue list --search "<关键词>" --state all  # 检查 closed 的
```

- 有 overlap → 在已有 issue 评论 / 加 sub-task，不重开
- 没有 → 开新，body 加 `Related Issues` 段 cross-link 相关 issue

### 3.3 优先级

- **P0**：阻塞 / 用户实测出错 / Vincent 明指
- **P1**：影响体验但有 workaround
- **P2**：可观察的小问题 / 改进
- **P3**：nice-to-have

### 3.4 PR / Commit Attribution（3-track）

memory `feedback_attribution_traceability_sop.md`：

1. **Issue body** 顶部 `## Assignment` 段 `Agent: <alias>`
2. **PR body**（如果开 PR）顶部 `## Author` 段 `Agent: <alias>`
3. **Commit msg** 尾部 footer trailer `Author-Agent: <alias>`

**Commit 一律不加 `Co-Authored-By: Claude`**（memory `feedback_no_claude_attribution.md`，Vincent 硬规矩）。

---

## 4. 决策与上报 — 自主性边界

### 4.1 Lead 自己定（不 gate Vincent）

memory `feedback_greater_autonomy.md`：

- 任务 dispatch / 派给谁 / surface owner 指派
- agent dark / 不可靠时的 reassign
- 团队内优先级排序
- review verdict（review 是 lead 职责）
- 安全可逆的执行路径

→ **default-dispatch 优于干等**：被依赖的环节卡住 + Vincent 没回 → 选最合理路径派下去。

### 4.2 必须 surface Vincent 的

- 大 / 不可逆操作（npm latest promotion、删 runtime、删数据）
- 战略方向（产品方向、商业模式、新大功能要不要做）
- 跨他别项目的资源借调
- 真正需要他拍板的 trade-off
- 进度同步（telegram / issue 更新）—— **这是告知不是 gate**

### 4.3 判断边界

**「这个决定错了，可逆吗 / 影响面多大」**：
- 可逆 + 影响面限于团队内 → 自己定
- 不可逆 / 影响用户 / 战略级 → surface

---

## 5. 质量门 — Tier Review Gate

### 5.1 设计先 review，再 implement

大 / 复杂 feature：

```
1. owner 写简短设计方案（交互 / schema 改动 / 关键决策点）
2. 发 lead 或 review 角色 review
3. review pass → implement
4. 不要 design-implement 来回返工
```

实际例子：#115（anet node create resume）—— 工程马 先发 20min 设计 review → 通过 → ~50min 完整 ship + 12/12 test pass。

### 5.2 RFC review

战略级 feature 走 RFC：

```
1. SDK马 / 相关 lead 写 RFC Draft v1
2. 通信牛 deep review（4 blockers 标准：schema 是否 grounded、跨现有能力是否 align、API 假设是否成立、安全/权限是否覆盖）
3. SDK马 amend v2 解决 blockers
4. 通信牛 second pass → approve
5. 然后才 implement
```

### 5.3 测试是 close gate

P0 / P1 fix：
- owner 写 fix + 自测（自验后再说"完成"）
- 测试号跑 smoke / E2E（不放过 unverified close）
- 测试通过才 issue close

memory `feedback_verify_before_handoff.md`：不把没做好的发给 Vincent 试。

---

## 6. Trust-but-Verify（团队座右铭）

### 6.1 Ship URL claim 必 curl

memory `feedback_ship_url_verify.md`：agent 说"ship 了 / URL 返回新内容" → lead 必 `curl` 验 HTTP 200 + 内容匹配，再 ack。

### 6.2 Agent 死活必 capture-pane

memory `feedback_verify_agent_state_before_alarm.md`：报"agent dark / 失联" 前必：

```bash
tmux capture-pane -t <session> -p -S -40   # 看 pane 实际产出
tmux ls                                       # 确认 session 存在
```

**不要 trust** commhub last_seen_at / "ping 我没回"。误报本身就消耗信任。

### 6.3 Vendor / API 配置必跑真 call

memory `feedback_vendor_verify_before_hardcode.md`：不许 byte-identical fabricated source，每个 vendor 跑通真 API 才 hardcode。

---

## 7. 防错与规范（硬规矩）

| 规矩 | 来源 memory |
|---|---|
| commit 不加 Co-Authored-By Claude | `feedback_no_claude_attribution.md` |
| npm publish 默认 preview 不 latest | `feedback_release_preview_first.md` |
| **preview 版本号只涨 `-preview.N` 后缀，不要升 patch 重置 preview.0** | `feedback_preview_version_increment_rule.md` |
| 升 latest 严格两阶段 + 30min 等待 | `feedback_npm_publish_two_phase.md` |
| 时间戳用北京时间 UTC+8 | `feedback_beijing_time.md` |
| docs ZH+EN 同 commit 同步 | `feedback_docs_zh_en_parity.md` |
| issue 评论引用用 markdown link | `feedback_github_clickable_refs.md` |
| Telegram reply 默 MarkdownV2 | `feedback_telegram_markdown_v2.md` |
| commit 前查 branch | `feedback_docs_loop_branch_check.md` |
| 不在生产 hub 跑测试 | `feedback_no_test_on_prod.md` |
| 不访问生产数据库 | `feedback_no_prod_db_access.md` |
| commit/push 在 main 直接 push | `feedback_push_workflow.md` |
| internal task vs GitHub issue 编号空间独立 | `feedback_internal_vs_github_tasks.md` |
| **公开渠道(issue/PR/docs/截图)不写真实 hub 域名,一律 `<hub-domain>` 占位** | Vincent 2026-06-11 tg 752;同 token/私IP/路径禁令一族 |

### 7.1 Preview 版本号规则（重要，OSS-facing）

**只涨 `-preview.N` 后缀的 N，不要每次都升 patch 然后重置 preview.0**。

✅ 对：`2.3.6-preview.0 → 2.3.6-preview.1 → 2.3.6-preview.2 → ...` →（promote latest）→ `2.3.7-preview.0`
❌ 错：每次 fix 升 patch 重置 `2.3.4-preview.0 → 2.3.5-preview.0 → 2.3.6-preview.0`

每次 publish 前先 `npm view <pkg> dist-tags --json` 看当前 preview 是 `X.Y.Z-preview.N`，下次 bump N+1 保持 X.Y.Z 不变。只有 promote 到 latest 之后才开新 patch 系列。

完整规则 + 反模式见 memory `feedback_preview_version_increment_rule.md`。

---

## 8. /loop 长期巡检模式

### 8.1 用法

`/loop <间隔> <prompt>` —— 注册一个 cron 周期性 fire，lead 自动巡检团队 / docs / issue。

- 启动方式：命令行敲 OR commhub 派给 agent 让它用 Skill 工具调用 loop skill 自启
- 周期推荐：60m 巡检 / 5m 紧密迭代 / 30m 中间
- recurring，7 天自动过期，CronDelete 取消

### 8.2 实际案例

- **通信龙巡检 loop**：cron `aa7c27cc`，60m，扫 issue/PR/成员 + 推进 + 回帖 #62
- **通信文档马 docs-loop**：cron `89a7267c`，60m，scan docs + issue #10 文档迭代 + 回帖 #10
- **N站马 dash-loop**：5m，TopoGraph 持续打磨 + ship preview + 回帖 #116

### 8.3 每轮规则

每个 loop 选定一个 issue 作为「滚动追踪器」，每轮把 round 结果回帖该 issue。round 评论末尾贴三目标 + 流程节奏区块（memory `feedback_round_rules_in_comment.md`）。

---

## 9. 节点生命周期（运维相关）

### 9.1 起节点

```bash
cd <project workdir>
anet node create <alias> --runtime claude-code-cli   # 或 codex-sdk
tmux new-session -d -s <alias> "anet node start <alias>"
```

新建节点 default runtime = `codex-sdk`（memory `feedback_new_node_codex_default.md`）。

### 9.2 机器重启 / 批量恢复

**#115 已 ship**（agent-network 2.1.13+）：`anet node create --resume <session-id>` flags + 消除 Claude resume 交互 prompt（CLAUDE_CODE_RESUME_THRESHOLD_MINUTES env 注入），从此 `anet node start` 零交互。

**#117 进行中（P1）**：`anet project restart` 一键重启项目所有节点。

恢复期间 lead 必做：
1. 起完节点后 `commhub_get_all_status` 确认 online 数
2. 任何"卡 prompt"判断前必 `tmux capture-pane` 看真实 pane（不 trust banner false-match）
3. 状态汇总通知 Vincent

### 9.3 删 / 改名节点

- `anet node delete <alias> --force`：删节点（要 --force confirm）
- `anet node rename`：跨 server/client 2PC，看 RFC-010；purely-created 节点有 bug 见 #110

---

## 10. 常见反模式（已踩过的坑）

### 10.1 误报 incident

看到 commhub last_seen_at stale → 立即 alert Vincent 「全网 SSE 中断」 → 实查 hub log agents 都活着。
**正解**：先 capture-pane + hub log 实查再下结论。

### 10.2 等 Vincent 答细节卡死任务

owner dark + lead 不 default-dispatch + 干等 → 任务挂数小时。
**正解**：可逆 + 团队内 → 自己 reassign。

### 10.3 ship 后不验 URL

agent 说"docs 已 ship URL 返回新内容" → lead 信了 ack → 实测 URL 404。
**正解**：lead trust-but-verify，curl HTTP/2 200 才 ack。

### 10.4 重复开 issue

不 dedup search → 开 issue → 跟现有 N 个 overlap → 后期合并/关掉很乱。
**正解**：先 `gh issue list --search`，有 overlap 评论 / sub-task。

### 10.5 piecemeal 修同一坨问题

Vincent 报"拓扑图丑" → 一边开 #112 修一处一边开 #113 修一处 → 反复 ship 反复有问题。
**正解**：升级成 umbrella + 系统性 pass + 一个 preview 一起 ship。

### 10.6 别名冲突

新建节点未查老服务器是否有同 alias → commhub 同名注册冲突 → 消息路由乱。
**正解**：建节点前 `commhub_get_all_status` 搜同名。

### 10.7 命令行假阳性 grep

判断 agent 卡 prompt 用 `grep 'development-channels'` → 匹配到了静态 banner 不是真 prompt → 误判全部 agent 卡住。
**正解**：grep 真 prompt 字符串（"Resume from summary" / "Enter to confirm"），不 grep 通用关键词。

---

## 11. 给新团队负责人的 Onboarding 清单

接手一个新团队（B站 / A站 / P站）lead 第一周做：

- [ ] 读完本 playbook 一遍
- [ ] `commhub_get_all_status` 摸清自己团队成员 alias + 状态
- [ ] 把团队成员 onboarding 一遍（角色定位 + 工作目录 + 协作通道）
- [ ] 找一个起手 issue 拆解成第一批任务派下去
- [ ] 设个 loop（5m / 30m / 60m）持续推进
- [ ] 每轮把 round 结果回帖到团队的总 issue
- [ ] 阻塞 / 大决策第一时间 surface 通信龙 或 Vincent

---

## 12. 反馈

本 playbook 不是教条 —— 团队跑出新模式 / 发现盲点欢迎反馈：
- commhub 发 通信龙 `commhub_send_task(alias="通信龙", task="playbook 反馈：…")`
- 或直接 PR `docs/team-collab-playbook.md`

---

*维护：通信龙 · 团队：anet*
*相关 memory：见 `/home/vansin/.claude/projects/-home-vansin-agent-orchestra/memory/MEMORY.md`*
