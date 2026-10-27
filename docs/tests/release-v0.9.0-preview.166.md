# 0.9.0-preview.166

> 两处：**广播扇出不再把 Hub 打满**，以及**采纳失败时能看见真正的原因**。

## 1. 广播扇出分批（#2721 / PR #3087）

2026-10-27 07:10–07:15，我用一条广播把生产 Hub 打到：

```
07:11:16  stall   3.5s   served  145   rss  639MB
07:11:37  stall  20.0s   served  123   rss  979MB
07:14:01  stall 143.9s   served 1175   rss 2507MB
07:14:11  stall  10.0s   served  294   rss 2910MB
```

`requests_since_last_tick` 高达 1175 ⇒ 那是**饱和**（8 req/s 持续），不是阻塞。
一条广播 → 384 行 inbox（每行一次 autocommit INSERT）+ 收件 agent 随后 500+ 次调用。

改动：`broadcast`（MCP 与 REST 两条路径）改走 `enqueueBroadcast()`：

```
每 50 个收件人一个事务；批间 await 让出事件循环
384 次 autocommit → 8 次事务 + 8 次让出
```

隔离实测（独立 Hub + 200 收件人 + 1500 字广播）：`took=0.05s`，`event_loop` **0 次停顿**，`max_gap 277ms`。

**边界**：只削 Hub 侧入库；收件 agent 的反应仍会在广播后 3–5 分钟抬高调用量（那要等节点升级后的随机抖动，见 `#2720`）。

## 2. 采纳拒绝码保留真实分支（#1987 / PR #3088）—— **随 agent-node 发布，不在本包**

> ⚠️ 这一项改的是 `agent-node`（`src/runtime/adopt-daemon.ts`），**不在 `commhub-server` 的 tarball 里**。
> 本节的发布同步说明只表示「同一批改动」，实际生效需要升级节点。
> （发版脚本曾为它加了一条 server 侧探针，`.166` 因此白跑一轮校验 —— 已移除。）

现场：一个节点的采纳请求连续三次失败，前两次给出确切原因，第三次只有 `adopt_local_verification_failed`。
真实原因是 **`copresence_adopt_v2`**（copresence 节点按设计不允许被采纳）——被白名单正则的 `[a-z_]+` 吞掉了末尾的数字。

```
白名单基段 [a-z_]+ → [a-z0-9_]+
抽出 publicAdoptError()，仍是白名单，仍不泄露路径/OS 原文
```

**边界**：不改采纳策略（copresence 仍不可采纳），只让拒绝原因可读。

## Install

```bash
set -e
npm install -g @sleep2agi/commhub-server@0.9.0-preview.166
commhub-server --version   # 0.9.0-preview.166
```

## Upgrade

```bash
npm i -g @sleep2agi/commhub-server@0.9.0-preview.166
commhub-server --version   # 0.9.0-preview.166
curl -s http://127.0.0.1:9200/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["version"])'
```

版本化运行时目录（`HUB_RUNTIME_DIR`）：把依赖版本改成 `0.9.0-preview.166` 后 `npm install`，指到新目录再重启。

## 验收

```bash
# 1) 广播仍全员送达（条数不变），但入库分批：≥300 收件人时不再出现 >1s 的入库空转
#    观察 /health 的 event_loop.recent_stalls 里 requests_since_last_tick 的形态

# 2) 采纳被拒时能看见真名（需要一台 ≥.166 的 daemon）
#    对 copresence 节点发起 request_adopt_node → 期望 error = copresence_adopt_v2
```

回滚：把 `HUB_RUNTIME_DIR` 指回上一版目录并重启；无数据迁移。
