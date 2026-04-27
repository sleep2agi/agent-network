# 代码审查

两个 Agent 协作：一个写代码，一个做 Review，模拟真实开发流程。

**预计时间**：5 分钟  
**Agent 数量**：3（技术经理 + 开发 + 审查员）  
**模型**：Claude/DeepSeek + MiniMax

## 效果

```
你 → 技术经理: "写一个 Python 快速排序"
技术经理 → 开发: "实现快速排序"
开发 → 技术经理: "def quicksort(arr): ..."
技术经理 → 审查员: "Review 这段代码"
审查员 → 技术经理: "建议：加边界检查、用随机 pivot..."
技术经理 → 你: "代码已完成并通过 Review，附建议如下..."
```

## 步骤

### 1. 创建 Agent

```bash
# 技术经理（编排 + 决策）
anet node create 技术经理 --runtime claude-agent-sdk
# 选择 DeepSeek

# 开发（写代码）
anet node create 开发 --runtime claude-agent-sdk
# 选择 DeepSeek（代码能力强）

# 审查员（Review 代码）
anet node create 审查员 --runtime claude-agent-sdk
# 选择 MiniMax（成本低，分析能力够）
```

### 2. 启动

```bash
anet node start 技术经理
anet node start 开发
anet node start 审查员
```

### 3. 发任务

```bash
anet task send 技术经理 "请让开发写一个 Python 快速排序函数，写完后发给审查员做代码 Review，最后把代码和 Review 意见一起汇总给我。"
```

### 4. 查看流转

```bash
anet tasks
anet logs 技术经理
```

## 架构

```
         ┌──────────┐
         │    你     │
         └─────┬────┘
               │
               ▼
         ┌──────────┐
         │ 技术经理  │ ← 编排
         └─────┬────┘
               │
       ┌───────┴───────┐
       ▼               ▼
 ┌──────────┐    ┌──────────┐
 │   开发    │    │  审查员   │
 │(DeepSeek) │    │(MiniMax) │
 └──────────┘    └──────────┘
```

## 扩展玩法

- 加一个"测试员" Agent，开发完自动写测试
- 审查员发现问题后自动打回给开发修改
- 用 `codex-sdk` runtime 让开发真正执行代码

## 下一步

- [军团编队](/cases/telegram-squad) -- 1 指挥 + 10 兵的 Docker 编排
