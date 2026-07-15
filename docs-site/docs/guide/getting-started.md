# 上手指南（5 步跑通）

新用户首次跑通的最小路径——**5 步, 5 分钟**。每步一条命令 + 一句验证。

::: tip 已经装过 anet?
跳过本页, 走 [升级指南](/guide/upgrade)（通常 `anet upgrade` 一键 + `anet project restart` 重启 cwd 节点）。
:::

**前置**: Node.js ≥ 22.13.0（`commhub-server` 和 `agent-node` 在第一次需要时由 `bunx` / `npx` 自动拉取, 不用手动装）。

---

## 1. 安装 CLI

```bash
npm install -g @sleep2agi/agent-network
```

验证：

```bash
anet -v
```

---

## 2. 启动 Hub

打开第一个终端, **保持开着**：

```bash
anet hub start
```

启动后默认监听 `http://127.0.0.1:9200`, SQLite 数据库在 `~/.commhub/commhub.db`, 自动创建默认管理员 **admin / anethub**。

::: warning 公网部署立刻改密
默认 `admin / anethub` 仅本机用。任何 `--host 0.0.0.0` 公网部署立刻 `anet passwd` 改强密码。
:::

::: tip 停止 / 查看状态
`anet hub status` / `anet hub stop`（不用 `lsof + kill`）。
:::

---

## 3. 启动 Dashboard + 登录

开第二个终端, **保持开着**：

```bash
anet hub dashboard
```

浏览器访问 `http://localhost:3000`, 用 `admin / anethub` 登录。

第三个终端给 CLI 也登录一次（后续 `anet node ...` 命令带凭证）：

```bash
anet login --username admin --password anethub
```

`anet whoami` 确认身份。

---

## 4. 创建并启动节点

```bash
anet node create my-bot
```

向导按这个顺序问你：runtime → (仅 `claude-agent-sdk`) vendor → model → API Key。

::: tip 新手最省事 — 手动选 `claude-code-cli`
向导**默认高亮 `claude-agent-sdk`**, 一路 Enter 会落到要填 vendor + API Key 的复杂路径。如果已经 `claude auth login`, **手动选 `claude-code-cli`** = 零配置最快路径。

5 个 runtime 对照见 [Runtime — 五种 Runtime 对比](/guide/runtimes#五种-runtime-对比-canonical-表)。
:::

启动节点：

```bash
anet node start my-bot
```

看到 `SSE connected` 即上线, 终端保持开着。

::: warning vendor 选择中段 Ctrl+C 可能留半成品节点
半成品节点用 `anet node delete <alias>`（不带 `--force` 先看 will-delete 预览, 再加 `--force` 真删）清掉重来。
:::

---

## 5. 用起来 — 从 Dashboard 派任务

回浏览器 `http://localhost:3000`：

1. 进 Chat 页面, 左侧选 `my-bot`
2. 输入框写一句话（"现在几点？" / "做个 hello world"）, 回车
3. 自己消息立刻乐观回显（`You` 标签）
4. Agent 调用 LLM 后回复, markdown 完整渲染（`↳ my-bot` 标签）

刷新页面, 聊天历史保留。

✅ **5 步跑通**。

---

## 已验证 vs 未验证

::: info 已验证 (当前 stable)
本页 5 步都经过 release gate 验证。详细测试报告见 [更新日志](/changelog) + [测试报告](https://github.com/sleep2agi/agent-network/tree/main/docs/tests)。

- `anet hub start` + 默认账号自动创建
- `anet hub dashboard`
- `anet login` / `anet register` / `anet logout` / `anet whoami`
- `anet node create / start / delete / ls`（`claude-agent-sdk` runtime + CLI 流程已验证；vendor 维度 `VENDORS` 列表 — Anthropic / MiniMax / 书生 Intern / 小米 MiMo — verified-with-real-call）
- Dashboard Chat（markdown / Enter 发 / 乐观回显 / 来源标签 / 错误兜底 / 历史持久）
:::

::: warning 未验证 (请自行评估)
- `codex-sdk` runtime / `claude-code-cli` runtime 端到端流程
- `anet license` / `anet activate` — v0.6 legacy, OSS 用户无需操作（详 [troubleshooting](/troubleshooting#license-expired-授权过期-legacy-行为)）
- `anet network create` 跨用户网络共享 — 代码已合并但未做 E2E 回归
- **一键安装脚本 `setup-anet.sh`** — 未经端到端验证, 用前自审, 见 [一键安装（实验性）](/guide/one-shot-install)
:::

::: tip 没有官方托管
项目方向 = **Apache 2.0 开源 + 自部署 + 课程 / 服务咨询**, 不做 SaaS 托管。生产部署见 [Docker](/deploy/docker) / [生产部署](/deploy/production)。
:::

---

## 下一步

**进阶**:
- [多 Agent 协作](/guide/architecture#agent-node) — peer agents 通过 `get_all_status` / `send_task` / `get_task` 自治协调
- [批量节点管理 `anet project up/restart/down`](/guide/batch) — cwd 下所有节点一键起停, reboot 后零键盘恢复
- [局域网共用 Hub](/deploy/clean-server#_3-起-hub-推荐-tmux-挂着) — `anet hub start --host 0.0.0.0` 让其他机器加入

**实战 demo**:
```bash
anet demo                  # 列出可用 demo
anet demo pr-review        # 3 角色 PR 评审小组
```

**深入**:
- [CLI 命令清单](/guide/cli)
- [Agent Node 配置](/guide/agent-node) — config.json 字段 + 循环任务 `/loop`
- [多模型配置](/guide/multi-model) — DeepSeek / Kimi / Claude / MiniMax / 自部署
- [架构概览](/guide/architecture)
- [升级指南](/guide/upgrade) — 任意旧版 → latest 一键 `anet upgrade`
