# Grok Build CLI — 视频生成能力探测报告

> **任务来源**: #205 场景 2 — 让 grok-build runtime 节点能调 Grok CLI 的视频生成能力作为 anet 内置 capability。
> **关联 issue**: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#70](https://github.com/sleep2agi/agent-network/issues/70) · [#204](https://github.com/sleep2agi/agent-network/issues/204)
> **探测对象**: Grok Build CLI `0.1.220 (ae5f4af53)`,默认 `grok-build` model
> **探测方法**: 静态 surface scan + Vincent 现有 session 日志 (`~/.grok/sessions/.../updates.jsonl`) 真实调用解析 + 真实生成 artifact (`videos/1.mp4` 5.3MB) 文件系统检查。**未跑新 LLM** (避免消耗 xAI 配额 + 红线: 不本机生产 hub)。
> **作者**: 通信SDK马
> **日期**: 2026-05-28

## ⚠ Erratum (2026-05-28, post-SDK-deep-probe)

本报告原 verdict 框架是 "`video_gen` text-only / 不接 image input" 的隐含假设(`rawInput` 只列 `prompt` 字段, 没显式 `image_url` 等). **实证证伪**:

- **现实**: Grok backend 看 `prompt` 文本里有没有图片 URL — **有就自动路由到 `grok-imagine-video` 模型** (image-to-video pipeline), 没有走默认 text-to-video. **anet 0 LOC 改动**.
- **修正依据**:
  - SDK 实证 (commhub task `cd497384`) — prompt 含 Wikimedia public PNG URL, Grok video_gen `rawInput` 实际带 `duration` / `aspect_ratio` / `resolution` 多字段 (schema 没列, 但 backend 接受), 输出 mp4
  - ffmpeg 第 1 帧视觉验证 (`/tmp/p205-deep/frame-old.png` extract) 对得上 Wikimedia 测试图源 — image-to-video pipeline 工作 ✓
- **根因 banked**: 之前 probe 只看 `rawInput` schema (`prompt` 单字段), **没看 mp4 实际内容**. backend smarts > schema surface.
- **新场景**: scenarios/video-gen-marketing.md (ZH+EN) "Image-to-Video via prompt URL" section 文档化用法 + prompt tips + SDK 实证 JSON.

→ 后续 capability probe 都需 **content-level 验证** (ffmpeg / hash / visual diff), 不只 schema scan.

## TL;DR

**Grok CLI 原生支持视频生成**,通过 LLM 自主调用 **`video_gen` tool**。**调用入参极简** (`{prompt: <text>}`),**输出落本地文件** (`~/.grok/sessions/<sessId>/videos/N.mp4`)。Vincent 现有 session 已经生成过 12s / 5.3MB 的 anet 宣传片。anet 接入只需在 Grok 节点反代 LLM reply,**artifact 路径需要 anet runtime 帮转出来给用户/上游**(否则文件锁在 session-private 目录)。

## 关键发现

### 1. CLI 命令面 — 无 `grok video` 子命令

```bash
$ grok video --help
error: unrecognized subcommand 'video'

  tip: a similar subcommand exists: 'v'    # ← v 是 version,误导
```

→ **没有 user-facing CLI**。视频生成**只能在 agent runtime 内由 LLM 自主触发**。

### 2. 工具发现 — Vincent session 已有真实调用

从 `~/.grok/sessions/%2Fhome%2Fvansin/*/updates.jsonl`:

```
2 次 video_gen tool_call  →  2 个 .mp4 落本地
```

且 Grok agent 自报回复确认:
```
Video generated and saved to
/home/vansin/.grok/sessions/<sessId>/videos/1.mp4.
```

实测文件 size: **`-rw------- 1 vansin vansin 5.3M May 26 10:08 .../videos/1.mp4`**(12s 视频 ≈ 5.3MB,合理)。

### 3. `video_gen` 请求 / 响应 schema

#### 触发(`tool_call`)

```jsonc
{
  "sessionUpdate": "tool_call",
  "title": "video_gen",
  "rawInput": {
    "prompt": "<text prompt 完整,可几百~上千字>"
  }
}
```

→ **入参只有 `prompt`**。没有 duration / aspect_ratio / quality / model 等显式参数。Vincent 2 次调用都没传额外字段,但 Grok 生成出来的视频都是 ~12s,推测为后端默认值。

#### 完成回执(`tool_call_update` status="completed")

```jsonc
{
  "sessionUpdate": "tool_call_update",
  "status": "completed",
  "content": [{
    "type": "content",
    "content": {
      "type": "text",
      "text": "Video generated and saved to /home/vansin/.grok/sessions/<sessId>/videos/1.mp4."
    }
  }],
  "rawOutput": {
    "type": "Text",
    "text": "Video generated and saved to /home/vansin/.grok/sessions/<sessId>/videos/1.mp4."
  }
}
```

