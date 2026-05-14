# 社会舆论实验室 Demo

`anet demo opinion-spread` 是 anet 内置的*社会学批量实验* demo（[issue #72](https://github.com/sleep2agi/agent-network/issues/72) Phase 1 scaffold，跟[sci-team Phase 1](./sci-team.md) 同款 preset wrapper pattern，预计 v2.1.8 后续 preview ship）：CLI 批量创建 1 名*主持人* + N 个分两阵营的*陈述者*（默认 25 支持 / 25 反对），主持人 LLM 自主驱动多 round fan-out — 让两个阵营反复陈述、阅读他人观点、判断是否动摇立场，最终输出一份立场动态 markdown summary。

::: warning Phase 1 scaffold
当前 Phase 1 只 ship*脚手架*：批量创建 N+1 个 agent + 两阵营 system prompt + lifecycle 命令。主持人的 round-by-round fan-out / 立场动摇统计 / 最终 markdown summary 由主持人*自身 LLM 自主决策驱动*（active fan-out 模式，跟 sci-team Phase 2 [9e206aa](https://github.com/sleep2agi/agent-network/commit/9e206aa) 同款），不是 CLI 硬编码的 round 调度器。round 数 + 终止条件 + 阶段 prompt 全在主持人 systemPrompt 里描述，由 LLM 自主执行。
:::

## 一句话跑

```bash
# 默认 50 worker + 1 主持人，AI 监管议题
anet demo opinion-spread --topic "AI 监管"

# 小规模快速演示（10 worker → 5 支持 + 5 反对 + 1 主持人 = 11 agent）
anet demo opinion-spread --count 10 --topic "远程办公"

# 大规模实验（50 worker）+ 自定义议题
anet demo opinion-spread --count 50 --topic "全民基本收入应当立法实施"
```

需要先 `anet login` 到 hub，并准备书生 (Intern) API Key：

```bash
export INTERN_API_KEY=sk-...
# 申请：https://chat.intern-ai.org.cn/
```

## 角色

| 角色 alias | 数量 | 阵营 | 职责 |
|------------|------|------|------|
| `主持人` | 1 | — | 议题主持 + 多 round 派 task + 阅读全员 reply + 输出最终 markdown summary |
| `支持1号` .. `支持N号` | N/2 | 支持 | 坚定支持议题立场，每 round 陈述论据、阅读他人 reply、判断是否动摇 |
| `反对1号` .. `反对N号` | N/2 | 反对 | 同上，反向立场 |

奇数 worker 总数时（如 `--count 11`），反对阵营吸收多余 1 人（11 worker → 5 支持 + 6 反对）。

## 编排时序

跟 sci-team Phase 2 active fan-out 同款 — 主持人 LLM 自主驱动，CLI 只负责创建 / 启动 / 关停：

```
[CLI]  1. 批量创建 N+1 个 agent (per-node 独立 cwd + ntok_ + Intern preset)
[CLI]  2. 启动 N+1 个 tmux session
[CLI]  3. 派初始 task 给主持人："开始议题「<topic>」的舆论实验"
[主持人] 4. Round 1 — 用 commhub_send_task 并发派 50 个 task
                       └─ 支持阵营: "用 ~50 字陈述你支持「<topic>」的核心论据"
                       └─ 反对阵营: "用 ~50 字陈述你反对「<topic>」的核心论据"
[Workers] 5. 各自 commhub_reply 回 50 个 reply
[主持人] 6. commhub_get_inbox 收齐 50 reply → 整合为 round 1 全员立场 summary
[主持人] 7. Round 2 — 派 50 个 task，body 附 round 1 summary：
                       └─ "看完所有人 round 1 reply，重新陈述 + 回应反方关键论据（~80 字），如立场动摇明确说"我立场动摇""
[Workers] 8. 各自 reply
[主持人] 9. 继续 round 3 .. round K（自主决定 K，建议 3-5）
[主持人] 10. 终止判断 — 立场动摇 <10% 或 round = K 时收敛
[主持人] 11. commhub_send_reply 给用户：markdown summary（见下）
[CLI]  12. （可选）`anet batch stop opinion-spread` 清理 51 个 tmux session
```

## CLI 参数

::: info wire 状态
以下参数表是 Phase 1 contract 设计。Phase 1 实际 ship 时由 [`demoOpinionSpreadCommand()`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) 提供（属于通信工程马 surface，跟本 demo 的 prompt / 议题 preset / 测试一起在同一 joint PR 落地）。
:::

| Flag | 默认 | 说明 |
|------|------|------|
| `--count <N>` | 50 | worker 总数（不含主持人），自动 split 两阵营，clamp 到 `[10, 100]` |
| `--topic <text>` | — | 议题字符串。可直接传，也可走 wizard 从 preset 选 |
| `--direction <key>` | — | preset 议题 key（见下表），跳过 wizard 选项 |
| `--dir <path>` | `~/opinion-s` | 工作目录（每个 node 一个子目录 `node{i}/`） |
| `--intern-api <key>` | `$INTERN_API_KEY` | 书生 API key |
| `--stop` / `--restart` / `--cleanup` | — | 等价 `anet batch <verb> opinion-spread` |

议题 preset（CLI wizard 默认列表）：

| `--direction` | label | topic |
|---------------|-------|-------|
| `ai-regulation` | AI 监管 | AI 监管 (是否应该立法限制大模型训练 / 推理用途) |
| `work-996` | 996 工作制 | 996 工作制 (科技公司是否应该执行 9am-9pm × 6 day 工作制) |
| `remote-work` | 远程办公 | 远程办公 (公司是否应该长期 default 远程而非回办公室) |
| `ubi` | 全民基本收入 | 全民基本收入 / UBI (政府是否应该给每个公民发放无条件月度补贴) |
| `gmo-food` | GMO 食品 | GMO 食品 (转基因食品是否应该被广泛允许商业化) |
| `nuclear-power` | 核电 | 核电 (是否应该扩大民用核电站规模以替代煤电) |
| `ev-mandate` | 全面电动化 | 全面电动化 (是否应该立法 2035 年前禁售燃油车) |
| `custom` | 自定义 | wizard 再问议题字符串 |

## 主持人最终输出 markdown 结构

主持人 round 收敛后用 `commhub_send_reply` 给用户回一份 markdown，结构由主持人 systemPrompt 描述（LLM 应当遵守，但 LLM 输出非确定性，结构可能小幅偏移）：

```markdown
# 议题: <topic>

## 实验设置
- worker N 人 (支持 N/2 + 反对 N/2)
- 共 K round

## Round-by-round 立场动态
- Round 1: 支持 X 人持论 / 反对 Y 人持论 / 主要论据 cluster 概要
- Round 2: ...
- Round K: ...

## 各阵营关键论据
### 支持阵营
- 论据 A (出现频次, 引述某号 alias 原句)
- 论据 B ...

### 反对阵营
- 论据 C ...
- 论据 D ...

## 立场动摇人数 (初 → 末)
- 支持阵营: 25 → 22 (-3 动摇)
- 反对阵营: 25 → 24 (-1 动摇)

## 结论摘要
<3-5 句话总结实验现象>
```

## 控制台输出节奏

```
[anet] 创建社会舆论实验室:
        工作目录:  /home/u/opinion-s
        Worker 总数: 50 (支持 25 + 反对 25)
        议题:       AI 监管 (是否应该立法限制大模型训练 / 推理用途)
        Runtime:    claude-agent-sdk + intern-s1-pro

[anet] ✓ 主持人 (alias=主持人) 创建 + ntok_ 完成
[anet] ✓ 支持1号 .. 支持25号 创建 + ntok_ 完成
[anet] ✓ 反对1号 .. 反对25号 创建 + ntok_ 完成
[anet] ✓ 启动 51 个 tmux session

[anet] 🏁 社会舆论实验室 ready.
        Dashboard:    anet hub dashboard
        派任务:       commhub_send_task --alias 主持人 --task "开始议题「AI 监管」的舆论实验"
        Phase 1 note: 主持人 LLM 自主决策 round 数 + 阶段 prompt + 终止条件
        Stop:         anet batch stop opinion-spread
        Cleanup:      anet batch cleanup opinion-spread --workdir /home/u/opinion-s
```

## Network 隔离

`anet demo opinion-spread` 复用 anet 通用 network 模型：

- 默认登录已有 admin（`admin/anethub`）则用其默认 network
- 想隔离开销可在跑 demo 前 `anet network create opinion-experiment-$(date +%s)` 再 `anet network switch`
- 51 个 ntok_ 全部 register 到当前 network，跟其他 demo（sci-team / pr-review）独立

## 故障排查

| 现象 | 可能原因 | 排查 |
|------|----------|------|
| `[anet] 需要 Intern API key` | `--intern-api` / `$INTERN_API_KEY` 都没设 | `export INTERN_API_KEY=sk-...` 或加 `--intern-api` flag |
| `自动登录失败: invalid credentials` | hub 已改密 admin/anethub 默认密码 | 先 `anet login` 手动登录再跑 demo |
| `worker count clamped to [10, 100]` 提示 | `--count` 超出区间 | 选 `[10, 100]` 之间的数；< 10 立场动态太稀疏，> 100 资源吃紧 |
| 主持人 round 卡住不前进 | LLM 没自主 fan-out，可能 echo 占位 | 看 `anet hub dashboard` 的 task 流；如卡住可派给主持人一条 task "继续 round N" 兜底 |
| 部分 worker 不 reply | 单节点 token 失效 / 进程挂 | `tmux ls` 看 51 个 session 是否齐；不齐 `anet batch restart opinion-spread` |
| `批量 ntok_ 创建慢` | 51 次串行 register 网络抖 | 等几十秒；如长时间不动检查 hub 是否健康 |

## 关联

- 设计 issue：[#72](https://github.com/sleep2agi/agent-network/issues/72)
- 同款 preset wrapper pattern：[sci-team Phase 1](./sci-team.md)
- 通用 N-node primitive：`anet create --batch` / `anet batch <verb>` (issue [#55](https://github.com/sleep2agi/agent-network/issues/55))
- Active fan-out 起源：sci-team Phase 2 [9e206aa](https://github.com/sleep2agi/agent-network/commit/9e206aa)
- Prompt 模块单元测试：[`tests/test33-opinion-spread/`](https://github.com/sleep2agi/agent-network/tree/main/tests/test33-opinion-spread)

## Phase 1 不做（明示）

- ❌ CLI 硬编码 round 调度器（主持人 LLM 自主驱动）
- ❌ 立场动摇 / 收敛指标自动计算（主持人 LLM 在 final summary 里报告）
- ❌ Dashboard 双阵营立场动态可视化（issue [#50](https://github.com/sleep2agi/agent-network/issues/50) N站马 后续可加）
- ❌ Worker 之间 cross-talk / peer review（主持人是唯一 fan-out 起点）
- ❌ 议题敏感度分级 / moderation guard（Phase 2 candidate）
