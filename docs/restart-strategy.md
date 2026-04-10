# 一键拉起/重启方案

> 状态：定稿 | 日期：2026-04-10 | 作者：SDK马 + 通信牛 review

**设计哲学**: best-effort 恢复。restart-all 基于 CommHub 记录 + 本地 .anet/ 配置尽力恢复，信息不完整的节点跳过并提示手动 start。

---

## 数据源

CommHub `/api/status` 提供辅助信息，**本地 .anet/nodes/ 配置仍是启动的主要依据**：

```json
{
  "alias": "I站运营马",
  "tmux_name": "intern-ai",
  "server": "iZrj93pr2rcf5r2y9uo1oyZ",
  "agent": "claude-code",
  "project_dir": "/home/vansin/intern-ai",
  "status": "offline"
}
```

关键字段：
- `agent`: `claude-code` / `agent-node:claude` / `agent-node:codex` → 决定启动命令
- `tmux_name`: tmux session 名 → 用于 tmux 拉起
- `project_dir`: 工作目录 → cd 进去再启动
- `server`: 机器名 → 本机/远程判断
- `status`: 判断是否需要重启

## anet restart-all

```bash
$ anet restart-all

从 CommHub 获取 session 列表...
  本机: iZrj93pr2rcf5r2y9uo1oyZ
  共 12 个 session，本机 8 个，远程 4 个

本机 offline 的 agent（需要重启）:
  1. I站运营马    claude-code      tmux:intern-ai     /home/vansin/intern-ai
  2. A站运营马    claude-code      tmux:ai-insight     /home/vansin/ai-insight
  3. B站牛        agent-node:codex (no tmux)           /home/vansin/blueleap

远程 offline 的 agent（跳过，需要 SSH）:
  4. 群星马       claude-code      192.168.1.3         /Users/vansin/intern-aip

确认重启本机 3 个 agent？(y/n): y

[1/3] I站运营马 (claude-code)
  → tmux new-session -d -s intern-ai -c /home/vansin/intern-ai "claude --resume ..."
  ✅ tmux session intern-ai 已创建

[2/3] A站运营马 (claude-code)
  → tmux new-session -d -s ai-insight -c /home/vansin/ai-insight "claude --resume ..."
  ✅ tmux session ai-insight 已创建

[3/3] B站牛 (agent-node:codex)
  → tmux new-session -d -s B站牛 -c /home/vansin/blueleap "agent-node --config ..."
  ✅ tmux session B站牛 已创建

健康检查 (等 10s)...
  ✅ I站运营马 → idle
  ✅ A站运营马 → idle
  ⏳ B站牛 → 还在连接中...
  ✅ B站牛 → idle

全部重启完成 ✅
```

## 按 agent 类型生成启动命令

### claude-code

```bash
tmux new-session -d -s {tmux_name} -c {project_dir} \
  "claude --dangerously-skip-permissions \
   --dangerously-load-development-channels server:commhub \
   --teammate-mode in-process \
   --resume {session} \
   -n {alias}"
```

### agent-node:claude / agent-node:codex

```bash
tmux new-session -d -s {tmux_name || alias} -c {project_dir} \
  "agent-node --config {project_dir}/.anet/nodes/{alias}/config.json --alias {alias}"
```

agent-node 从 config.json 读 runtime/model/session/channels 等，不需要额外参数。

### agent-node (SDK 类型，旧版)

```bash
tmux new-session -d -s {tmux_name || alias} -c {project_dir} \
  "bun sdk-agent.ts --alias {alias} --url {commhub_url}"
```

加上必要的 env vars（ANTHROPIC_BASE_URL 等）。

## 启动顺序

```
1. CommHub Server（如果本机部署）
   → tmux has-session -t commhub || tmux new-session -d -s commhub "commhub-server start"
   → 等 /health 返回 200

2. claude-code agents（先启动，因为它们是主要操作者）
   → 并行 tmux 拉起

3. agent-node agents（后启动）
   → 并行 tmux 拉起

4. 健康检查
   → 轮询 CommHub /api/status，等所有 agent 变 idle
   → 超时 30s 报 warning
```

## 健康检查

```typescript
async function waitHealthy(aliases: string[], timeoutMs = 30000) {
  const start = Date.now();
  const pending = new Set(aliases);
  
  while (pending.size > 0 && Date.now() - start < timeoutMs) {
    const status = await fetch(`${HUB}/api/status`).then(r => r.json());
    for (const s of status.sessions) {
      if (pending.has(s.alias) && s.status !== "offline") {
        pending.delete(s.alias);
        console.log(`  ✅ ${s.alias} → ${s.status}`);
      }
    }
    if (pending.size > 0) await sleep(2000);
  }
  
  for (const alias of pending) {
    console.log(`  ⚠ ${alias} → 未响应（超时）`);
  }
}
```

## 跨机器

### P0: 只重启本机

```bash
anet restart-all          # 只重启本机 agent
anet restart-all --local  # 同上（显式）
```

通过 `os.hostname()` 匹配 session 的 `server` 字段，只处理本机的。

### P1: 远程 SSH

```bash
anet restart-all --all    # 含远程
```

远程执行：
```bash
ssh {server} "cd {project_dir} && tmux new-session -d -s {tmux_name} ..."
```

需要：
- SSH 免密（pubkey auth）
- 远程机器有 claude/agent-node/codex 等依赖
- CommHub session 记录了 server hostname/IP

### P2: Dashboard 按钮

前端调 `POST /api/restart` → CommHub Server 执行 tmux 命令。

只适合本机部署的 agent。远程需要 SSH agent 或 ansible。

## anet restart（单个）

```bash
anet restart 指挥室       # 重启单个
anet restart 指挥室 --new-session  # 重启并新建 session
```

## 和 anet start 的关系

| 命令 | 场景 |
|------|------|
| `anet start 指挥室` | 正常启动/resume 一个 node（需要 .anet/nodes/ 配置） |
| `anet restart 指挥室` | 基于本地配置 + CommHub 记录辅助恢复 |
| `anet restart-all` | 批量重启所有本机 offline agent |

关键区别：`restart` 批量恢复 offline agent（从本地 .anet/ 配置启动，CommHub 记录辅助筛选），`start` 启动单个 node。P0 只处理信息完整的节点（有 config.json + runtime + alias），缺少关键信息的跳过并提示手动 start。

`restart` 适合机器重启后恢复所有 agent，不需要一个个 cd 到项目目录去 start。

## 数据补充

CommHub session 记录可能缺少部分启动信息（比如 env vars）。建议：

1. agent-node 注册时上报 config 路径：`config_path: ".anet/nodes/xxx/config.json"`
2. claude-code 注册时上报 channels 和 session ID
3. restart 时从这些信息重建命令

如果信息不够，fallback 到 anet start：
```
[anet] 无法重建 I站运营马 的启动命令（缺少 session ID）
[anet] 请手动: cd /home/vansin/intern-ai && anet start I站运营马
```

## 决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | P0 只本机 | 跨机器 SSH 复杂度高 |
| 2 | 从 CommHub 数据重建命令 | 不依赖本地配置，机器重启后也能恢复 |
| 3 | tmux 拉起 | 和现有部署方式一致 |
| 4 | 先 server 后 agent | 确保通信基础设施就绪 |
| 5 | 健康检查 30s 超时 | 不无限等 |
| 6 | 信息不够时 fallback 提示 | 不猜测，让用户手动 |

---

**请通信牛 review。文件路径: ~/agent-orchestra/docs/restart-strategy.md**
