# `@sleep2agi/agent-network@2.3.0-preview.104`

`.103` 之后 `agent-network/` 一个提交:

| 提交 | PR | 内容 |
|---|---|---|
| dd31d59a | #1954 | `anet node codex fork` 补齐合作团队实测踩到的 5 个坑(#1951):`--workdir` 不存在自动创建;目标 `config.toml` 的 `[projects."<源工作区>"]` 表头改写到目标目录;`--model` 覆盖并在与源 rollout 末条 `turn_context` 模型不一致时打警告(provider 块不删);预探空闲端口写进目标 `codexAppServerPort`,`start`/`restart` 优先用它;`CODEX_HOME/AGENTS.md` 随 fork 走;receipt 新增 `fork_options` 证据块 |

配对不变:`PAIRED_AGENT_NODE_VERSION` 仍是 `agent-node@2.5.0-preview.78`(agent-node 本轮无改动)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.104
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.104 @sleep2agi/agent-node@2.5.0-preview.78
```

🔴 **两个包要一起升。** 配对是精确的(`.104 ↔ .78`)。

## 证据(真机 fork,2026-09-23 06:08 CST)

环境:DEV,本 PR 检出的 `bin/cli.ts` 直跑(`npx tsx`);**一次性 hub**(commhub-server 0.9.0-preview.55,临时 HOME + 临时 DB,随机端口)上注册一次性用户,不碰生产 hub。源节点 `fork-src-a` 用 `anet node create --runtime codex-app-server --copresence --model gpt-5` 建,CODEX_HOME 由手工合成(占位 `auth.json`、`config.toml` 带 `[projects."<源目录>"]` 与一个 provider 块、`AGENTS.md`、`version.json`、一个 11 行的 rollout:`session_meta` + 5 组 `turn_context`/`event_msg`,`turn_context.model="gpt-5"`,cwd=源目录)。**未从任何真实节点复制任何文件。**

命令(目标目录 `dst-b` 事先**不存在**):

```
anet node codex fork fork-src-a --name fork-dst-b --workdir <tmp>/dst-b --model gpt-5-codex --inherit-full-access --json
```

结果:退出码 **0**,receipt `verdict: PASS`。stderr 逐字(gap 3 警告):

```
[anet] node codex fork: ⚠ source last ran model gpt-5; target config says gpt-5-codex — the resumed session switches on its next turn. Provider blocks in config.toml are kept (…)
```

receipt 两条关键 check 的 evidence 逐字:

```
fork_isolation pass {"sourceNodeId":"n_11448f7a","targetNodeId":"n_69dde19c","sourceThread":"019968aa-…","targetThread":"01a0cb2a-…","rolloutLines":11,"rolloutBytes":2571,"idReplacements":12,"cwdReplacements":6}
fork_options   pass {"workdir_created":true,"trusted_rewritten":1,"trusted_dropped":0,"model_override":"gpt-5-codex","source_last_model":"gpt-5","port":24705,"agents_md_carried":true}
```

逐坑核对(目标节点目录直接看):

| 坑 | 证据 |
|---|---|
| 1 `--workdir` 自动建 | fork 前 `ls -d dst-b` 不存在;fork 后存在且 `workdir_created:true` |
| 2 `projects.trusted` 改写 | 目标 `config.toml` 第 4 行 `[projects."<tmp>/dst-b"]`,源目录表头 0 处;provider 块原样保留 |
| 3 `--model` 覆盖 + 警告 | 目标 `config.json` `model: gpt-5-codex`;stderr 见上;`config.toml` 的 `model_provider`/`[model_providers.prov-a]` 未删 |
| 4 端口预探 | 目标 `config.json` `codexAppServerPort: 24705`;receipt `port: 24705` |
| 5 `AGENTS.md` 随走 | 目标 `codex-home/AGENTS.md` 存在(60 B,0600),`agents_md_carried:true` |
| 源零触碰 | 源 rollout fork 前后均 2559 B、同一文件;源 `receipts/` 无新文件(receipt 写在目标侧) |
| rollout 改写 | 目标 rollout 11 行 2571 B,12 处 thread id 改写,**6 处 cwd 改写**(源目录字符串 0 处、目标目录 6 处) |

同一源先前还 fork 了一次到 `dst`(`fork-dst-a`),同样 PASS;那一次 `cwdReplacements:0`——原因是我第一版合成的 rollout 用了**带空格的 JSON**(`"cwd": "…"`),而改写只认 codex 真实 rollout 的紧凑形态 `"cwd":"…"`;换成紧凑 JSON 后即 6 处。这是夹具问题不是产品缺陷,记在这里免得下次再踩。

其它:`bun test src/opencode-agent-node-pair` 6/6;doc 门(symbol pins 两种参数形态 / source pins / version claims 默认 + `--package agent-network --version 2.3.0-preview.104`)rc=0。

## 未覆盖(明写)

- **没有 start 目标节点**:`identity_attested` 仍是 unknown(要 `anet node codex start fork-dst-b --probe-from fork-src-a` 做 nonce 验证)。fork 之后的首启、TUI 恢复到新 workdir、端口被占时的重探,本版没在真机跑。
- 两次 fork 未启动的目标都被预分配了 **同一个** 端口 24705(探的时候都空闲)。`start` 会重探,所以不是错误;但两台未启动的 fork 目标不能假定端口互不相同。
- `--dry-run`、fork 后一键 start+nonce、失败时 fail-closed 回滚,仍在 #1951 待办。
- 源 rollout 只有 11 行;百 MB 级 rollout 的耗时/落盘没在本版量。

## promote 时的 must_contain

`"version": "2.3.0-preview.104"`
