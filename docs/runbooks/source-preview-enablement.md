# 打开/关闭「选已有项目或会话 / Fork 当前节点」这两条通道（preview 能力门）

适用：客户端上「新建节点 → 选已有项目 / 已有 Session」或「Fork 当前节点」显示**不可用**，
或者 Hub 侧返回 `source_directory_unavailable` / `source_fork_unavailable`。

这两条通道是 **preview 级**、**按 daemon 显式开启**的。UI 存在于 0.2.49x 起的客户端里，
但能力默认关闭 —— **“客户端有这个入口”不等于“这台 daemon 支持”**。

---

## 1. 判据：能力到底开没开

以 **daemon 行的 config_snapshot** 为准（Hub 的 `capable()` 就是读这里）：

```bash
sqlite3 ~/.commhub/commhub.db \
  "SELECT json_extract(config_snapshot,'$.daemon_capabilities')
   FROM nodes WHERE node_id='<daemon 的 node_id>';"
```

要看这五条（缺哪条就对应哪个入口不可用）：

```text
source_directory_read   选「已有项目 / 已有 Session」的目录读取
project_new_session     在已有项目里新建会话
session_attach          接管一个已有会话
source_node_delivery    投递子节点（Fork 的下半段）
source_fork_transport   Fork 当前节点（上半段）
```

⚠️ `/api/host-supervisors` 的投影**不带** `daemon_capabilities`（客户端也不读它，别拿它判断）。

---

## 2. 为什么“配置里写了却没生效”

agent-node 在**进程内部**把 `config.json` 的 `env` 合并进 `process.env`（`agent-node/src/cli.ts` 顶部）。
所以：

```text
· /proc/<pid>/environ 看不到这些变量 —— 那是进程**初始**环境，别用它判断
· 改完 config.json 的 env **必须重启该 daemon**，否则运行中的进程没有它们
```

这也是本文档存在的主要原因：2026-11-10 我先误判成“开关没配”，其实是“配置早就配了、进程比配置老”。

---

## 3. 开启（按 daemon）

写在 `<node dir>/config.json` 的 `env` 里（该 daemon 自己读，不需要动 systemd unit）：

```json
"env": {
  "ANET_SOURCE_DIRECTORY_PREVIEW": "1",
  "ANET_PROJECT_NEW_SESSION_PREVIEW": "1",
  "ANET_SESSION_ATTACH_PREVIEW": "1",
  "ANET_SOURCE_FORK_PREVIEW": "1"
}
```

分成两级，风险不是一个量级：

```text
只读级（先做这个）  ANET_SOURCE_DIRECTORY_PREVIEW / ANET_PROJECT_NEW_SESSION_PREVIEW / ANET_SESSION_ATTACH_PREVIEW
                    → 只是“读目录 / 接入已有会话”，不拉起新节点
拉起级（想清楚再开）ANET_SOURCE_FORK_PREVIEW
                    → 会给“子节点接管共享会话”开路
```

其他前置（不满足则不产生能力，且不报错）：

```text
role            = host_supervisor
platform        = linux
Hub URL         = https:// 或 http://127.0.0.1 这类环回地址（明文非环回会被拒，并只告警一次）
四条 transport  = 与 contracts 里的能力字符串逐字一致（config.json 里已有）
```

---

## 4. 重启与验证

```bash
# 1) 备份
cp <node dir>/config.json <node dir>/config.json.bak-$(date +%Y%m%d-%H%M%S)

# 2) 找到该 daemon 的 pid：父进程是 systemd --user，命令行带 --config <node dir>/config.json
pgrep -af "daemon-<name>/config.json"

# 3) 重启（保持同样的命令与 cwd；建议把输出重定向到 <node dir>/daemon-restart-<ts>.log）
kill -TERM <pid>; sleep 6
cd ~ && nohup bun <repo>/agent-node/src/cli.ts --config <node dir>/config.json >> <log> 2>&1 &

# 4) 看它自己 rebuild 了哪些子节点
tail -20 <log>        # 期望 [rebuild] done: total=N recovered=M missing=0

# 5) 回读能力（第 1 节的 SQL）——五条都在即成功
```

**影响面**：重启该 daemon 会一起重启它托管的节点。先查清托管了谁：

```bash
sqlite3 ~/.commhub/commhub.db \
  "SELECT count(*) FROM nodes WHERE json_extract(config_snapshot,'$.lifecycle_daemon_node_id')='<daemon node_id>';"
```

---

## 5. 端到端验证（这一步只能是人）

Hub 的目录接口要求**人类凭据**：节点令牌到不了能力判断那一层，只会拿到 400/403，
无法区分“能力没开”和“凭据不对”。

```text
1  客户端：新建节点 → 选这个 daemon 托管的节点 → 应列出项目/会话
2  或 curl（人类令牌）：
   POST /api/node-session-control/source/directory
   {"network_id":"...","source_node_id":"...","daemon_node_id":"..."}
   期望 200 + snapshot；404 = gate 未开放；409/不可用 = 能力仍未开
```

---

## 6. 回滚

```text
· 只回滚 fork：删掉 config.json env 里的 ANET_SOURCE_FORK_PREVIEW，重启该 daemon
· 全关：删掉四条，重启
· 配置改错：从 config.json.bak-<ts> 恢复后重启
```

---

## 7. 已知边界

```text
· 能力值是**每次上报现算**的，不是持久状态：改环境变量后必须重启才生效
· 明文非环回 Hub 会被显式拒绝，并在日志里 warning 一次（`[source-control] fork/directory preview disabled`）
· 这两条通道都在 preview 阶段，行为仍可能变；Fork 会产生真实子节点，别在正式节点上随手试
```
