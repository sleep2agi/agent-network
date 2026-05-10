# anet CLI 测试用例清单

> 状态：草稿 | 日期：2026-04-10 | 来源：cli-refactor-proposal.md 反推

---

## anet create

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 1 | 全参数创建 | `anet create 小明 --runtime codex-sdk --model gpt-5.4` | 生成 `.anet/nodes/小明/config.json`，runtime=codex-sdk，model=gpt-5.4 | P0 |
| 2 | 默认 runtime | `anet create 指挥室` | config.json runtime=claude-code-cli | P0 |
| 3 | 交互式 | `anet create`（无参数） | 依次问 name→runtime→model→key→channel | P0 |
| 4 | 部分参数跳过 | `anet create 小明 --runtime codex-sdk` | 只问 model，不问 name 和 runtime | P0 |
| 5 | name 校验-合法 | `anet create 指挥室` | 成功，中文目录名 | P0 |
| 6 | name 校验-非法字符 | `anet create "a/b"` | 报错：name 不能含 `/` | P0 |
| 7 | name 校验-空 | `anet create ""` | 报错 | P0 |
| 8 | name 校验-以.开头 | `anet create ".hidden"` | 报错 | P1 |
| 9 | 重复创建 | 已存在 `.anet/nodes/小明/`，再 `anet create 小明` | 提示已存在，确认覆盖 | P0 |
| 10 | 依赖检测-codex缺 | 选 codex-sdk，agent-node 未装 | 提示安装 agent-node + codex CLI | P0 |
| 11 | 依赖检测-claude缺 | 选 claude-code-cli，claude 未装 | 提示 `npm install -g @anthropic-ai/claude-code` | P0 |
| 12 | 依赖检测-已装 | 选 codex-sdk，agent-node 已装 | 不提示，继续 | P0 |
| 13 | config.json 内容 | 创建后检查文件 | 含 anet_version/name/runtime/model/session/channels/tools/env/flags | P0 |
| 14 | env 写入 | `--runtime claude-agent-sdk` 交互输入 token | env.ANTHROPIC_AUTH_TOKEN 写入 config.json | P1 |
| 15 | session 绑定 | `anet create 指挥室 --session abc123` | config.json session=abc123 | P1 |

## anet start

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 16 | 新建 session | config.session 为空，`anet start 指挥室` | spawn 进程不带 --resume，打印 "Starting new session..." | P0 |
| 17 | 自动 resume | config.session="abc123"，`anet start 指挥室` | spawn 进程带 --resume abc123，打印 "Resuming session abc123..." | P0 |
| 18 | --new-session | config.session="abc123"，`anet start 指挥室 --new-session` | 不传 --resume，新建 session | P0 |
| 19 | claude-code-cli spawn | runtime=claude-code-cli | spawn `claude --dangerously-skip-permissions ...` | P0 |
| 20 | codex-sdk spawn | runtime=codex-sdk | spawn `agent-node --config ... --alias ...` | P0 |
| 21 | claude-agent-sdk spawn | runtime=claude-agent-sdk | spawn `agent-node --config ... --alias ...` | P0 |
| 22 | 兼容性检测-版本低 | agent-node v0.9.0，anet 需要 >= 1.0.0 | 报错 "Incompatible"，提示 `anet upgrade` | P0 |
| 23 | 兼容性检测-未装 | agent-node 未安装 | 报错 "not installed"，提示 `anet upgrade` | P0 |
| 24 | 兼容性检测-通过 | agent-node v1.1.0 | 正常启动 | P0 |
| 25 | node 不存在 | `anet start 不存在的` | 报错 "Node not found"，提示 `anet create` | P0 |
| 26 | ensure .mcp.json | claude-code-cli start | 自动检查并创建/更新 .mcp.json | P1 |
| 27 | claude-code-cli 新建后提示 | 新建 session 完成 | 打印 "Tip: bind session with anet session ls + anet resume ..." | P1 |

## anet resume --session

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 28 | 自动创建 node | node 不存在，`anet resume 指挥室 --session abc` | 自动创建 node + 写入 session + 启动 | P0 |
| 29 | 覆盖确认 | 已有 session=old，`anet resume 指挥室 --session new` | 提示 "already has session old, overwrite? (y/n)" | P0 |
| 30 | 覆盖确认-拒绝 | 选 n | 不覆盖，不启动 | P0 |
| 31 | 覆盖确认-确认 | 选 y | 覆盖 session=new，启动 | P0 |
| 32 | 缺 --session | `anet resume 指挥室`（无 --session） | 等同 `anet start 指挥室`（自动判断） | P1 |

## anet channel add

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 33 | 添加 telegram | `anet channel add telegram 小明 --bot-token xxx --allow 123` | 创建 channels/telegram/ 目录 + .env + access.json + inbox/ | P0 |
| 34 | .env chmod 600 | 检查创建的 .env 权限 | 0600 | P0 |
| 35 | config.json 更新 | 添加后检查 config.json | channels 数组含 "telegram" | P0 |
| 36 | node 不存在 | `anet channel add telegram 不存在的` | 报错 "Node not found"，提示 `anet create` | P0 |
| 37 | 重复添加 | telegram 已存在，再添加 | 提示已存在，确认覆盖 | P1 |
| 38 | 交互式 | `anet channel add telegram 小明`（无 --bot-token） | 交互式问 token 和 allow | P1 |

