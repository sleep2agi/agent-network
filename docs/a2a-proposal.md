# Claude Code + A2A 协议接入方案

> 日期: 2026-04-03
> 状态: 调研完成，待 Vincent 确认

---

## 1. A2A 协议概览

A2A (Agent-to-Agent) 是 Google 发起、Linux Foundation 托管的开放协议，用于 Agent 之间的互操作。当前版本 v1.0.0。

### 1.1 核心概念

| 概念 | 说明 |
|------|------|
| **Agent Card** | Agent 的自我描述，托管在 `/.well-known/agent-card.json` |
| **Task** | 一次交互的生命周期（submitted → working → completed） |
| **Message** | Agent 间的对话消息，支持多轮 |
| **Artifact** | Task 的输出产物（文件、数据等） |
| **Push Notification** | Webhook 回调，异步通知 Task 状态变化 |

### 1.2 传输层

A2A 支持三种协议绑定，功能等价：

| 绑定 | 格式 | 流式 |
|------|------|------|
| JSON-RPC 2.0 over HTTP | `application/json` | SSE |
| gRPC over HTTP/2 | Protocol Buffers | gRPC streaming |
| HTTP+JSON (REST) | `application/json` | SSE |

### 1.3 核心操作

| 操作 | JSON-RPC 方法 | REST 端点 |
|------|-------------|-----------|
| 发送消息 | `SendMessage` | `POST /message:send` |
| 流式消息 | `SendStreamingMessage` | `POST /message:stream` |
| 查询 Task | `GetTask` | `GET /tasks/{id}` |
| 取消 Task | `CancelTask` | `POST /tasks/{id}:cancel` |
| 订阅 Task | `SubscribeToTask` | `POST /tasks/{id}:subscribe` |

### 1.4 Task 状态机

```
SUBMITTED → WORKING → COMPLETED
                   → FAILED
                   → CANCELED
            INPUT_REQUIRED (需要更多输入)
            AUTH_REQUIRED  (需要认证)
            REJECTED       (拒绝执行)
```

### 1.5 Agent Card 示例

```json
{
  "name": "CommHub Agent Gateway",
  "description": "Agent Orchestra 的 A2A 网关，连接 15+ AI Agent",
  "supportedInterfaces": [
    {"url": "https://agent.example.com/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
  ],
  "version": "1.0.0",
  "capabilities": { "streaming": true, "pushNotifications": true },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "code-review",
      "name": "Code Review Agent",
      "description": "审查代码变更，发现安全/性能/架构问题",
      "tags": ["code", "review", "security"]
    }
  ]
}
```

---

## 2. A2A vs MCP：互补关系

| 维度 | A2A | MCP |
|------|-----|-----|
| **定位** | Agent ↔ Agent 协作 | Model ↔ Tool 集成 |
| **交互模型** | 多轮、有状态、不透明 | 无状态函数调用 |
| **发现机制** | Agent Card (well-known URI) | Tool manifest |
| **任务管理** | 完整生命周期 | 无（请求/响应） |
| **提出者** | Google (Linux Foundation) | Anthropic |

**Google 官方定位**：A2A 和 MCP 互补。Agent 内部用 MCP 连接工具，对外用 A2A 与其他 Agent 协作。

**对 CommHub 的意义**：CommHub 是内部调度协议（类 MCP），A2A 是对外暴露协议。两者不冲突。

---

## 3. Claude Code 的 A2A 现状

### 3.1 原生支持

**Claude Code 没有内置 A2A 支持。** 只支持 MCP（stdio/HTTP）和 Channel 协议。

### 3.2 社区桥接方案

| 项目 | 方式 | 成熟度 | 特点 |
|------|------|--------|------|
| `jcwatson11/claude-a2a` | 包装 Claude CLI 为 A2A Server | 最完整 | 支持 JSON-RPC + REST，含 MCP Client |
| `ericabouaf/claude-a2a` | 包装 Claude SDK 为 A2A Server | 早期 | 支持流式、Artifact |
| `dwmkerr/claude-code-agent` | 容器化 Claude Code A2A Agent | 生产级 | Docker/K8s/Helm 支持 |

### 3.3 可行的桥接路径

```
外部 A2A Client
      │
      │ A2A SendMessage
      ▼
┌─────────────────┐
│  A2A Gateway    │ ← 新建
│  (CommHub 上层) │
└────────┬────────┘
         │ CommHub send_task
         ▼
┌─────────────────┐
│  CommHub Server │ ← 已有
└────────┬────────┘
         │ SSE / Channel / Poller
         ▼
┌─────────────────┐
│  Claude Code    │
│  / MiniMax /    │
│  Codex sessions │
└─────────────────┘
```

---

