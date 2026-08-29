# @sleep2agi/agent-node 2.5.0-preview.47 — release notes

这一版把 **daemon（host_supervisor）退回纯程序节点**：它不再为自由文本任务跑大模型
（PR #1418，关闭 #1417）。Vincent 定的优先级——先把守护进程核心做可靠、确定性、纯程序，
AI 操作保留不删、放后面、放客户端侧。

- daemon 收到自由文本 inbox 任务时，在 `processTask`（LLM turn）**之前**拦截，返回确定性
  回复（说明它只执行结构化生命周期命令，AI 请找 agent 节点）。`claude-agent-sdk` 是懒加载，
  短路即意味着 daemon 进程**不加载、不运行大模型**。
- goal 调度器同样按 role 门控（tick 实时 + boot 不武装），连热升级为 host_supervisor 的
  节点的存量 goal 也不再跑 LLM（独审 Finding 1）。
- 结构化门铃路径（create/stop/restart/delete/probe）**不变**，仍是纯程序。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.60 @sleep2agi/agent-node@2.5.0-preview.47
anet node create
```

🔴 **两个包都要装**（agent-node 单装时飞书桥静默降级）。

## Upgrade

```bash
npm install -g @sleep2agi/agent-node@2.5.0-preview.47
# daemon 重启即生效
anet daemon up
```

## 本版包含

- `1e442355` daemon 退回纯程序 + goal 调度器 role 门控（#1418，关 #1417）

## Verification

- 独立复核 A–F 全 PASS + Finding 1（goal 调度器未门控）已修
- `daemon-program-node.test` 含 witnessed-red（shape-match 变异→精确匹配用例变红）
- 含兄弟 daemon 套件本地 93 pass；CI 102/102 全绿