## anet -v

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 39 | 多包版本 | `anet -v` | 显示 anet/agent-node/commhub-server/claude/codex 版本 | P0 |
| 40 | 未安装包 | agent-node 未装 | 显示 "not installed" | P0 |
| 41 | 版本解析 | agent-node 输出 "agent-node v1.1.0" | 正确解析为 1.1.0 | P0 |
| 42 | 已装但无版本 | 命令存在但 --version 无输出 | 显示 "installed (version unknown)" | P1 |

## anet upgrade

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 43 | 升级已装包 | anet + agent-node 已装 | 升级两个，不装新的 | P1 |
| 44 | 不装新的 | codex 未装 | 不安装 codex | P1 |
| 45 | npx 缓存清理 | 升级后 | 清理 ~/.npm/_npx | P1 |
| 46 | 升级后验证 | 升级完成 | 打印 `anet -v` 展示新版本 | P1 |

## anet setup

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 47 | 交互式选装 | `anet setup` | 检测已装 → 选 runtime → 安装缺的 | P1 |
| 48 | 全部已装 | 所有包都装了 | 提示 "All dependencies installed" | P1 |
| 49 | 选择性安装 | 只选 codex-sdk | 只装 agent-node + codex，不装 claude | P1 |

## 配置继承

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 50 | 全局 hub fallback | config.json 无 hub，~/.anet/config.json 有 hub | 用全局 hub | P0 |
| 51 | 全局 token fallback | config.json 无 token，~/.anet/config.json 有 token | 用全局 token | P0 |
| 52 | 项目覆盖全局 | config.json 有 hub，~/.anet/config.json 也有 | 用项目 hub | P0 |
| 53 | 旧路径 fallback | .anet/profiles/小明.json 存在 | agent-node 读取并兼容 | P1 |

## Runtime 映射

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 54 | 正式名 codex-sdk | config runtime=codex-sdk | agent-node 用 Codex SDK | P0 |
| 55 | 正式名 claude-agent-sdk | config runtime=claude-agent-sdk | agent-node 用 Claude Agent SDK | P0 |
| 56 | 旧名 agent-sdk | config runtime=agent-sdk | 兼容映射到 claude，打印 deprecation warning | P0 |
| 57 | 旧名 claude-sdk | config runtime=claude-sdk | 兼容映射到 claude | P0 |
| 58 | 简写 claude | config runtime=claude | 映射到 claude | P1 |
| 59 | 简写 codex | config runtime=codex | 映射到 codex | P1 |

## agent-node 专项

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 60 | --version | `agent-node --version` | "agent-node v1.1.0" | P0 |
| 61 | --config | `agent-node --config .anet/nodes/小明/config.json` | 读取并使用 config | P0 |
| 62 | --alias | `agent-node --alias 小明` | 自动找 .anet/nodes/小明/config.json | P0 |
| 63 | session 写回 | 首次 query 完成后 | config.json session 字段更新 | P0 |
| 64 | session 字段兼容 | config 里有 resume / sessionId | 正确读取 | P1 |
| 65 | channels 过滤 | config channels=["server:commhub", "telegram"] | 忽略 server:commhub，启动 telegram | P0 |
| 66 | channels plugin 过滤 | config channels=["plugin:telegram@official"] | 忽略 plugin:* | P0 |
| 67 | CommHub auth | ~/.anet/config.json 有 token | SSE 和 MCP 请求带 Authorization | P0 |
| 68 | Telegram channel | --channel telegram + .env 有 bot token | polling 启动，收消息能回复 | P1 |
| 69 | Telegram getMe 校验 | bot token 无效 | 启动时报错退出 | P1 |
| 70 | Telegram offset 持久化 | 处理消息后重启 | 不重复回复 | P1 |

## 废弃项兼容

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 71 | anet init profile 兼容 | `anet init profile 小明` | 打印 deprecation 提示，执行 anet create | P1 |
| 72 | .anet/profiles/ 读取 | 旧路径存在 config | agent-node 能读取 | P1 |
| 73 | .agent-node.json 读取 | 最旧格式 config | agent-node 能读取 | P2 |

## 混淆后功能回归

| # | 功能点 | 测试用例 | 预期结果 | 优先级 |
|---|--------|---------|---------|--------|
| 74 | bun build 产物 | `node dist/cli.js --version` | 正确输出版本 | P0 |
| 75 | env 变量读取 | `COMMHUB_TOKEN=xxx node dist/cli.js --alias test` | AUTH_TOKEN 正确读取 | P0 |
| 76 | import external | dist/cli.js import claude-agent-sdk | 运行时正确 resolve | P0 |
| 77 | import external codex | dist/cli.js import codex-sdk | 运行时正确 resolve | P0 |

---

## 统计

| 优先级 | 数量 |
|--------|------|
| P0 | 42 |
| P1 | 28 |
| P2 | 7 |
| **总计** | **77** |

---

**请通信牛 review。文件路径: ~/agent-orchestra/docs/test-plan.md**
