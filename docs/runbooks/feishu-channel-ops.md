# 飞书 Channel 运维 & 交接 Runbook

> **Owner**：2026-07-01 起，飞书 channel 的线上运维 + 后续开发归 **通信IM马**（IM 接入组）。本文是完整交接文档。
>
> **约定**：文中 `<...>` 为占位符，实例的具体值（真实 host 路径、app_id/secret、token）不写进公开仓库——它们在给 IM马 的交接消息里，或在部署机的 `runtime.env` / `access.json` 内。

---

## 0. TL;DR

飞书 bot = agent-node fork 一个 worker，用飞书 `@larksuiteoapi/node-sdk` 的 **WSClient 长连接**收事件，跑在 **claude-agent-sdk** runtime。当前生产实例（**as-of 2026-07-01 部署快照** — 生产真机版号请到部署机 `docker exec anet-feishu-local anet -v` 复核；本页 IM 运维交接后写死数已过期风险高）：

| 项 | 值 |
|---|---|
| 容器 | `anet-feishu-local`（docker，CMD 靠 entrypoint + `tail -f`） |
| 节点 alias | `TMWork小助手`（**唯一** feishu 连接；2026-07-01 从 `feishu-local` 改的，见 §12 rename history） |
| agent-network | `2.3.0-preview.17`（部署时值，含 #362 inbound file download + 官方 #324 图片修复；当前 preview 头 2026-08-17 快照为 `2.3.0-preview.39`，见 [`release-plan.md`](../plans/release-plan.md)） |
| agent-node | `2.5.0-preview.16`（部署时值；当前 preview 头 2026-08-17 快照为 `2.5.0-preview.31`） |
| 补丁 | **无**（跑官方发布版） |
| app | `<cli_...>`（TMWork小助手） |
| model | `MiniMax-M3`，endpoint `https://api.minimaxi.com/anthropic` |
| session | `<uuid>`（靠 `/root/.claude` 挂载持久化） |
| 已验证 | 文字 ✅ / 图片 ✅ / 群@ ✅ / persona ✅ / session 记忆 ✅ |
| ~~未做~~ | ~~inbound 文件下载~~ ✅ 2026-07-01 preview.17 修复（#362 / PR #364） |

---

## 1. 部署架构

### 1.1 进程结构
```
容器 anet-feishu-local
├─ tini → feishu-entrypoint.sh (PID 1)         # 镜像 entrypoint，容器启动跑 bring-up
│   └─ 自启一个默认节点 `feishu-agent`          # ⚠️ commhub-only，无 feishu channel，不竞争
├─ agent-node --alias TMWork小助手             # ← 真正的飞书 bot（手动 docker exec -d 起）
│   └─ fork worker.js（feishu WSClient 长连接） # 收事件 → IPC → think() → 回复
```
- `feishu-agent` 是 entrypoint 的默认产物，`channels: ["server:commhub"]`，**没有** feishu channel，**不会**抢 feishu 事件。别被它迷惑。
- `TMWork小助手` 是我们手动起的飞书 bot，是**唯一**连 feishu app 的连接。

### 1.2 三挂载（缺一不可）
| host（`<feishu-data-dir>/`） | 容器 | 作用 |
|---|---|---|
| `work` | `/work` | 节点配置 `.anet/nodes/TMWork小助手/`（config.json + channels/feishu/{.env,access.json}）、logs、SQLite |
| `claude` | `/root/.claude` | **claude-agent-sdk 对话历史** `projects/-work/<session>.jsonl` —— session 记忆，重建容器不丢 |
| `runtime.env` | `--env-file` | 密钥注入（不落进 agent 能读的 /work，安全） |

> **为什么要 `/root/.claude` 挂载**：session 是双依赖——`config.json` 的 `session` 只是 resume id（在 /work 已持久），真正的对话记录在 `/root/.claude/projects/`（默认在容器 home，不在 /work）。不挂 → 重建容器 → SDK 报 `No conversation found`、记忆清零。

