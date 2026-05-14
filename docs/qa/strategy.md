# anet QA 策略 v0（首版骨架）

> 跟随 issue [#31](https://github.com/sleep2agi/agent-network/issues/31) 的 5min loop 迭代。
> 当前是骨架，每轮只增量补一小块，目标：**测试体系一步步融入研发，不阻塞 anet 迭代**。

## 1. 哲学（3 条铁律）

1. **两个视角都要**：
   - **用户视角**（外黑盒）— 每条 L1+ 用例先问「这是哪个 persona 的哪个动作」，保证「用户能用」。
   - **代码视角**（内白盒）— L0 单测覆盖**纯函数 / 状态机 / 解析逻辑 / 边界条件**，保证「代码不退化」。
   - 不要互相替代：用户视角能保「能用」但不能保「健壮」，代码视角能保「健壮」但不能保「值得用」。
2. **2 分钟原则**：单个测试套件单次跑 ≤ 2 min。超过就拆。
3. **Docker 隔离**：所有测试在 Docker 里跑，不碰 maintainer 的生产 hub、不碰本地 commhub.db。

## 2. 四个 Persona（4×3 测试矩阵）

| Persona | happy path | 常见错误 | 关键回归点 |
|---------|-----------|---------|-----------|
| **anet CLI 用户**（终端开发者） | `anet hub start` → `anet network create` → `anet node create` → `anet node start` | 没注册 utok 就 node create | session resume（issue #13）、--new-session、tty/non-tty 兼容 |
| **commhub 直接调用方**（SDK/integration） | register utok → mint ntok → POST /api/tasks → SSE 收 | utok 撤销后 ntok 失效；ntok 跨网络越权 | auth 边界、SSE 重连、task 状态机（pending→completed/failed） |
| **agent-node runtime** | 启动 + 拿 inbound task + 回复 | provider key 错误时 reply.status=failed；hub 重启时 SSE 重连 | runtime 切换（`claude-code-cli` / `codex-sdk` / `claude-agent-sdk`；R209 chain 校准；`minimax` 是 `http-api` runtime 的 alias，不算 v0.8 主流 runtime）、session 恢复、failed reply 写回 |
| **dashboard 用户**（浏览器端） | 注册 → 登录 → 看节点 → 派单 → 收到回复 → 刷新历史在 | 未登录访问 / SSE 断 / 跨账号看到别人节点 | 主要路径 UI 不破、SSE 断连恢复、视觉无回归（TopoGraph / chat 气泡 / node 卡片） |

每个格子初版只要 **1 条 smoke + 1 条破坏性场景**，不追大而全。

## 3. 测试分层（从低到高）

| 层 | 工具 | 单次预算 | 必要性 |
|----|------|----------|--------|
| L0 单测（代码视角） | `bun test`（`*.test.ts`） | < 5s | 纯函数 / 解析 / 状态机 / 鉴权边界。基线只有 [client.test.ts](../../agent-network/src/client.test.ts)，**严重欠覆盖**，v0 重点补 |
| L1 contract（用户视角） | Docker + curl + jq | < 30s | hub REST + SSE 协议契约 |
| L2 CLI smoke（用户视角） | Docker + 真 CLI（pty 模拟） | < 60s | anet CLI 主路径，参考 [docs/tests/report-test31.txt](../tests/report-test31.txt) 模式 |
| L3 E2E（用户视角） | docker-compose（hub+dashboard+agent-node+playwright） | < 3 min | 已有 [tests/docker-e2e](../../agent-network/tests/docker-e2e/) 7 场景，**复用，不重写** |
| L3v 视觉回归（用户视角） | Playwright screenshot diff | < 60s | dashboard 关键页面截图基线（dashboard repo 已有，跨仓库治理） |
| L4 跨节点矩阵 | docker-compose 多 agent-node | < 5 min | 多用户、多 channel、多 runtime（后置，不在 v0 范围） |

**v0 范围**：L0 + L1 + L2 三层主推。L3 / L3v 已有，列为「保护资产」，不动。L4 推迟到 v1。

**L0 单测目标清单**（v0 渐进补，每轮 ≤ 1 个文件）：
- `agent-network/src/client.ts` 既有 → 保持
- `server/src/auth.ts`（utok / ntok 生成 + 校验） — 安全核心，优先补
- `server/src/db.ts`（task 状态机迁移） — 边界条件优先
- `server/src/password-dict.ts`（弱密码字典） — 纯函数，最快上
- `agent-network/bin/cli.ts` 命令解析层 — 大文件 ~6000 行（持续增长），先抽小函数再测

## 4. CI gate（渐进，三档）

| 档 | 触发点 | 跑什么 | 阻塞合并？ | 状态 |
|----|--------|--------|-----------|------|
| **1** | PR + push to main（路径过滤） | `bash scripts/qa.sh` = L0 + L1（~16s warm，GH Actions ~1-2min 含 setup） | **否，仅报告** | ✅ R8 上线 [.github/workflows/qa.yml](../../.github/workflows/qa.yml) |
| 2 | 主路径文件变更（auth.ts / db.ts / cli.ts） | L0 + L1 contract | 否（先观察稳定性） | 未启用，待 R10+ |
| 3 | Release tag | 全套 L0+L1+L2+L3 | **是** | 未启用，等本地稳了再谈 |

> 第一阶段已上 GitHub Actions（档 1，report-only）。失败时 PR 显示红 ✕ 但不挡合并 —
> 让大家**看见**测试结果，不当拦路虎。等稳定 2-3 周后再讨论档 2 升级。
> 一键跑命令：`bash scripts/qa.sh`（详见 [README.md](README.md)）。

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
