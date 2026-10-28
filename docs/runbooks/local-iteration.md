# 本地迭代回路（改代码 → 验证 → 推送）

> 依据 2026-10-28 实测。三个数字决定你在哪一层验证。

## 三个数字

| 层 | 命令 | 实测耗时 | 用途 |
|---|---|---|---|
| 定向 | `cd server && bun run test --file=server/src/<x>.test.ts` | **4 秒**（2 文件 / 13 用例） | 改完立刻跑，回答「我的改动对不对」 |
| 全量本地 | `cd server && bun run test` | **约 7 分钟**（265 文件 / 2955 用例） | 推之前跑一次，回答「有没有连累别的」 |
| CI | push → PR | **20–40 分钟**（其中 90% 是排队） | 只回答「换台机器还对不对」 |

CI 的分项实测：job 自身墙钟中位 **0.6 分钟**，从 PR 创建到 job 启动中位 **6.7 分钟**、最长 22 分钟。
⇒ 慢的不是测试，是排队。

## 定向跑：用仓里的运行器，不要自己拼 `bun test`

```bash
cd server
bun run test --file=server/src/departments-http.test.ts --file=server/src/restart-readiness-http.test.ts
```

`server/scripts/test-aggregate.ts` 是 canonical runner，它给**每个测试文件一个独立进程 + 独立临时 DB**，
因为 server 测试会改 `process.env`、依赖 cwd、共享模块单例。

**不要**用下面这些写法（都会得到假结果）：

```bash
bun test server/src/*.test.ts          # 全部塞进一个进程 → 785 条假红（实测）
cd server && bun test src/x.test.ts    # 有些用例 spawn 子进程用「仓库根相对路径」→ 假红
node --test app/lib/x.test.mjs         # .mjs 里 import 无扩展名的 .ts → 模块找不到
```

## 全量本地跑的前提

**先装齐 workspace 依赖**。2026-10-28 实测：`agent-network/node_modules` 为空时，
265 个文件里有 4 条红，全是 `Cannot find package 'smol-toml'` —— 是环境，不是产品。

判据：跑完看 `SERVER_AGGREGATE_RESULT` 那行；`fail>0` 时先确认失败原因是依赖缺失还是真断言。

## 什么时候**只能**用 Docker

`tests/**` 那批套件（真 tmux、真二进制、真端口、跨机器）**不要**在宿主上跑。
项目规则（AGENTS.md「所有测试在 Docker 里跑」）是为这个定的：2026 年一次 `kill-server`
打掉了默认 tmux server，71 个节点同时掉线。

`server/src/*.test.ts` 里没有任何一处起真 tmux（只出现 `launch_hint: "tmux"` 这类字符串字面量），
所以这一层用定向本地跑是安全的。

## 建议的默认动作

1. 改完 → 定向跑受影响文件（秒级）
2. 觉得差不多了 → 全量本地跑一次（分钟级）
3. 再推 → CI 只负责环境矩阵
4. CI 红之前先问一句：**这条红我在本地能复现吗？** 能 → 先修；不能 → 才怀疑环境
