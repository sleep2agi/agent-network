# 手机与桌面客户端

Dashboard 除了浏览器访问，还有三种**客户端壳**：PWA、iOS / Android、macOS / Windows / Linux 桌面应用。

::: warning 它们不在这个仓
三种壳都在 **[sleep2agi/agent-network-dashboard](https://github.com/sleep2agi/agent-network-dashboard)**，
不在 `sleep2agi/agent-network`。权威文档是那个仓里的 `docs/mobile-app.md`，本页只是入口和现状说明。
:::

## 三种壳都是"薄壳"

它们**不重新实现任何功能**，只是把已经在跑的 Dashboard 装进一个窗口：认证、数据、上传、
实时推送**全部仍由 Dashboard 与 CommHub 承担**。所以：

- 壳升级不会改变权限模型；
- 壳装好之后，你看到的和浏览器里看到的是同一个 Dashboard；
- **必须先有一个能访问的 Dashboard 地址**，壳才有东西可显示。

桌面与移动端默认指向 `http://127.0.0.1:3000`。手机是**另一台设备**，它的回环地址到不了你的电脑，
所以真机调试要显式给一个它够得到的 HTTPS 地址：

```bash
export ANET_DASHBOARD_URL="https://your-dashboard.example.com"
```

## PWA（最省事的一种）

Dashboard 本身就是一个 PWA。用 **HTTPS** 打开它，浏览器（移动端 Safari / Chrome，
桌面 Chrome / Edge）会提供"安装到主屏 / 安装为应用"。

⚠️ **HTTP 不行** —— PWA 的安装与 Service Worker 都要求安全上下文，
`http://127.0.0.1` 是例外（本机调试可用），局域网 IP 通常不是。

## iOS / Android（Capacitor）

Capacitor 的 WebView 壳，指向同一个 Dashboard 地址。需要 Xcode（iOS）或 Android Studio（Android）。
具体命令见那个仓的 `docs/mobile-app.md`。

## 桌面（Electron）

```bash
# 在 agent-network-dashboard 仓里
npm install
ANET_DASHBOARD_URL=https://dashboard.example.com npm run app:desktop      # 直接跑
npm run app:desktop:pack                                                  # 打安装包
```

窗口壳只有几十行，安全姿态是收紧的：`contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开，
外链一律交给系统浏览器打开而不是在应用内导航。

### 🔴 打包的现状（2026-08-19 实测，别照着旧印象走）

| 目标 | 状态 |
| --- | --- |
| Linux `AppImage` | **实测可出**，产物约 194 MB |
| macOS `dmg` / `zip` | 配置在，**没有人在对应平台上验过** |
| Windows `nsis` | 配置在，**没有人在对应平台上验过** |

三点要知道：

1. **这套打包在那个仓的 CI 里一次都没跑过** —— 四个 workflow 都不调用它。
   也就是说它的"能用"目前靠人手动验，没有任何自动化在守。
2. 在 2026-08-19 之前，**它第一次跑就会失败**：electron-builder 从 `package.json` 的 `name`
   派生可执行名，而那个 name 带 `@` 与 `/`。已修（配置里显式给了 `executableName`）。
3. 安装依赖时 electron 会下载一个约 100 MB 的二进制。那次下载**在 CI 里失败过**，
   所以要把打包接进 CI，第一个要解决的是那次下载的稳定性，而不是配置。

**macOS / Windows 的安装包，在有人在对应平台上真打出来之前，本页不会声称它们可用。**

## 我该用哪一种

- 只是想在手机上看看 → **PWA**，不需要任何构建；
- 要推给不会用命令行的人 → **桌面安装包**（目前只有 Linux 经过实测）；
- 要接系统能力（推送、文件、相机等）→ **Capacitor**，那才需要 Xcode / Android Studio。
