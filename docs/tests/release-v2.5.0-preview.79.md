# agent-node 2.5.0-preview.79

`.78` 之后 `agent-node/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| 0b0a1d87 | #1961 | grok-build-acp:把 `config.model` 传给 ACP 子进程,并在会话回报的模型不一致时 fail-closed(#1958) |

## 本版修的是什么

此前 grok-build-acp 运行时起的是裸 `grok agent stdio`:`config.model` 不进 argv,`session/new`/`session/load`/`session/prompt` 都不带模型,也从不调 `session/set_model`。于是 hub 显示的是配置里的模型,会话实际跑的是 CLI/已存会话的默认模型——合作团队实测:配置 4.7,同一会话前几轮 4.7、之后全是 4.6,hub 看不出来。

真机探 grok 1.0.5 的 ACP(见 #1961):`-m <model>` 只改 CLI 级默认(`_x.ai/models/update`),`session/new`/`load` 仍回旧模型;未知 `-m` 被**静默忽略**;真正切换要 `session/set_model {sessionId, modelId}`,回 `{"_meta":{"model":{"Ok":"…"}}}` + `model_changed` 通知,未知 id 回 `-32602 unknown model id`。

**改法**:argv 带 `-m <model>`;每次 `session/new|load` 之后调 `session/set_model` 并等 set 之后的 `model_changed`(或 `Ok` 值)等于 `config.model`,否则在任何 prompt 之前抛 `GrokModelMismatchError`,把请求的和实际的 id 都打出来;`-32602` 原样上抛不重试;CLI 不支持 `set_model`(`-32601`)时退化为只带 argv 并在 stderr 说明;没配模型则 `modelSource:"default"`。`report_status`/注册上报的 `model` 改为**实际生效**的模型,`config_snapshot` 多两个键 `model_effective`/`model_source`(`snapshot.model` 不变,RFC-024 的内容匹配不受影响)。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.79
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.105 @sleep2agi/agent-node@2.5.0-preview.79
```

🔴 **两个包要一起升。** 配对是精确的(`.105 ↔ .79`)。

## 证据

- grok-build-acp 套件 43 → 49,连续 4 次 49/49。见证:origin/main 上新测试在 import 处失败;变异「argv 永不带 -m」→ 3 红;变异「不问会话、直接信请求的 id」→ 4 红;恢复后全绿。
- 第一版有个竞态(回读拿到了 set 之前的 `model_changed`)被套件抓出来,用变更计数器修掉。
- typecheck 棘轮 81 = 基线;doc symbol/source pins rc=0。

## 未覆盖(明写)

- 没在真实节点上跑过一整个 turn(只跑了 stdio 探针);发出后由合作团队在他们 4.7 节点上验证。
- 账号不支持所配模型时(`grok models` 只列 4.6/4.5),本版会**拒起并打印 CLI 报的 id**——这是预期,不是回退。
- hub/dashboard 尚未展示 `model_effective`/`model_source`;`model` 字段在第一个 turn 后即更新。

## promote 时的 must_contain

`"version": "2.5.0-preview.79"`
