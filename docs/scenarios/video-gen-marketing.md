# 视频生成 — anet × Grok Build 营销视频场景

> **场景目标**: 给 anet 加 grok-build-acp runtime 节点的 **视频生成 capability**,作为 [#205](https://github.com/sleep2agi/agent-network/issues/205) 优雅支持的两大场景之一([#70](https://github.com/sleep2agi/agent-network/issues/70))。
> **现状**: Step 2 artifact pipeline 实现已 ship。
> **owner**: 通信工程马(release ops)+ 通信SDK马(agent-node 主笔)

## 一句话

把 Grok 自带的 `video_gen` 工具(session-private mp4 落本地)接到 anet, 让任何节点能通过 commhub 派任务给 grok-build 节点生成营销视频, 视频文件**自动 extract 到 per-node artifacts 目录**, 接收方/上游能直接拿到路径。

## 给用户看的简单路径

### 起一个 grok 节点

```bash
# 1. 全局只做一次: 给 grok 登录(浏览器 OAuth)
grok login

# 2. 在你的项目 cwd 起 anet 节点
anet node create grok-marketing --runtime grok-build-acp
anet node start grok-marketing
```

> 前置: `@sleep2agi/agent-node` >= `2.4.7-preview.7`(包含 #204 isolated cwd + #205 Step 2 artifact extractor)。

### 派一条生成任务

来自任意 anet 节点(claude / codex / grok / 人):

```
commhub_send_task(
  alias="grok-marketing",
  task="给 Agent Network 项目生成一段 12 秒产品宣传视频,
        深色科技风,体现多 agent 协作,中文 overlay '多 Agent,一行命令'"
)
```

grok-marketing 节点收到任务 → Grok LLM 自主调 `video_gen` 工具 → 生成完落到 grok session 私有目录 → **agent-node 自动 copy 到 `<cwd>/.anet/nodes/grok-marketing/artifacts/<timestamp>-1.mp4`(mode 0644)** → reply 文本附带 trailer:

```
[LLM 自然语言总结]
我已经按你的要求生成了一段视频...

📹 视频已生成 / Video artifact(s):
  - /home/user/project/.anet/nodes/grok-marketing/artifacts/2026-05-28T15-30-00Z-1.mp4  (5.30 MB)
```

接收方/上游打开那个绝对路径即可。

## 内部实现

### post-turn 扫描(不是 fs.watch)

设计在 `agent-node/src/grok-artifact-extractor.ts` 内的 pure helper `extractGrokArtifacts()`,在 `processWithGrok` 的 `runOnce` 完成后**一次性扫**:

```ts
// agent-node/src/cli.ts processWithGrok runOnce 完成后
const extracted = extractGrokArtifacts({
  nodeKey: NODE_ID || ALIAS,
  userCwd: process.cwd(),
  grokSessionDir: `~/.grok/sessions/${encodeURIComponent(grokCwd)}/${grokSessionId}`,
});
replyText += formatArtifactTrailer(extracted.artifacts);
```

理由(post-turn vs fs.watch):
- **race-free**: Grok turn 完成 → mp4 已 fsync 完整,没有 partial-write
- **atomic**: 一次性扫整个 videos/,不需要 dedup 复杂逻辑
- **deterministic**: 跟 LLM reply 同步触发,不会丢/不会重

### 文件路径约定

| 类型 | 路径 |
|---|---|
| Grok 原始 session 视频(mode 0600, 私有) | `~/.grok/sessions/<URL-encoded cwd>/<sessId>/videos/N.mp4` |
| anet artifact 副本(mode 0644, 用户可读) | `<cwd>/.anet/nodes/<NODE_ID>/artifacts/<isoTs>-<originalName>.mp4` |

跟 anet 现有 `logs/` / `goals.json` 同 convention,**cwd-relative + per-NODE_ID**, 跨项目自然隔离。

### 幂等 + 去重

- 同 turn 重跑(timestamp 同 frozen): dst 文件名 deterministic + `existsSync` 跳过,**0 重复 copy**
- 跨 turn(skipSrc 集合由 caller 持有): Step 2 已 expose `skipSrc?: ReadonlySet<string>` 形参; **当前 cli.ts 集成未维护 cross-turn 集合**(每 turn 重新扫,但 Grok 自己每次 turn 写新 N.mp4 文件名递增,deterministic dst 自动去重)。**P3 follow-up**: 把已 extract src 记到 node persistent state 减少重复 readdir 开销。

### 失败模式

| 失败 | 行为 |
|---|---|
| `grokSessionDir` 未知(session 没起来) | `extractGrokArtifacts` 返回 `{ artifacts: [], ready: false, error: "no grokSessionDir" }`,reply 正常返回不附 trailer |
| videos/ dir 不存在(本 turn 没生成视频) | `ready: true, artifacts: []`,reply 正常返回不附 trailer |
| 目标 dir mkdir 失败(权限/磁盘) | `ready: false, error: "mkdir artifacts dir failed: ..."`,cli.ts `warn()` 但不阻塞 reply |
| 单个文件 statSync/copyFileSync 失败(broken symlink/race) | 跳过该 entry 继续循环,**不阻塞其他成功的 artifact** |
| 整体 extractor 抛(import 失败等) | `cli.ts` 顶层 try/catch + warn,reply 保留原文(无 trailer) |

**核心保证**: 任何 #205 Step 2 错误**绝不**阻塞 Grok turn 的正常返回。Grok LLM 完成了任务、reply 已经在,artifact extract 是 **best-effort 增强**。

## 当前限制 + 后续 follow-up

| ID | 类型 | 描述 | Owner |
|---|---|---|---|
| P2 | feature | base64 / upload-URL 把视频塞 commhub message,跨机自动可见 | 工程马 + 通信牛(hub 端 attachment store)|
| P2 | retention | `<cwd>/.anet/nodes/<NODE_ID>/artifacts/` 留 N 天自动清理,防磁盘吃满 | 工程马 |
| P3 | feature | 扩展非视频 artifact (image / gif / audio); kind 字段已 typed support | SDK马 |
| P3 | docs | `grok-video-gen-prompt-tips.md` — 用户怎么写 prompt 触发 + 风格关键词 | 文档马 |
| P3 | feature | commhub `send_reply` MCP schema 扩 `meta_json` 参数,机读 artifact descriptor 走结构化 | 通信牛 + SDK马 |
| P3 | perf | per-node persistent `extracted_src` set,减少重复 readdir | SDK马 |

## 探测来源 + 参考

- [Grok video_gen capability probe (ZH)](../research/grok-video-gen-capability-probe.md)
- [Grok video_gen capability probe (EN)](../research/grok-video-gen-capability-probe.en.md)
- [Grok X-search 姊妹场景](../research/grok-x-search-capability-probe.md) — 不需要 anet 侧补能, 零代码自然 work
- [#204 preview.7 isolated cwd 修法](https://github.com/sleep2agi/agent-network/commit/72e28fd) — 本场景前置(无 cwd 隔离会跑 stale `.mcp.json`)
- Vincent 现有 session 真实 artifact(本机 only,不在 git): `~/.grok/sessions/%2Fhome%2Fvansin/019e6205-98b2-7fa3-8fc8-417f8c9b37ab/videos/1.mp4`(5.3MB / 12s anet 宣传视频)

---

**Author-Agent**: 通信SDK马