### 1.3 消息流
```
飞书用户发消息
  → 飞书推 event（长连接）→ worker (im.message.receive_v1)
  → worker 归一化（文本/图片下载/文件名/@判定）+ 访问控制(access.json)
  → IPC → agent-node think()（claude-agent-sdk + MiniMax-M3）
  → 回复文本 → worker → 飞书 im.message.reply
```
- **图片**：worker 下载到 `/work/feishu-attachments/<conv>/<msgid>.jpg`，给 agent 一个 **Read 工具指针**，agent 自己 Read 图（新版方式，非 base64 多模态；~2 turns、慢一点属正常）。
- **文件**：⚠️ 当前**只传文件名没下载**（见 [#362](https://github.com/sleep2agi/agent-network/issues/362)）。

---

## 2. 数据 / 配置布局（host `<feishu-data-dir>/`）

```
<feishu-data-dir>/
├─ work/.anet/nodes/TMWork小助手/
│   ├─ config.json                 # runtime=claude-agent-sdk, model, session, flags, channels
│   ├─ channels/feishu/
│   │   ├─ .env                     # FEISHU_APP_ID / FEISHU_APP_SECRET（chmod 600）
│   │   └─ access.json              # allowFrom(open_id) / allowChats(chat_id) 白名单
│   └─ logs/
├─ work/feishu-attachments/<conv>/  # 收到的图片下载在这
├─ claude/                          # 挂 /root/.claude，session 记忆
└─ runtime.env                      # 密钥（--env-file，含全 8 var）+ 多个 .bak-*
```

**runtime.env 必含 8 个 var**：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANET_MODEL`、`HUB_URL`、`HUB_USER`、`HUB_PASSWORD`。

> 🔴 **model 名以 `config.json` 的 `model` 字段为准，不是 `ANET_MODEL` env**。换 vendor 时两处 + `ANTHROPIC_BASE_URL`/`AUTH_TOKEN` 必须对齐。

---

## 3. 运维流程

### 3.1 重启 TMWork小助手（🔴 只杀 TMWork小助手，别 kill 全部 agent-node）
```bash
# ❌ 别这么干：kill 全部 agent-node 会连 entrypoint 的 feishu-agent 一起杀 → 触发容器重启
# ✅ 只杀 TMWork小助手 的确切 PID：
docker exec anet-feishu-local sh -c '
  for pid in $(ps -eo pid,args | grep "[a]gent-node .*TMWork小助手\|[f]eishu/worker.js" | awk "{print \$1}"); do
    kill "$pid" 2>/dev/null; done'
sleep 3
docker exec -d anet-feishu-local sh -c \
  'cd /work && exec agent-node --config /work/.anet/nodes/TMWork小助手/config.json --alias TMWork小助手 >> /work/start.out 2>&1'
sleep 12
# 验证：workers=1 + client ready + session resume
docker exec anet-feishu-local sh -c 'grep -iE "client ready|bridge online|session:" /work/start.out | tail'
```
> 🔴 杀进程别用 `pkill -f "..."`，pattern 若字面出现在你自己的命令里会杀掉你自己的 shell（exit 137/144）。用 `ps -eo pid,args | grep <pat> | grep -v grep` 拿确切 PID 再 kill。

### 3.2 升级 agent-network / agent-node
```bash
# 先记版本 + 备份 config
docker exec anet-feishu-local sh -c 'cp /work/.anet/nodes/TMWork小助手/config.json /work/.anet/nodes/TMWork小助手/config.json.bak-preupgrade'
# 升级
docker exec anet-feishu-local sh -c 'npm i -g @sleep2agi/agent-network@preview @sleep2agi/agent-node@preview'
docker exec anet-feishu-local sh -c 'cat /usr/local/lib/node_modules/@sleep2agi/agent-network/package.json | grep -m1 version'
# 按 3.1 重启 TMWork小助手 + 逐项验证（文字/图片/群@/session）
```

### 3.3 换 app（🔴 必改三处，最容易漏 access.json）
飞书 `open_id`/`chat_id` **按 app 隔离**，换 app 后旧 ID 全失效。同步改：
1. `runtime.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（+ 重建容器烤进 env，或 --env-file）
2. `channels/feishu/.env`（worker 实际读这个）
3. **`channels/feishu/access.json` 的 `allowFrom`（用户新 open_id）/ `allowChats`（新 chat_id）** ← 最易漏
漏第 3 处症状：`client ready` 正常、有事件、但消息「没反应」，日志 `[feishu:audit] deny ... not in allowFrom`。

### 3.4 换 model
改 `config.json` 的 `model` + `runtime.env` 的 `ANTHROPIC_BASE_URL`/`AUTH_TOKEN`/`ANET_MODEL`（对齐），pop `config.json` 的 `session`（换 vendor 时），重启。MiniMax-M3 端点是 `https://api.minimaxi.com/anthropic`（不是 `api.minimax.chat`）。

### 3.5 白名单增删
```bash
anet channel allow feishu TMWork小助手 --add-from ou_<open_id>   # 加私聊人
anet channel allow feishu TMWork小助手 --add-chat oc_<chat_id>   # 加群
```
或直接改 `access.json`。**改完必重启节点**（access.json 不热加载）。`["*"]` = 放开所有。fail-closed：缺失/空/解析失败 = 全拒。

---

## 4. 🔴 运维红线

1. **重启只杀 TMWork小助手 的确切 PID**（别 kill 全部 agent-node → 碰 entrypoint → 容器重启）。
2. **三挂载**必须都在（/work + /root/.claude + --env-file）。
3. **换 app 必改三处**（env / .env / access.json 白名单）。
4. **不在 live 群/节点发 test/probe**（探测直调 REST 看返回码，不往真群发）。
5. **密钥只走 runtime.env（--env-file）**，不落进 /work（agent 有 Read/Bash 能读）。
6. **不清 session 字段**除非确诊 stale（`No conversation found` + in=0/out=0/cost=0）；空响应但 out>0/cost>0 是模型×网关不兼容，换 model 不清 session。
7. **`pkill -f` 别带命令里的串**（杀自己 shell）。

---

## 5. 故障排查决策树

**先找连接 / 鉴权错误和真实事件证据；`client ready`、`event-dispatch is ready`、`bridge online` 单独出现都不是成功线。**

- **A) `failed to obtain token` / `[ws] ws connect failed`** = 连接层未过。前者查凭证与 App 状态；后者查 `open.feishu.cn` HTTPS 和平台动态返回的 `wss://...` 目标是否被企业网 / DPI 拦截。即使同时有 `bridge online` 也不算成功。
- **B) 后台已识别测试连接但零事件** = app 侧事件订阅没配对。必须先保持客户端运行、再保存「使用长连接」，并检查 `im.message.receive_v1` / 已发布版本。
- **C) 已有真实事件、但不回** = 应用层拒了。**grep `deny`/`allowFrom`**：
  - `[feishu:audit] deny ... not in allowFrom` → 白名单（换 app 后最常见）。
  - `empty vendor result` → 模型生成了但抽不出文本（模型×网关不兼容），换 model。
  - `No conversation found` → session 失效，清 session 重启。
