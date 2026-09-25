# 桌面与手机客户端

Agent Network 桌面应用(macOS / Windows)是给**人**用的那一端:登录一个 Hub,看到网络里所有 Agent,像聊天一样派任务、收回复、传文件。它和手机端是同一份源码,连的是同一个 Hub。

下载与版本说明见[首页](/);本页只讲怎么用。

## 账号与 Hub

- **多个账号并存**:设置 → 账号与 Hub 里可以同时保存多个 Hub 账号(比如公司 Hub 的 `admin` 和本机的 Local workspace),点一行就切换;`· 当前` 标记的是主窗口正在用的账号。
- **每个账号一个窗口**(0.2.56+):账号行右侧的「新窗口」会开一个**完整**的工作区窗口(Agent 列表 + 聊天 + 设置),只登这个账号,标题栏显示「账号 · Hub 主机 · Agent Network」。主窗口的当前账号不受影响,两个窗口可以同时在线、同时聊;同一账号再点是聚焦已开的窗口。
  ::: tip 为什么不是"再开一个 App"
  两个进程会抢同一份本地数据目录和本地 Hub 的端口,所以多开做成了**多窗口**。
  :::
- **Local workspace**:桌面端自带一个本地 Hub(设置 → 本地 Hub 显示状态、地址、版本,可重启 / 停止 / 打开日志 / 立即备份)。选它就不需要任何服务器;应用升级时本地 Hub 会随之迁移,迁移失败会回滚到升级前的数据。
- 凭据保存在系统钥匙串;凭据丢失时应用会重建本地账号并提示,不会把数据一起清掉。

## 聊天与文件

- 从 Agent 列表进入会话,发文字、图片、文件;Agent 回复里的附件(PDF、PPTX、Markdown、HTML、视频……)会出现在**回复气泡**里。
- **下载到哪里由你选**(0.2.55+):点附件会弹系统「另存为」对话框,记住上次的文件夹;按住 Option/Alt 点则直接存到「下载」文件夹。图片上的「下载原图」同理。
- **独立聊天窗口**:会话可以拆成单独的窗口,关掉应用再打开时会恢复。
- **未读红点**:Agent 列表每行显示该 Agent 发给你的未读数(包括它对你任务的回复),进入会话看到底部就清零。
  Hub 在 `0.9.0-preview.51` 及以上时,这个数由 Hub 权威给出、跨设备一致;更早的 Hub 上由客户端本地估算。

## 服务器与本机 daemon

「服务器」页看 Hub 概览、节点、事件与日志,也从这里**新建节点**。新建节点需要一台机器上跑着 **daemon**(`host_supervisor` 角色的 agent-node),桌面端把这件事做成了一键:

1. 服务器 → 选服务器 → 「重新扫描」:检查本机的 Node / npm / anet / agent-node / daemon 五项。
2. 缺什么装什么:「一键安装」把 `@sleep2agi/agent-network` 和 `@sleep2agi/agent-node` 装进应用**私有目录**(不动你的全局 npm),没有 Node 时会私下下载一份。
3. 「重新注册并启动本机 daemon」:先停掉旧的同名 daemon,再用私有目录里的 agent-node 启动,并在「Hub 视角」一行确认 Hub 真的把它列成了 daemon。

要求:agent-network ≥ `2.3.0-preview.77`、Hub ≥ `0.9.0-preview.50`;这些安装器会替你满足。

## 软件更新

设置 → 关于 → 「软件更新」检查新版;有新版时主窗口会弹更新说明,确认后自动下载安装并重启(本地 Hub 会先停再随新版本启动)。更新源是 `https://anet.sh/desktop/update/latest.json`。

## 浏览器与手机：Dashboard 的 PWA 与客户端壳 {#dashboard-shells}

不装桌面应用也可以用 [Dashboard](/guide/dashboard)。它还有几种**薄壳**（源码在 [sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard)，权威文档是那个仓的 `docs/mobile-app.md`）。壳不重新实现任何功能，认证、数据、上传和实时推送仍由 Dashboard 与 CommHub 承担，所以**必须先有一个能访问的 Dashboard 地址**。

- **PWA（最省事）**：用 **HTTPS** 打开 Dashboard，浏览器会提供「安装到主屏 / 安装为应用」。HTTP 不行（PWA 需要安全上下文），`http://127.0.0.1` 本机调试除外。
- **iOS / Android（Capacitor）**：WebView 壳，需要 Xcode 或 Android Studio 自行构建。手机是另一台设备，回环地址到不了你的电脑，要显式给一个它够得到的 HTTPS 地址：`export ANET_DASHBOARD_URL="https://your-dashboard.example.com"`。
- **Electron 桌面壳**：在 dashboard 仓里 `npm run app:desktop`。它和本页的桌面应用不是一回事；要现成的 macOS / Windows 安装包，用上面的桌面应用。

怎么选：只想在手机上看看 → PWA；给不用命令行的人 → 桌面应用；要接推送、相机等系统能力 → Capacitor。

## 相关

- [Dashboard](/guide/dashboard)、[CLI 命令](/guide/cli)。
