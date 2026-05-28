# 视频生成 — anet × Grok Build 营销视频场景

> **场景目标**: 给 anet 加 grok-build-acp runtime 节点的 **视频生成 capability**, 作为 [#205](https://github.com/sleep2agi/agent-network/issues/205) 优雅支持的两大场景之一([#70](https://github.com/sleep2agi/agent-network/issues/70))。
> **当前 scope**: 同机直读路径(Vincent 6420 directive)。跨机分发是 P2 follow-up。
> **owner**: 通信工程马(release ops)+ 通信SDK马(agent-node 主笔)

## 一句话

把 Grok 自带的 `video_gen` 工具接到 anet:让任何节点能通过 commhub 派任务给 grok-build 节点生成视频, anet 不动 mp4 文件本身, 只把 **Grok session-private 路径** 暴露在 reply 里, **同机的人 / agent 直接 `cat` / `open` 文件即可**。

## 给用户看的简单路径

### 起一个 grok 节点

```bash
# 1. 全局只做一次: 给 grok 登录(浏览器 OAuth)
grok login

# 2. 在你的项目 cwd 起 anet 节点
anet node create grok-marketing --runtime grok-build-acp
anet node start grok-marketing
```

> 前置: `@sleep2agi/agent-node` 包含 [#204 isolated cwd](https://github.com/sleep2agi/agent-network/commit/72e28fd) + [#205 Step 2](https://github.com/sleep2agi/agent-network/commit/09009a3)(本场景),也就是 `2.4.7-preview.7` 及之后。

### 派一条生成任务

来自任意 anet 节点 (claude / codex / grok / 人):

```
commhub_send_task(
  alias="grok-marketing",
  task="给 Agent Network 项目生成一段 12 秒产品宣传视频,
        深色科技风,体现多 agent 协作,中文 overlay '多 Agent,一行命令'"
)
```

grok-marketing 收到任务 → Grok LLM 自主调 `video_gen` 工具 → 视频写到 Grok session 私有目录 → **agent-node 不动文件,但在 reply text 末尾 surface 路径**:

```
[LLM 自然语言总结]
我已经按你的要求生成了一段视频...

📹 视频文件 / Video file(s):
  - /home/user/.grok/sessions/<encoded-cwd>/<sessId>/videos/1.mp4
```

**同机用户**(SSH 在 grok 节点机器上的人 / agent)直接 `cat` / `open` 那个路径即可。

## 跨机分发(P2 follow-up,本 scope 不含)

如果接收方/上游不在同一台机器,这个绝对路径无意义。当前**不解决**。预留 follow-up issue:
- 选项 A: agent-node 在 reply 之前把 mp4 base64 / multipart 塞 commhub message
- 选项 B: 上传到 commhub 自带的 attachment store(需要 hub 端能力)
- 选项 C: scp / rsync 用户脚本(零代码)

需求触发后再做。

## 内部实现

### post-turn path surface(纯只读)

设计在 `agent-node/src/grok-artifact-extractor.ts` 的 pure helper `listGrokVideoArtifacts(grokSessionDir?)`,返回 session 下 `videos/*.mp4` 的绝对路径列表:

```ts
// agent-node/src/cli.ts processWithGrok runOnce 完成后
const sessionDir =
  homedir() + "/.grok/sessions/" + encodeURIComponent(grokCwd) + "/" + result.sessionId;
const paths = listGrokVideoArtifacts(sessionDir);
const trailer = formatVideoTrailer(paths, replyText);
if (trailer) replyText += "\n" + trailer;
```

**零 fs 写**(无 cp / chmod / mkdir)。仅 readdir 一次,失败 silent fallback `[]`。

### `formatVideoTrailer` 智能去重

如果 LLM 自己在 reply 里已经 mention 了路径(常见,Grok 的 `video_gen` 工具会在自然语言总结里说 "Video saved to ..."),trailer **自动跳过** 那些已存在的路径。**避免双重 mention**。如果所有路径都已在 reply 内,trailer 为空(不 append)。

### 路径约定(只读,不创建)

| 类型 | 路径 |
|---|---|
| Grok 原始 session 视频(mode 0600, 私有) | `~/.grok/sessions/<URL-encoded cwd>/<sessId>/videos/N.mp4` |
| anet 不创建任何复制文件 | (Vincent 6420: "不用管吧生成哪就哪") |

跟 anet 现有 `logs/` / `goals.json` 不同 — 那些是 anet 自己的状态;视频文件归 Grok 管,anet 只 surface。

### Failure modes

| 失败 | 行为 |
|---|---|
| `result.sessionId` 缺失(session 没起) | sessionDir 为 undefined → list 返 `[]` → 无 trailer,reply 正常 |
| `videos/` dir 不存在(本 turn 没生成) | list 返 `[]` → 无 trailer,reply 正常 |
| readdir 报错(权限 / 文件不是 dir) | list 返 `[]` (try/catch 静默)→ 无 trailer,reply 正常 |
| extractor 整体抛(import 失败等) | cli.ts 顶层 try/catch + warn,reply 保留原文 |

**核心保证**: 任何 #205 Step 2 错误**绝不**阻塞 Grok turn 的正常返回。

## 限制 + follow-up

| ID | 类型 | 描述 | 推荐 Owner |
|---|---|---|---|
| **P2** | feature | **跨机 artifact 分发** (mp4 base64 / hub attachment / scp 脚本) | 工程马 + 通信牛 |
| P3 | feature | 扩展非视频 artifact (image / gif / audio) | SDK马 |
| P3 | docs | `grok-video-gen-prompt-tips.md` — 用户怎么写 prompt 触发 + 风格关键词 | 文档马 |
| P3 | feature | commhub `send_reply` MCP schema 扩 `meta_json` 参数,机读 artifact descriptor | 通信牛 + SDK马 |

## 探测来源 + 参考

- [Grok video_gen capability probe (ZH)](../research/grok-video-gen-capability-probe.md)
- [Grok video_gen capability probe (EN)](../research/grok-video-gen-capability-probe.en.md)
- [Grok X-search 姊妹场景](../research/grok-x-search-capability-probe.md) — 零 anet 代码自然 work
- [#204 preview.7 isolated cwd](https://github.com/sleep2agi/agent-network/commit/72e28fd) — 本场景前置
- Vincent 现有 session 真实 artifact(本机 only,不在 git): `~/.grok/sessions/%2Fhome%2Fvansin/019e6205-98b2-7fa3-8fc8-417f8c9b37ab/videos/1.mp4`(5.3MB / 12s anet 宣传视频)

---

**Author-Agent**: 通信SDK马
