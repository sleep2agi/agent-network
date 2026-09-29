# agent-node 2.5.0-preview.92

`.91` 之后 `agent-node/` 只有一个提交（`files: ["dist", "README.md"]`，改动在 `src/` → 打进 `dist/cli.js`）：

| 提交 | PR | 内容 |
|---|---|---|
| 92c5b3b5 | #2102 | codex 节点在大线程上的 resume / 重连修复。bridge 的每个 `thread/resume`（启动和绑定 TUI 线程）都带 `excludeTurns: true`；找进行中 / 刚结束的回合改为只读状态的 `thread/read {includeTurns:false}`，加一页 `thread/turns/list`（最新 10 个回合），不再用 `thread/read {includeTurns:true}` 把整条历史塞进一帧。以前在长寿命线程上，Node 24 / Node 20 + undici 会在 resume 途中以 `codex app-server closed (code=1006)` 断开，之后每个任务都失败并报 `CodexAppServerClient not connected` |

不新增运行时依赖。

## 适用范围

- 🔴 **codex ≥0.151 才生效**。codex ≤0.150 对 `excludeTurns` 和 `thread/turns/list` 回 `-32600 … requires experimentalApi capability`；bridge 只在这个拒绝上退回旧调用（每个 bridge 一次），超时从不退回。所以旧 codex 的行为和 `.91` 完全一样，不会更差。
- 实测（真 codex app-server，节点侧 bridge 在 Node 24.19.0 下运行，合成 691 MB / 8,005 回合线程）：`.91` 的 resume 以 1006 断开（codex 0.155.1 和 0.153.4 都是）；`.92` 在约 0.1–1 s 内完成 resume，`turn/start` 正常，任务回复在约 0.3 s 内到达。完整数据见 #2102 的评论。

## 配置

**不需要改配置。** 对比 `.85`（`c17e547f`）与本版：没有删除或改名的配置键，本版也没有新增。`.85` 以来新读的键都是可选的，并且有默认值（`default_workdir_root`、`flags.timeout` / `flags.opencodeTimeoutMs`、环境变量 `ANET_QUEUE_TIMEOUT_MS` / `ANET_CODEX_RESUME_TIMEOUT_MS`）。所以 `.85` 或 `.88` 上的节点可以直接用原来的 `config.json` 指向新构建（`node …/dist/cli.js --config …`）。

行为提示（不是兼容性破坏）：从 `.89`（#2008）起，**opencode** 节点如果配置里已经设了 `flags.timeout`，这个值也会被当作 opencode 的任务期限。`.85` 和 `.88` 都早于 `.89`，所以两者都会遇到这个变化。codex 节点不受影响。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.92
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.119 @sleep2agi/agent-node@2.5.0-preview.92
```

节点要重启到新构建上才生效。hub 和 codex 都不用改。
- 🔴 **两个包要一起升**（`agent-network@2.3.0-preview.119 ↔ agent-node@2.5.0-preview.92`）。

## 证据

- #2102：`codex-app-server-bridge.test.ts` 56 pass；新增 6 条断言「发出去的帧」（resume 带 `excludeTurns:true`、没有任何 `includeTurns:true` 读、每次只读一页有界的 `thread/turns/list`、旧版 codex 的拒绝只退回一次、超时不降级），其中 5 条在修复前的 main 上是红的。test586 / test588 的变异仍然全红。
- 协议实测：codex 0.133.0 / 0.144.0 / 0.148.0 / 0.150.0 拒绝；0.151.0 / 0.152.0 / 0.153.4 / 0.155.1 接受。

## promote 时的 must_contain

`"version": "2.5.0-preview.92"`