- **D) 发图回「没有可处理的内容」/ 找不到图** = 图片没抠出来：① `flags.modelImageCapable` 没开 ② 下载失败（旧版本 `downloadImage` SDK 误用 bug，已由 #324 修，升级根治）。grep `[feishu:image] download ok/FAILED`、看 media 目录有没有文件。
- **E) 发文件 agent 乱 find 找不到** = inbound 文件没下载（[#362](https://github.com/sleep2agi/agent-network/issues/362)，待修）。

**健康检查一行**：
```bash
docker exec anet-feishu-local sh -c 'echo "worker=$(ps -eo args|grep -c "[f]eishu/worker.js")"; grep -c deny /work/start.out'
docker inspect anet-feishu-local --format 'RestartCount={{.RestartCount}} Status={{.State.Status}}'
```

---

## 6. 本轮（2026-06-30 ~ 07-01）修的 bug 史

| 症状 | 根因 | 修复 |
|---|---|---|
| 换 app 后 bot 收到消息不回 | `access.json` 白名单存旧 app 的 open_id（open_id 按 app 隔离） | 加新 open_id 到 allowFrom（PR #358/#359 文档） |
| 模型回复端点不对 | `ANTHROPIC_BASE_URL` 设成 `api.minimax.chat` | 改 `api.minimaxi.com/anthropic` |
| 重建容器丢记忆 | `/root/.claude` 没持久化 | 加 `./claude:/root/.claude` 挂载（PR #360） |
| 发图回「没有可处理的内容」 | worker `downloadImage` 对 SDK 包装对象直接 `.on()`（`X.on is not a function`），被静默 `catch{return null}` 吞 | `resp.getReadableStream()` 取流（官方 [PR #324](https://github.com/sleep2agi/agent-network/pull/324)，升级到 preview.16 根治）（案例文档 PR #361） |
| 发文件 agent 找不到文件 | inbound 文件只传文件名没下载 | **待修 [#362](https://github.com/sleep2agi/agent-network/issues/362)** |

**沉淀的排障纪律**：① 不从症状跳根因，每个结论要有决定性日志/最小实验；② 静默 `catch{return null}` 是元凶级反模式，排查先给 catch 加日志让错误说话；③ 行为跟最新代码不符先疑版本漂移（`cat package.json version` vs `npm view @preview version`）；④ 决定性诊断可用 throwaway lark WSClient 探针独占连接（停 bot，多连接会抢事件）。

---

## 7. 待办 & 关联文档

- ~~[#362](https://github.com/sleep2agi/agent-network/issues/362) inbound 文件下载~~ — ✅ 2026-07-01 preview.17 修复（PR #364）。
- 用户文档（已上线 anet.sh）：
  - [飞书 channel 接入指南](../../docs-site/docs/guide/feishu.md)（Docker 一键 + 手动、模型后端、白名单、群@、故障排查）
  - [经典案例：飞书静默拒收 + 同源图片案例](../../docs-site/docs/troubleshooting/case-feishu-silent-deny.md)
- 设计：[RFC-020](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-020-im-platform-integration.md)（issue #179）。

---

## 12. Alias rename 历史

飞书节点 alias 曾变更过，历史请检索：

| 日期 (北京时间) | 从 | 到 | 原因 | 参考 |
|---|---|---|---|---|
| 2026-07-01 | `feishu-local` | `TMWork小助手` | Vincent 要求，跟飞书 bot 显示名一致，commhub/dashboard 更清楚 | 通信龙 dispatch ef4472c1；`anet node rename --force`（node_id `n_67b061b0` 保留，session `c14f65da...` 保留，rename txn `rtxn_672a242bb412445d929871b83009911b`） |

> ⚠️ 老的 log 记录 / 故障报告里可能还写 `feishu-local`，那是**当时的**别名，不是笔误。运维引用（重启 grep pattern、路径 `.anet/nodes/*`、CLI `--alias`）都已改到新名。
