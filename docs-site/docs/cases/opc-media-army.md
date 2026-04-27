# OPC 自媒体 AI 军团

真实生产案例：一个人指挥 10 个 Agent，覆盖自媒体全链路——从热点发现到推文发布。

**Agent 数量**：10  
**模型**：MiniMax + DeepSeek + Claude  
**场景**：公众号/知乎/Twitter 内容生产

## 效果

```
[热点猎手] 发现热点：OpenAI 发布 GPT-6
    ↓
[数据采集] + [竞品分析] 并行采集素材（30 秒）
    ↓
[主笔] 写出 1500 字初稿（2 分钟）
    ↓
[标题党] 出 5 个标题备选
    ↓
[事实核查] + [敏感审查] 并行 Review（1 分钟）
    ↓
[排版渲染] 公众号格式 + [配图师] 封面图 + [PPT制作] 要点幻灯片
    ↓
→ Vincent 手机收到通知，一键审批发布
全程 < 10 分钟
```

## 架构

```
                    ┌───────────┐
                    │  Vincent  │
                    │ (Telegram)│
                    └─────┬─────┘
                          │ 审批
                    ┌─────┴─────┐
                    │  指挥室    │
                    └─────┬─────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
     ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
     │ 采集组   │    │ 生产组   │    │ 审核组   │
     └────┬────┘    └────┬────┘    └────┬────┘
          │               │               │
    ┌─────┼─────┐    ┌────┼────┐    ┌────┼────┐
    │     │     │    │    │    │    │    │    │
  热点  数据  竞品  主笔 标题  配图  核查 敏感  排版
  猎手  采集  分析       党   师        审查  渲染
                                            │
                                          PPT
                                          制作
```

## 10 个 Agent 角色

### 采集组（低成本，并行）

| Agent | 模型 | 职责 | 成本/次 |
|-------|------|------|--------|
| 热点猎手 | MiniMax | 监控微博热搜/知乎热榜/Twitter Trending | ~¥0.01 |
| 数据采集员 | DeepSeek | 抓取相关数据、论文、报告 | ~¥0.02 |
| 竞品分析员 | MiniMax | 看同行怎么写这个话题 | ~¥0.01 |

### 生产组（核心产出）

| Agent | 模型 | 职责 | 成本/次 |
|-------|------|------|--------|
| 主笔 | MiniMax | 写正文初稿 1500 字 | ~¥0.05 |
| 标题党 | MiniMax | 出 5 个标题备选 | ~¥0.01 |
| 配图师 | MiniMax | 生成/搜索配图、封面 | ~¥0.02 |

### 审核组（质量把关）

| Agent | 模型 | 职责 | 成本/次 |
|-------|------|------|--------|
| 事实核查员 | Claude | 数据准确性、引用核查 | ~¥0.50 |
| 敏感词审查 | MiniMax | 违规/政治敏感内容过滤 | ~¥0.01 |
| 排版渲染 | MiniMax | 公众号格式+样式 | ~¥0.02 |

### 输出组

| Agent | 模型 | 职责 | 成本/次 |
|-------|------|------|--------|
| PPT 制作 | DeepSeek | 同步出要点幻灯片 | ~¥0.03 |

**总成本：每篇推文约 ¥0.7**（传统外包一篇 ¥500+）

## 工作流

### Phase 1：发现热点（自动）

```
热点猎手每 10 分钟扫一次热搜
→ 发现新热点
→ 自动通知指挥室
→ 指挥室判断是否值得写
→ 值得 → 触发全流程
```

### Phase 2：采集素材（30 秒，并行）

```
指挥室同时派发：
→ 数据采集员：搜集 5-10 篇相关内容
→ 竞品分析员：看同行怎么写
→ 两个结果汇总给主笔
```

### Phase 3：内容生产（2 分钟）

```
主笔收到素材 → 写 1500 字初稿
→ 标题党收到初稿 → 出 5 个标题
→ 配图师收到初稿 → 搜索/生成配图
```

### Phase 4：审核（1 分钟，并行）

```
指挥室同时派发：
→ 事实核查员：检查数据、引用
→ 敏感词审查：检查违规内容
→ 审核通过 → 进入排版
→ 审核不通过 → 打回主笔修改
```

### Phase 5：输出（并行）

```
→ 排版渲染：公众号格式
→ PPT 制作：要点幻灯片
→ 通知 Vincent 审批
```

## 搭建步骤

### 1. 创建所有 Agent

```bash
# 采集组（MiniMax，成本极低）
anet node create 热点猎手 --runtime claude-agent-sdk
anet node create 数据采集 --runtime claude-agent-sdk
anet node create 竞品分析 --runtime claude-agent-sdk

# 生产组
anet node create 主笔 --runtime claude-agent-sdk
anet node create 标题党 --runtime claude-agent-sdk
anet node create 配图师 --runtime claude-agent-sdk

# 审核组（核查用 Claude，其他用 MiniMax）
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create 事实核查 --runtime claude-agent-sdk --model claude-sonnet-4-6
anet node create 敏感审查 --runtime claude-agent-sdk
anet node create 排版渲染 --runtime claude-agent-sdk

# 输出组
anet node create PPT制作 --runtime claude-agent-sdk
```

### 2. 全部启动

```bash
for agent in 热点猎手 数据采集 竞品分析 主笔 标题党 配图师 事实核查 敏感审查 排版渲染 PPT制作; do
  anet node start $agent
done
```

### 3. 通过 Telegram 触发

在 Telegram 给指挥室发：
```
写一篇关于 GPT-6 发布的热点推文
```

指挥室自动编排 10 个 Agent 协作，10 分钟内出稿。

## 为什么用混合模型

| 环节 | 用 Claude（贵） | 用 MiniMax/DeepSeek（便宜） |
|------|:-:|:-:|
| 采集 | | ✓ 不需要强推理 |
| 写作 | | ✓ 中文写作能力足够 |
| 核查 | ✓ 需要强推理验证事实 | |
| 审查 | | ✓ 模式匹配够用 |
| 排版 | | ✓ 模板化操作 |

关键环节用强模型，其余用便宜模型，**成本降低 90%**。

## 下一步

- [混合模型协作](/cases/mixed-model) -- 了解混合编队原理
- [军团编队](/cases/telegram-squad) -- Docker 编排 11 容器
- [多模型配置](/guide/multi-model) -- 各种模型怎么配
