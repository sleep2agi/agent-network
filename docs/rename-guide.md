# anet node rename — 完整使用指南

## 一句话

`anet node rename <旧名|node-id> <新名>` —— 在节点 workdir 内执行，跨 CLI / Server / Dashboard 3 surface 同步改名（RFC-010）。

---

## 各种情况清单

### ✅ Case 1 — 标准 live rename（**推荐路径**）

节点正在运行，alias 改名：

```bash
cd <项目 workdir>                # 例：cd /home/vansin/blueleap
anet node rename B站马 B站负责人
```

预期：
1. CLI 本地 `.anet/nodes/B站马/` → `.anet/nodes/B站负责人/`（目录改名）
2. Server commhub `sessions` 表 alias 字段更新
3. Server 推 SSE `node.renamed { old_alias, new_alias }` 事件
4. Dashboard 收到 SSE 自动更新展示
5. Running 进程的 socket 连接保留（不掉线）

**注意 tmux session 名不会自动改** —— 进程还在原 tmux session（名字还是旧的）。要 cosmetic 改名：
```bash
tmux rename-session -t B站马 B站负责人
```

### ✅ Case 2 — 停 → rename → 重启（保守路径）

```bash
tmux kill-session -t B站马
cd /home/vansin/blueleap
anet node rename B站马 B站负责人
tmux new-session -d -s B站负责人 "anet node start B站负责人"
```

适用：当 Case 1 报错 / 你想 100% 干净（无任何 in-flight 状态干扰）。

### ⚠️ Case 3 — Purely-created 节点（**已知 bug #110**）

```bash
anet node create 临时节点
anet node rename 临时节点 永久节点   # ❌ 会失败
```

根因：纯 create 没启动过的节点，server 端可能还没真注册，rename 找不到 record。**当前 workaround**：先 `anet node start` 跑一下再 rename，OR 等 #110 P2 fix。

### ⚠️ Case 4 — Alias 跨网络冲突

commhub 的 alias 是 `UNIQUE(network_id, alias)` —— **同 network 内 alias 唯一，跨 network 可重**。所以：
- 同 network 已有 `B站负责人` → rename 会冲突，报错
- 不同 network 已有 `B站负责人` → rename 可成功

### ⚠️ Case 5 — In-flight commhub 任务

rename 期间，**其他节点之前发到旧 alias 的 commhub send_task 消息可能 stale**：
- 已在 inbox 队列里的：消息保留（target session 标识用的是 session_id 不是 alias）
- rename 后**新**发的：用旧 alias 找不到 target → 投递失败

**建议**：rename 前通知协作方（如 N站马 给 B站马 派任务时，先停 5 分钟，rename 完再恢复）。

### ⚠️ Case 6 — 节点有活跃 Claude session

Claude 进程的 `--resume <session-id>` 是绑 session UUID，不绑 alias。所以 rename 不影响 session 本身。但：
- `tmux capture-pane` 看到的 banner / agent self-identity 还是旧 alias（agent 不知道自己被改名了）
- **agent 下次启动会用新 alias**（per #115 ship 后，`anet node start <新名>` 走 new alias）

要让 agent 知道自己被改名，发一条 commhub 通知：`通信龙 → 新名: "你已被 rename，原 alias xxx"`。

### ❌ Case 7 — Rename 失败 rollback

如果 rename 中途某步失败（CLI 改完目录但 server 没收到，或反过来），状态不一致：
- 现象：CLI `anet ls` 显示新 alias，dashboard 还显示旧
- 修复：手动 force sync — `anet node delete <旧 OR 新>` 把残留删了，重启节点

---

## 操作前 checklist（建议）

- [ ] 确认在节点 workdir 内（`pwd` 对应 `.anet/nodes/<alias>/` 父目录）
- [ ] 确认新 alias 在当前 network 没被占用（`anet ls` 查）
- [ ] 通知协作方（如果该节点有正在收发的 commhub task）
- [ ] 选 Case 1（live）或 Case 2（保守）路径
- [ ] rename 后 verify：
  - `anet ls` 显示新 alias
  - `commhub_get_all_status` 看 server 端是否切了
  - dashboard 刷新看节点是否显示新 alias
  - 协作方再发 send_task 用新 alias 是否到达

---

## 相关 issue / RFC

- **#84** [CLOSED] anet CLI node rename — RFC-level 方案 https://github.com/sleep2agi/agent-network/issues/84
- **#110** [OPEN P2] purely-created 节点 rename 失败 bug https://github.com/sleep2agi/agent-network/issues/110
- **RFC-010** Node Lifecycle 完整协议（创建/启动/停止/删除/**rename**/list/status 8 操作）docs/rfcs/RFC-010-node-lifecycle.md
- **#80** [CLOSED] Node lifecycle umbrella

---

## 已知坑总结

| 坑 | 严重度 | workaround |
|---|---|---|
| #110 purely-created 节点 rename 失败 | P2（明显） | 先 start 跑一下再 rename |
| tmux session 名不自动改 | 美观 | 手动 `tmux rename-session` |
| in-flight commhub task 投递失效 | 偶发 | rename 前通知协作方 |
| agent self-identity 还认旧 alias | 偶发 | commhub 通知 agent 改名了 |

---

*维护：通信龙 · per Vincent 4879 telegram 请求 · 2026-05-15*
