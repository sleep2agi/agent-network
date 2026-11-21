# commhub-server 0.9.0-preview.290

Since `.289`

## Install

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.290
```

## Upgrade

```bash
bun add -g @sleep2agi/commhub-server@0.9.0-preview.290
# production: 装到新 runtime 目录 → 改 profile 的 HUB_RUNTIME_DIR → pm2 restart commhub-hub → 回读 /health
```

## What changed

```text
#3735  #4821 OpenCode V2 会话列表：Hub 侧请求通道
        · GET /api/nodes/:node_id/opencode-sessions?cursor=&limit=（用户令牌）
          同 node+cursor 60 秒内成功结果直接复用；否则建/复用一条 pending 请求
        · GET /api/session-requests/:request_id（创建者 / owner / admin）
        · MCP pull_session_requests / ack_session_request（节点令牌，daemon 绑定）
        · 部门范围沿用 #3665：节点不在你管理的子树 → 403 manage_scope_forbidden（不用 404）
#3736  #4821 daemon 侧接线 + 投影收口
        · daemon 回填的是 OpenCode **原始页**，投影只在 Hub 做一次（normalizeSessionPagePayload）
        · 形状不对 ⇒ ack 返回 bad_session_page，请求记 failed（不把「读不懂」存成空列表装成功）
```

## Verified

```text
· opencode-session-requests: 4 pass（TTL 复用 / 并发去重 / 拉走不可重复拿 / ack 幂等 / 原始页投影 / bad shape 拒绝 / 清理窗口）
· opencode-sessions-http: 2 pass（pending → ack → 轮询拿结果 → 二次走缓存；部门越界 403、owner 不受限）
· 发版后实测：/health 版本 + 两个端点 404/403 口径（上线后核对，未核对不写「已生效」）
```

## Not verified

```text
· 真机端到端：需要一台带共享 OpenCode server 的节点（daemon 侧需要 agent-node .213 / CLI .247）
· App 侧「新建节点时选已有 Session」的 UI 不在本版
```