→ **输出格式 `type: "Text"`**(不是 `Image` / `Video` / `Artifact` 之类结构化类型)。**视频路径只在 plain text 里**,需要 anet 侧正则解析才能拿到文件位置。

#### Prompt 样本(Vincent 真实使用)

```
"Modern tech promotional video for \"Agent Network\" (anet.sh), a multi-agent
orchestration platform. Dark elegant background with neon blue and purple
accents. Show a central hub node spawning dozens of glowing AI agent nodes
that connect and collaborate in a network. CLI command 'npm install -g
@sleep2agi/agent-network' elegantly appears. Scenes of multiple specialized
agents (researcher, coder, analyst, writer) working together in parallel
on complex tasks. Smooth camera movement, professional cinematic lighting,
clean minimalist design. Text appears: '多 Agent，一行命令' and 'Agent
Network'. High-end production..."
```

→ 提示词支持**中英文混合**,**电影级形容词**生效,**短文案 overlay** 看起来支持(需 LLM 端到端验)。

### 4. 输出文件路径 — session-private

落点规则:
```
~/.grok/sessions/<URL-encoded cwd>/<session_uuid>/videos/<index>.mp4
```

- `<URL-encoded cwd>`: 例 `%2Fhome%2Fvansin` = `/home/vansin`(% 编码)
- `<session_uuid>`: Grok session id (`019e6205-...`),agent-node 持有 (`agent-node/src/cli.ts` `grokSessionId` const)
- `<index>`: 多视频递增 (1.mp4, 2.mp4, ...)

→ **路径是 session-private**,文件 mode 0600 (Vincent 实测)。anet 反代时**需要把文件抽到一个用户可访问的位置**(下面 4.2 节展开)。

### 5. Auth / 配额

- **Auth**: 复用 Grok CLI 登录态 (`grok login`)。无独立 xAI API key 要求。
- **配额**: 未观察到速率限制错误。**保守假设**:Grok 订阅套餐内有按月或按视频的额度,触发 rate-limit 时应该返回 `tool_call_update.status: "error"`。P3 follow-up: capture 真实 rate-limit 错误格式。
- **生成时间**: Vincent 的 session 中两次调用 prompt 较长但没记录 latency。**保守估**:10-60s 不等(类似 OpenAI sora-2 / Runway Gen-3 量级)。anet 接入要给 generous timeout (`GROK_ACP_TIMEOUT_MS` 已有默认 300s,够用)。

## 对 anet 接入的影响

### 接入难度 — **小** (一个 artifact-extraction helper)

Grok LLM 自己会调 `video_gen`,但 anet 当前**直接把 Grok 的自然语言 reply 发回 commhub** (sanitizeGrokCommhubLeak 后)。问题:用户看到的是「视频已保存到 .../1.mp4」字样,但用户**访问不到那个路径**(session-private,且可能在不同机器)。

需要 anet 在 `processWithGrok` 完成后:
1. **解析 reply text**,正则找 `/Video generated and saved to (.+\.mp4)/`
2. **把 mp4 复制 / 上传** 到一个用户可访问的位置:
   - 选项 A:复制到 `<anet-cwd>/.anet/nodes/<alias>/artifacts/<timestamp>-<n>.mp4`(per-node artifacts 目录)
   - 选项 B:上传到 commhub 自带的 attachment store(若 hub 支持)
   - 选项 C:仅返回 file:// path,让 commhub-server / dashboard 端代发
3. **改写 reply** 把 session-private 路径换成新位置 URL/路径

### 用户使用方式 — 自然语言 prompt 即可

```
admin → commhub_send_task(alias="grok-video", task="给 Agent Network 项目生成一段 12 秒的产品宣传视频,深色科技风,体现多 agent 协作")
```

Grok LLM 自主调 `video_gen`,anet 透传 + artifact 转出。

### 现有 anet 代码的 hook 位置

`agent-node/src/cli.ts processWithGrok`:
```ts
return sanitizeGrokCommhubLeak(result.replyText.trim() || "（无回复）");
```

→ 在 `sanitizeGrokCommhubLeak` 之后**加 artifact extraction hook**:
- 扫 `result.replyText` (或 result.state 里所有 tool_call_update content) 找 `videos/*.mp4` 引用
- 复制 / 转出 artifacts
- rewrite reply 路径

这是 **Step 2 (artifact pipeline 设计)** 的核心 LOC,**~30-50 LOC** 估计。

### 局限

