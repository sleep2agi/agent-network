# anet QA 策略 v0（首版骨架）

> 跟随 issue [#31](https://github.com/sleep2agi/agent-network/issues/31) 的 5min loop 迭代。
> 当前是骨架，每轮只增量补一小块，目标：**测试体系一步步融入研发，不阻塞 anet 迭代**。

## 1. 哲学（3 条铁律）

1. **从用户视角写用例**，不是从代码视角。每条用例先问「这是哪个 persona 的哪个动作」。
2. **2 分钟原则**：单个测试套件单次跑 ≤ 2 min。超过就拆。
3. **Docker 隔离**：所有测试在 Docker 里跑，不碰生产 hub（47.116.5.73）、不碰本地 commhub.db。

## 2. 三个 Persona × 三个动作（3×3 测试矩阵）

| Persona | happy path | 常见错误 | 关键回归点 |
|---------|-----------|---------|-----------|
| **anet CLI 用户**（终端开发者） | `anet hub start` → `anet network create` → `anet node create` → `anet node start` | 没注册 utok 就 node create | session resume（issue #13）、--new-session、tty/non-tty 兼容 |
| **commhub 直接调用方**（SDK/integration） | register utok → mint ntok → POST /api/tasks → SSE 收 | utok 撤销后 ntok 失效；ntok 跨网络越权 | auth 边界、SSE 重连、task 状态机（pending→completed/failed） |
| **agent-node runtime** | 启动 + 拿 inbound task + 回复 | provider key 错误时 reply.status=failed；hub 重启时 SSE 重连 | runtime 切换（claude-code / codex / minimax）、session 恢复、failed reply 写回 |

每个格子初版只要 **1 条 smoke + 1 条破坏性场景**，不追大而全。

## 3. 测试分层（从低到高）

| 层 | 工具 | 单次预算 | 必要性 |
|----|------|----------|--------|
| L0 单测 | `bun test`（`*.test.ts`） | < 5s | 仅纯函数 / 解析逻辑（如 [client.test.ts](../../agent-network/src/client.test.ts) 已有） |
| L1 contract | Docker + curl + jq | < 30s | hub REST + SSE 协议契约 |
| L2 CLI smoke | Docker + 真 CLI（pty 模拟） | < 60s | anet CLI 主路径，参考 [docs/tests/report-test31.txt](../tests/report-test31.txt) 模式 |
| L3 E2E | docker-compose（hub+dashboard+agent-node+playwright） | < 3 min | 已有 [tests/docker-e2e](../../agent-network/tests/docker-e2e/) 7 场景，**复用，不重写** |
| L4 跨节点矩阵 | docker-compose 多 agent-node | < 5 min | 多用户、多 channel、多 runtime（后置，不在 v0 范围） |

**v0 范围**：L0 + L1 + L2 三层。L3 已有，列为「保护资产」，不动。L4 推迟到 v1。

## 4. CI gate（先不强求，但留位）

| 触发点 | 跑什么 | 阻塞合并？ |
|--------|--------|-----------|
| PR 打开 | L0（bun test，~5s） | 否，仅报告 |
| 主路径文件变更（cli.ts / server/src/) | L0 + L1 contract（~30s） | 否 |
| Release（打 tag） | 全套 L0+L1+L2+L3 | 是 |

> 第一阶段不接 GitHub Actions，只做「**本地 `pnpm qa` 一键跑**」。等本地稳了再上 CI。

## 5. 测试需要的资源

| 资源 | 用途 | 现状 |
|------|------|------|
| Docker（`sg docker`） | 隔离环境 | ✅ 已有 |
| Bun 1.x | 跑 src/ 直跑 | ✅ 已有 |
| `@preview` npm 包 | E2E 镜像里 npx 拉 | ✅ 已有 |
| 假 LLM key | 让 reply 必失败便于断言 | ✅ docker-e2e 已用 fake MiniMax key |
| 一份 fixtures（utok/ntok/sample task） | L1 复用 | ❌ 待建（v0 第二轮） |
| `pnpm qa` 入口脚本 | 一键跑 L0+L1+L2 | ❌ 待建（v0 第三轮） |

**不需要**的资源（明确排除）：
- ❌ 公网 hub / 生产数据库
- ❌ 真实 LLM 配额
- ❌ 真实 Telegram / Feishu / WeChat token（mock 即可）

## 6. 增量节奏（不要一口吃胖）

| Round | 目标 | 产物 |
|-------|------|------|
| R1（本轮） | 骨架 + 矩阵 + 资源清单 | 本文件 + [test-matrix.md](test-matrix.md) |
| R2 | 选 1 个最高 ROI 的 L1 contract 测试落地 | 1 个新 Dockerfile + 1 份 fixtures |
| R3 | `pnpm qa` 入口，串起 L0 + 已有 docker-e2e | scripts/qa.sh |
| R4 | 补第 2 个 persona（agent-node） | 1 个新 Dockerfile |
| R5+ | 按 ROI 排队补矩阵格子，每轮 ≤ 1 个新测试 | … |

## 7. 不变量（每轮 review 自己有没有违反）

- [ ] 单次测试 ≤ 2 min？
- [ ] 测的是用户动作，不是内部实现？
- [ ] Docker 隔离？没碰生产？
- [ ] 这一轮只动了 docs/qa 或 1 个测试文件，没改业务代码？
- [ ] 失败时报错信息能让一个新成员 5 分钟内定位到出问题的模块？
