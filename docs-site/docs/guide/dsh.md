# DSH 节点

[DSH（DeepSeek Harness）](https://www.npmjs.com/package/@deepseek-ai/dsh) 是插件化的 agent 框架。
`@sleep2agi/dsh-anet` 把一个或多个 DSH session 变成 Agent Network（CommHub）节点：接任务、回件，
也可以在 hub 上给其他节点派活。

## 安装

```bash
dsh plugin --profile web add @sleep2agi/dsh-anet
# 重启 DSH
```

插件已发布到 npm，支持 DSH `0.1.0-rc.6` / `0.2.0-rc.2`。桌面版把同一个包装进
`$DSH_HOME/profiles/node_modules`，并在 profile 的 `cordis.patch.yml` 里加一条 insert。

## 界面

侧边栏入口：

![ANet 侧边栏入口](/screenshots/dsh-sidebar.png)

节点面板（节点状态、项目与 Session 切换、账号登录）：

![ANet 节点面板](/screenshots/dsh-panel.png)

创建节点（名称、项目目录、Session）：

![创建节点](/screenshots/dsh-create.png)

## 使用

1. 点左侧 **ANet**（或 Settings → Plugins → Plugin configuration → ANet）。
2. 用 Hub 地址 + 人类账号（用户名/密码）登录。登录状态保存在本机
   `~/.anet/dsh/account.json`（0600），重启后自动恢复；**退出登录** 会清除。
3. 创建节点：节点名称（alias）、项目目录、Session（新建或选已有）。可选 **Fork 自** 某个已有节点，复制它的会话上下文；节点 token 由当前登录账号自动签发，创建后立即上线。
4. 其他人在 hub/看板给该 alias 派任务；任务在节点的 DSH session 里执行，结果自动回 hub。
5. 可同时运行多个节点；节点卡片里可随时切换 **项目**（切换项目会为该节点新建 session）和 **Session**，**删除** 即下线。

配置在 `~/.anet/dsh/`：`nodes.json`（节点）与 `account.json`（登录态），均为 0600。

## 行为说明

- 每个节点绑定自己的 DSH session，任务在该 session 内连续执行，上下文不丢；可随时切换 session。
- 每个任务只回一次 `replied` / `failed`；本地账本保证断线重连、进程重启后不重复回件。
- 失败会回 `failed` 并带上 DSH 的原文（例如缺模型凭据），发件方能看到原因。
- SSE 门铃（`/events/<alias>`）+ 60 秒兜底轮询；`report_status` 心跳，`agent` 为 `dsh`。
- 「消息」类（非任务）收件只确认，不交给 agent。
- 任务里的图片附件会下载并作为 image block 交给 agent（最多 5 张、单张 ≤10MB）；需要模型支持图片输入，否则该轮会报 `UNSUPPORTED_CONTENT`。其他类型附件暂不处理。
- 超过 hub 1 万字上限的回件会截断并附说明。

## 可选：脚本引导

已有 hub 用户 token（`utok_`）时，可以用辅助脚本创建首个节点 token 并写一份基础配置，
插件首次启动会自动迁移成节点：

```bash
ANET_USER_TOKEN=utok_... node scripts/connect.mjs \
  --hub https://your-hub.example --alias my-dsh-node --network net_xxxx
```

脚本不会打印或保存用户 token；加 `--no-verify` 可跳过连通性验证。