## 4. Intern-S1 和 MiniMax 作为 A2A Agent 后端

### 4.1 模型能力对比

| 维度 | MiniMax M2.7 | Intern-S1 |
|------|-------------|-----------|
| **参数** | 10B 激活 | 22B 激活 (235B MoE) |
| **上下文** | 205K tokens | 32K (S1) / 256K (S1-Pro) |
| **Function Calling** | **原生支持** (OpenAI 格式) | 无文档支持 |
| **API 格式** | OpenAI + Anthropic 兼容 | OpenAI 兼容 |
| **API 端点** | `api.minimaxi.com/v1` | `chat.intern-ai.org.cn/api/v1` |
| **推理模式** | `<think>` 标签，强制开启 | `<think>` 标签，可配置 |
| **Agent 基准** | SWE-bench 78%, 技能遵循 97% | 科学推理 SOTA，Agent 未测 |
| **多模态** | 纯文本 | 视觉 + 文本 |
| **定价 (输入)** | ¥0.002/千 tokens | 免费/研究 tier |
| **定价 (输出)** | ¥0.008/千 tokens | 免费/研究 tier |
| **开源** | 否 | Apache 2.0 |
| **速度** | ~46 TPS | 取决于部署 |

### 4.2 Agent 适用性评估

**MiniMax M2.7 → 首选 Agent 后端**
- 原生 Function Calling，与 A2A 的 tool use 完美对接
- Agent 基准分数高（SWE-bench 78%，技能遵循 97%）
- 价格极低（Opus 的 1/50）
- Vincent 有大量额度

**Intern-S1 → 科学/分析专用 Agent**
- 科学推理能力强（化学、物理、生物、材料）
- 无原生 tool calling，需要 prompt 模拟
- 适合做"科学分析 Agent"，不适合通用 Agent
- 免费额度 + 开源自部署

### 4.3 推荐分工

| Agent 角色 | 后端模型 | 理由 |
|-----------|---------|------|
| 通用任务 Agent | MiniMax M2.7 | Function calling + 低价 + 长上下文 |
| 代码审查 Agent | MiniMax M2.7 | SWE-bench 78%，代码能力强 |
| 科学分析 Agent | Intern-S1 | 科学推理 SOTA |
| 论文解读 Agent | Intern-S1-Pro | 256K 上下文 + 多模态 |
| 复杂推理 Agent | Claude Opus | 最强推理，自循环 |

---

## 5. A2A Agent 搭建框架对比

### 5.1 框架选项

| 框架 | 代码量 | A2A 原生 | 多模型 | Tool Use | 推荐场景 |
|------|--------|---------|--------|----------|---------|
| **Pydantic AI** | **3-5 行** | `to_a2a()` | OpenAI 兼容 | 内置 | 最快原型 |
| **Google ADK** | 10-20 行 | `to_a2a()` | Gemini/Claude/OpenAI | 内置 | Google 生态 |
| **a2a-sdk** | 50-100 行 | 原生 | 任意（自己写） | 手动 | 完全控制 |
| **LangGraph** | 30-50 行 | Agent Server | LangChain 生态 | 内置 | 复杂工作流 |
| **自己写** | 200+ 行 | 手动实现 | 任意 | 手动 | 最大灵活性 |

### 5.2 推荐：Pydantic AI（最快路径）

3 行代码把 MiniMax 包装成 A2A Agent：

```python
from pydantic_ai import Agent

agent = Agent('openai:minimax-m2.7',
              instructions='你是一个代码审查 Agent',
              base_url='https://api.minimaxi.com/v1')
app = agent.to_a2a()
# 启动: uvicorn main:app --port 9999
```

自动暴露：
- `/.well-known/agent-card.json` — Agent Card
- `POST /` — JSON-RPC 端点（SendMessage 等）
- SSE 流式响应

### 5.3 备选：a2a-sdk（更多控制）

```python
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from openai import OpenAI

class MiniMaxExecutor:
    async def execute(self, ctx, event_bus):
        client = OpenAI(base_url="https://api.minimaxi.com/v1", api_key=KEY)
        response = client.chat.completions.create(
            model="minimax-m2.7",
            messages=[{"role": "user", "content": ctx.message.parts[0].text}],
            tools=ctx.tools,  # 透传 A2A 定义的 tools
        )
        event_bus.publish(text_event(response.choices[0].message.content))
        event_bus.finished()

server = A2AStarletteApplication(
    agent_card=agent_card,
    http_handler=DefaultRequestHandler(
        agent_executor=MiniMaxExecutor(),
        task_store=InMemoryTaskStore(),
    ),
)
```

---

## 6. CommHub + A2A 结合方案

### 6.1 架构定位