1. **入参不可调**:看不到 duration / aspect_ratio / quality / seed flag。如要用户能指定 9:16 竖版给 TikTok,要么 (a) prompt 内强制 instruct LLM 加入 "竖版 9:16 视频" 然后看 Grok 后端会不会读 (不一定),或 (b) 等 xAI 公开 `video_gen` MCP server 自带 schema。
2. **不可结构化下载**:LLM 自然语言 reply 唯一拿路径方式。Grok 升级若改 reply 文案 ("Saved to X." → "Generated: X"),anet 正则要 follow。
3. **不可逐帧 stream**:工具是 atomic 的,生成完才返回路径,不能 stream 进度。LLM 处理期间 anet `report_status("working", ...)` 仍可发,但内容是黑盒。
4. **本机文件,跨机不可见**:节点机和接收消息的人不在同一机器时,path 没意义。**必须**靠 anet 转出 artifacts(选项 A/B/C)才能跨机可用。

## 建议(Step 2 设计输入)

### 2.1 artifact pipeline 设计(P1, Step 2 工程马 + SDK马 联合)

**推荐方案 A**(per-node artifacts 目录):
```
<anet-cwd>/.anet/nodes/<alias>/artifacts/2026-05-28T15-30-00Z-1.mp4
```
- 文件 owner = anet 用户(不是 -rw------- session-private)
- 用户/上游通过 anet 节点目录就能拿
- 跨机仍需手工 scp / rsync,但**比 session-private 好一倍**

加 P2 follow-up:把 mp4 base64 或者 URL 形式塞进 commhub message,让接收方直接拿到。

### 2.2 视频文件大小 / 数量监控

- 5.3MB / 12s 视频 ≈ 一段 26MB / 分钟
- 多 Grok 节点频繁生成会快速吃磁盘
- Step 2 加 P2 retention policy:`.anet/nodes/<alias>/artifacts/` 保留 N 天,旧文件自动清理

### 2.3 prompt 编写指南(P3 docs)

写一份 `docs/research/grok-video-gen-prompt-tips.md` 或 `docs-site/docs/guide/video-gen-prompts.md`:
- 用户怎么写 prompt 触发 Grok 调 video_gen(关键词 "generate video"、"video")
- 风格关键词(cinematic / minimalist / neon / 3D motion graphics ...)
- 中英文混合 OK
- 12s 是默认时长,目前无法显式延长

### 2.4 配额触发 fallback(P2)

若 `tool_call_update` 状态 = "error" 且文本含 "quota" / "rate limit",anet 应:
- WARN 到 agent log
- LLM 自然语言 reply 自动包含错误信息(透传即可)
- 不重试

## Surface Map 一图流

```
┌──────────────────────────────────────────────────────────┐
│  admin user → commhub_send_task(alias=grok-X, task=...)  │
│                                  │                       │
│                                  ↓                       │
│  agent-node (grok-build-acp runtime, #204 preview.7)     │
│                                  │                       │
│                                  ├─ ACP session/new      │
│                                  ↓                       │
│  Grok CLI subprocess (cwd = isolated)                    │
│                                  │                       │
│                                  ├─ LLM decides to       │
│                                  │   generate video      │
│                                  ↓                       │
│  video_gen tool (backend at xAI)                         │
│                                  │                       │
│   {prompt: "<text>"} ────────────│                       │
│                                  │                       │
│                                  ↓                       │
│   完成 ~10-60s 后,Grok 写文件:                            │
│   ~/.grok/sessions/.../videos/N.mp4 (mode 0600)          │
│                                  │                       │
│                                  ↓                       │
│  LLM reply: "Video saved to .../N.mp4"                   │
│                                  │                       │
│  ⚠ Step 2 hook 位置:                                     │
│   processWithGrok: extract path + 转出 artifact          │
│   (建议落 .anet/nodes/<alias>/artifacts/)                │
│                                  │                       │
│                                  ↓                       │
│  commhub_send_reply 回 admin (含 artifact 路径/URL)      │
└──────────────────────────────────────────────────────────┘
```

## 参考

- ACP fixture: [`docs/tests/fixtures/grok-build/acp-stdio.jsonl`](../../docs/tests/fixtures/grok-build/acp-stdio.jsonl)
- 姊妹报告: [`grok-x-search-capability-probe.md`](./grok-x-search-capability-probe.md)
- 上游 issue: [#205](https://github.com/sleep2agi/agent-network/issues/205) · [#70](https://github.com/sleep2agi/agent-network/issues/70)
- Vincent 真实视频生成 artifact 位置(本机 reference,不在 git): `~/.grok/sessions/%2Fhome%2Fvansin/019e6205-98b2-7fa3-8fc8-417f8c9b37ab/videos/1.mp4`
- #204 preview.7 修法(grok cwd 隔离,本探测的前置条件): [`72e28fd`](https://github.com/sleep2agi/agent-network/commit/72e28fd)

---

**Author-Agent**: 通信SDK马