```
外部世界 (A2A 协议)          内部调度 (CommHub 协议)
─────────────────────       ─────────────────────
                            
  A2A Client ──────→ A2A Gateway ──────→ CommHub Server
  (其他公司的 Agent)   (新建)              (已有)
                        │                    │
                        │                    ├→ Claude Code (Channel)
                        │                    ├→ MiniMax (SSE Poller)
                        │                    └→ Codex (Proxy/Poller)
                        │
                        └→ 独立 A2A Agent
                           (MiniMax/Intern-S1 直连)
```

### 6.2 概念映射

| CommHub 概念 | A2A 等价物 |
|-------------|-----------|
| `commhub_send_task` | `SendMessage`（创建 Task） |
| `commhub_reply` | 后续 `SendMessage`（带 taskId） |
| `commhub_report_status` | `TaskStatusUpdateEvent` |
| Session alias | Agent Card `name` |
| CommHub Server | A2A Agent Registry |
| SSE Poller | A2A `SubscribeToTask` / Push Notification |

### 6.3 两种实施路径

**路径 A：CommHub 作为 A2A 网关（推荐）**

在 CommHub Server 上加一层 A2A 端点，把内部 sessions 对外暴露为 A2A Agent：

```
CommHub Server (:9200)
├── /mcp                    ← 已有，内部 MCP
├── /events/:alias          ← 已有，内部 SSE
├── /api/commhub/status     ← 已有，内部状态
├── /.well-known/agent-card.json  ← 新增，A2A 发现
├── /a2a/message:send       ← 新增，A2A 入口
└── /a2a/tasks/{id}         ← 新增，A2A Task 查询
```

外部 A2A Client 发 `SendMessage` → CommHub 翻译为 `send_task` → 内部 session 执行 → CommHub 翻译结果为 A2A `TaskStatusUpdate` → 返回。

优点：改动最小，复用已有基础设施。
缺点：所有请求走 CommHub，CommHub 成为瓶颈。

**路径 B：独立 A2A Agent（MiniMax/Intern-S1 直连）**

用 Pydantic AI 或 a2a-sdk 单独部署 A2A Agent，直连模型 API：

```bash
# 代码审查 Agent (MiniMax)
uvicorn code_review_agent:app --port 9901

# 科学分析 Agent (Intern-S1)
uvicorn science_agent:app --port 9902

# 通用助手 Agent (MiniMax)
uvicorn general_agent:app --port 9903
```

每个 Agent 独立暴露 Agent Card，外部可直接发现和调用。CommHub 负责内部调度这些 Agent。

优点：解耦，每个 Agent 独立扩展。
缺点：需要独立部署和管理多个服务。

### 6.4 推荐方案：A + B 混合

- **Claude Code sessions**：通过 CommHub A2A 网关暴露（路径 A），因为它们已有 CommHub 连接
- **MiniMax/Intern-S1 新 Agent**：独立部署 A2A Agent（路径 B），同时注册到 CommHub 做内部调度
- **CommHub**：既是内部调度中心，也是 A2A Agent 注册中心

---

## 7. 实施计划

### Phase 1：快速验证（1 天）

1. 用 Pydantic AI + MiniMax M2.7 搭一个 A2A Agent 原型
2. 用 A2A Inspector (`a2a-inspector`) 验证协议合规
3. 测试 Agent Card 发现 + SendMessage + Task 生命周期

### Phase 2：CommHub 网关（2 天）

1. CommHub Server 加 A2A 端点（agent-card + message:send + tasks）
2. 实现 CommHub task ↔ A2A Task 状态映射
3. 测试外部 A2A Client → CommHub → Claude Code 全链路

### Phase 3：多 Agent 部署（1 天）

1. 部署代码审查 Agent（MiniMax M2.7）
2. 部署科学分析 Agent（Intern-S1）
3. 注册到 CommHub，测试内部调度 + 外部 A2A 双通道

### Phase 4：生产化（持续）

1. 加认证（Agent Card 的 securitySchemes）
2. 加 Push Notification（webhook 回调）
3. 加监控和日志
4. 文档化所有 Agent Card

---

## 8. 风险与注意事项

1. **Intern-S1 无原生 Function Calling** — 需要 prompt 模拟或只做纯文本问答 Agent
2. **MiniMax 强制 thinking 模式** — 输出 token 约为普通模型 4x，成本需注意
3. **A2A 协议仍在演进** — v1.0.0 刚稳定，SDK 有 breaking changes 风险
4. **CommHub 单点** — A2A 网关模式下 CommHub 是关键路径，需要高可用
5. **认证** — A2A 支持 OpenID Connect / OAuth2 / API Key，需要选择方案
6. **MiniMax 有效上下文** — 标称 205K 但复杂任务实际可能 ~24K，需要测试
