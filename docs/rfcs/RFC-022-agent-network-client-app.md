# RFC-022: Agent Network Client APP — 用户端 chat + observability 客户端

| 项 | 值 |
|----|----|
| **作者** | 通信SDK马 |
| **状态** | Draft v0.1 (RFC + 原型骨架同 commit ship, 待 通信龙 review + Vincent 拍板下一步 scope ramp) |
| **关联 issue** | TBD (通信龙 cross-link 后回填) |
| **关联 RFC** | [RFC-012](RFC-012-codex-mobile-bridge.md) (codex Mobile bridge — complementary, 不是 supersede) · RFC-017 (dashboard 现状) —— ⚠️ **这份 RFC 从未提交进本仓**(`git ls-files docs/rfcs | grep RFC-017` 无命中),原来那个链接是坏的,故此处不再链 · [RFC-020](RFC-020-im-platform-integration.md) (IM 接入 — 共享 chat 抽象) |
| **关联 backlog** | [#107](https://github.com/sleep2agi/agent-network/issues/107) (codex Mobile + remote-control 调研, R237 已 pending) |
| **创建** | 2026-05-30 北京 (UTC+8) |
| **依据** | commhub-server 现 HTTP/SSE API surface (40+ endpoints) + dashboard 复用模式 + ntok_/utok_ 双 token 体系 |

---

## 摘要

让用户在**手机或桌面浏览器**上**登录 commhub → 看到自己 network 里所有在线 agent 节点 → 一对一 chat → 实时观察 agent 干活过程**。技术路线**最简优雅**: React + Vite + TypeScript **PWA**,纯 HTTP/SSE 客户端,**零新 server 端点**(完全复用现有 `/api/auth/login` / `/api/status` / `/api/task` / `/events/:alias` / `/api/tmux/:alias`)。

**为什么是 PWA 不是 React Native / Flutter**:
- **手机 + 桌面同代码**(用户首要需求是「手机也能用」,不是「原生 app store 上架」)
- **零 app store 摩擦**(MVP 速度优先,后期需要原生 push 通知再用 Capacitor 包壳)
- **复用团队 TS 技能栈**(dashboard 已 Next.js, PWA 直接同语言)
- **后端纯 HTTP**(没有 native bridge 需求, RN/Flutter 优势用不上)

**长期方向(写下)**:
- v1 PWA(本 RFC, 4-6h MVP)
- v2 PWA + Service Worker 离线缓存 + Web Push
- v3 Capacitor 壳 → iOS / Android 上架,复用同 React codebase, 加原生 push 通知
- v4 Tauri 壳 → 桌面 native app(macOS / Windows / Linux), 复用同 React codebase

---

## §1 背景

### 1.1 Vincent 用户故事

> "在外面用手机给通信工程马派任务,看他干完了没;晚上回家用电脑接着看他干。" (Vincent 7010 telegram)

现有 anet 用户端入口:
- **dashboard** — Next.js, 公开只读 + 管理员私有, 但**没有 chat UI**, 只 list + observability

  > 🔴 **本行原来把 `agent-network-dashboard.vercel.app` 写成了这个入口的地址,那是错的(#829)。**
  > 项目自营的生产 Dashboard 是**自托管**的(`Caddy :3000 / frpc :3100 → 127.0.0.1:3001`,
  > pm2 托管),拓扑见 `deploy/dashboard/README.md`;仓库政策不写死真实域名。
  > `agent-network-dashboard.vercel.app` **不是它**,也不是任何面向外部用户的 SaaS 入口 ——
  > 判断线上状态时不要用它。判断方法见 `CLAUDE.md`「项目信息 → Dashboard:分三种,别混」。
  >
  > (下文 §「生产域名建议」和「待定问题」里仍然提到这个域名 —— **那两处是提案,不是现状陈述**,
  > 保留原样。这条告示只改这一处:**它当时是在描述"现有入口"**。)
- **MCP tools** (`commhub_send_task` 等) — 走 Claude Code / codex MCP server 配置, **要装 CLI 才能用**
- **CLI** (`anet send`) — 同上, 要装
- **IM 接入**(RFC-020 飞书/WhatsApp/企微/Slack) — 走第三方 IM, 用户**必须先有该 IM 账号 + bot 安装**

**缺口**: 一个**用户自己控制 + 跨设备 + 零安装的** anet 入口, 用户登录 commhub 账号就能开始用。这正是 client APP 要填的位。

### 1.2 跟 RFC-012 / RFC-020 关系

| RFC | 入口 | 用户是谁 | 关系 |
|---|---|---|---|
| **RFC-012 codex Mobile bridge** | codex Mobile App + commhub MCP | 已装 codex Mobile 的人 | complementary, 各管一片(本 RFC 给**没装 codex 的人** + **不想给 codex OpenAI 上传操作记录的人**) |
| **RFC-020 IM 接入** | 飞书 / WhatsApp / 企微 / Slack | 已装 IM bot 的人 | complementary, IM 是「企业内推」, client APP 是「个人 + 跨设备」 |
| **dashboard** | 浏览器 | 公开 + 管理员 | 互补; dashboard = 观察 + 管理, client APP = 用户端 chat + 观察 |

---

## §2 用户故事

### 2.1 主线 4 个故事

**Story 1 — 登录**
> 用户用手机/电脑浏览器打开 `app.agent-network.io`, 输入 commhub 邮箱+密码 / 一次性 invite link, 拿到 `utok_` token 存浏览器 localStorage。

**Story 2 — 看在线节点**
> 登录后默认进 "节点列表"页, 展示当前 network 下所有 agent 节点: alias + runtime(claude / codex / grok / mcp) + 状态(idle / working / blocked / offline) + 当前任务摘要。

**Story 3 — 一对一 chat**
> 点某节点 → 进 chat 页, 顶部显示节点 alias + 状态徽章, 中间是 message 流(我发的 task + agent 回复), 底部 input box。发送时调 `POST /api/task`, agent 用 SSE 推回复, UI 实时插入。

**Story 4 — 实时观察 agent 干活**
> chat 页右侧/下方加 "Live Log" 抽屉, 点开后实时 stream `GET /api/tmux/:alias`(每 2-5s 轮询 capture-pane,后续可换 WS) 显示 agent terminal pane 真实输出, 让用户看到 "agent 正在思考 / 调工具 / 写代码"。

### 2.2 非目标 (MVP 不做)

- ❌ Group chat / 多人协作 chat (single user → single agent, MVP)
- ❌ 切换 network (MVP 假设单 network; 多 network 切换是 P1)
- ❌ 自己注册账号(MVP 走管理员 invite link / 已有 commhub 账号)
- ❌ Agent → Agent topology 可视化(RFC-017 dashboard 已涵盖)
- ❌ 创建 / 启停 节点(管理员操作, dashboard 已涵盖)
- ❌ 离线缓存 / push 通知(v2/v3 phase)

---

## §3 后端复用图 — 零新端点

```
┌──────────────────────────────────────────────────────────────────┐
│  Client APP (React PWA, runs in browser)                         │
│                                                                  │
│  POST /api/auth/login        ──► utok_xxx                        │
│  GET  /api/networks          ──► list networks                   │
│  GET  /api/status            ──► list online nodes (with task)   │
│  POST /api/task              ──► send_task to agent              │
│  GET  /events/<my-alias>     ──► SSE: tasks delivered to me      │
│  GET  /api/tasks?from=me     ──► list my dispatched tasks        │
│  GET  /api/messages          ──► chat history (inbox + replies)  │
│  GET  /api/tmux/<alias>      ──► capture-pane observability      │
└──────────────────────────────────────────────────────────────────┘
```

复用矩阵:

| 用户故事 | 现有端点 | 现有? | Auth |
|---|---|---|---|
| Login | `POST /api/auth/login` | ✅ | password → utok_ |
| 看在线节点 | `GET /api/status?network_id=<id>` | ✅ | utok_ |
| 一对一 chat — 发送 | `POST /api/task` | ✅ | utok_ + network_id |
| 一对一 chat — 收回复 | `GET /events/<my-alias>` (SSE) | ✅ | ntok_ scoped to network |
| 一对一 chat — 历史 | `GET /api/messages?alias=<me>` | ✅ | utok_ |
| Live log | `GET /api/tmux/<alias>` | ✅ | utok_(需 `COMMHUB_ENABLE_TMUX=1` server-side) |

**Server 端结论: 0 LOC 新增**(MVP 阶段)。所有所需 endpoints 已 ship。

**唯一可选 server tweak**(P2 不阻塞 MVP):
- `GET /events/<user-alias>` 现要 ntok_ 强制(避免他人窃听他人 SSE)。APP 端可在 login 后立即 `POST /api/auth/node-token` 拿一个 `ntok_` 给 SSE 用; 不需 server 改。

---

## §4 Auth 模型适配 (utok_ vs ntok_)

| Token | 现有用途 | APP 用法 |
|---|---|---|
| `utok_xxx` | User-scoped, 可跨 network | APP 主 session token, 存 localStorage(`anet:utok`) |
| `ntok_xxx` | Network-scoped, 给 agent 节点 + SSE 长连接 | APP 拿一个挂给自己当前 network + 自己 alias, 仅 SSE 用 |

**Flow**:
1. APP login → utok_xxx
2. APP GET `/api/networks` → 选 active network
3. APP POST `/api/auth/node-token` `{network_id, alias: "user-<userId>"}` → 拿 ntok_xxx(给 SSE)
4. APP 注册自己 alias(post /api/task 时 `from` 字段填 `user-<userId>`,触发 sessions 表存一行,供 SSE)
5. APP GET `/events/user-<userId>` with `ntok_xxx` → 实时接 agent 回复推送

**安全 review**:
- utok_ 存 browser localStorage(non-HttpOnly cookie 等价风险) — MVP 接受, P2 改 secure HttpOnly cookie + CSRF token
- ntok_ 同 localStorage; 仅 SSE 用, 不放 URL query(避 referer 泄漏)
- CORS: server `withCors` 已开放 `*` (但 auth 强校验), APP 部署在任意域都能用
- Rate limit: server 已有 60/min/IP, APP 无需额外
- 用户隔离: ntok_ 是 network-scoped, 只能看自己 network 内节点; utok_ 是 user-scoped, 自动多 network 隔离

---

## §5 技术栈选择

### 5.1 决定: **React + Vite + TypeScript PWA**

理由(per [[feedback_pick_elegant_dont_ask]],我直接定不让 Vincent 选):

| 候选 | MVP 速度 | 跨端 | TS 复用 | 长期路径 | 选? |
|---|---|---|---|---|---|
| **React + Vite PWA** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐(浏览器) | ⭐⭐⭐⭐⭐ | Capacitor 壳 → 上 App Store | ✅ |
| React Native / Expo | ⭐⭐ | ⭐⭐(iOS+Android, web 二等公民) | ⭐⭐⭐⭐ | 直接 native | ❌ MVP 速度不够 + 桌面不友好 |
| Flutter | ⭐ | ⭐⭐⭐⭐(iOS+Android+web+desktop) | ⭐ Dart 语言 | 直接 native | ❌ TS 团队不复用 |
| Next.js (跟 dashboard 同) | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Capacitor 壳 | ⚠️ SSR 对纯客户端 APP overkill |
| Tauri 直接做 desktop | ⭐⭐ | ⭐⭐(只桌面) | ⭐⭐⭐ Rust 学习 | / | ❌ 不覆盖手机 |

**选 React + Vite PWA**:
- 5min `npm create vite@latest -- --template react-ts` 启动框架
- `vite-plugin-pwa` 加 manifest + service worker, 即可"添加到主屏"成"看似原生"
- 桌面浏览器(macOS / Windows / Linux Chrome / Safari) 直接可用
- 手机浏览器(iOS Safari / Android Chrome) 直接可用,"添加到主屏" 全屏 UI

### 5.2 关键依赖

```json
{
  "react": "^18",
  "react-dom": "^18",
  "vite": "^5",
  "vite-plugin-pwa": "^0.20",
  "react-router-dom": "^6",
  "zustand": "^4"
}
```

零 UI 框架依赖(MVP 用原生 CSS / Tailwind 都行; 原型骨架用最小 CSS), 不引入 MUI / Antd 避免 bundle 大。

### 5.3 项目结构

```
prototype/anet-client-app/
├── README.md                 # 跑步骤
├── package.json
├── vite.config.ts
├── index.html
├── src/
│   ├── main.tsx              # 入口
│   ├── App.tsx               # router 壳
│   ├── api.ts                # commhub HTTP client (login/status/task/sse)
│   ├── auth.ts               # token store (localStorage)
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── NodeList.tsx
│   │   └── Chat.tsx
│   └── components/
│       └── LiveLog.tsx       # tmux capture-pane 轮询
└── public/
    └── manifest.webmanifest  # PWA manifest
```

---

## §6 MVP 范围 + Phase ladder

### Phase 1 — MVP (本 RFC + 原型骨架, 4-6h budget)

| 件 | 做 |
|---|---|
| Login page | utok_ 登录, 错误提示 |
| Network list (可省略 MVP 单 network) | / |
| Node list | GET `/api/status` → 渲染 alias+runtime+status+task |
| Chat page | POST `/api/task` + GET `/api/messages?alias=user-<id>` |
| SSE 实时回复 | GET `/events/user-<id>` |
| Live log | GET `/api/tmux/:alias` 每 3s 轮询 |

### Phase 2 — Polish (P1, post-MVP, Vincent 拍板后再做)

| 件 | 做 |
|---|---|
| Push 通知 | Service Worker + Web Push API |
| 离线缓存 | SW 缓存 last 50 messages |
| Multi-network 切换 | network picker |
| Self-register | invite link / signup |
| Agent typing indicator | inflight task 显示 spinner |

### Phase 3 — Native 壳 (P2, post-Phase 2)

| 件 | 做 |
|---|---|
| Capacitor iOS / Android | App Store / Play Store 上架, 原生 push 通知 |
| Tauri 桌面 | macOS / Windows / Linux native, 系统通知 |

---

## §7 部署 / Distribution

### MVP

- **本地开发**: `bun install && bun run dev` → http://localhost:5173
- **静态部署**: `bun run build` 出 `dist/` → 任何 CDN (Vercel / Netlify / GitHub Pages / S3 静态站) 都能托管
- **生产域名建议**: `app.agent-network.io` (跟 `agent-network-dashboard.vercel.app` 区分)
- **后端配置**: APP 通过 build-time env `VITE_COMMHUB_URL` 指向 commhub-server URL(默认 `http://localhost:9200`,生产指 `https://commhub.agent-network.io`)

### CORS 注意

commhub-server 现已 `withCors` 开放(见 server/src/index.ts), APP 可跨域请求。**但 SSE EventSource 默认不发 Authorization header** → APP 用 `fetch` 的 ReadableStream 解析 SSE 取代 EventSource 来塞 Authorization header(常见做法, 不阻塞)。原型骨架用 fetch+ReadableStream 实现。

---

## §8 风险 / 边界

| 风险 | 概率 | 影响 | mitigation |
|---|---|---|---|
| `COMMHUB_ENABLE_TMUX` 未开 → Live Log 不能用 | M | L | Live Log 失败时 fallback 显示 "Live log unavailable (admin: enable COMMHUB_ENABLE_TMUX=1)" |
| EventSource Authorization 限制 | H | M | 已选 fetch+ReadableStream 方案 |
| localStorage 存 token 安全 | M | M | MVP 接受 + Phase 2 改 HttpOnly cookie |
| 手机 Safari PWA 限制 (iOS push) | H | L (MVP 不依赖 push) | Phase 2 用 Capacitor 解决 |
| commhub 单 hub down → APP 不可用 | L | H | APP 显示连接状态; 重试 backoff |
| 用户 typo alias → send_task fail | L | L | server 现已 rename canonical resolve(`resolveCanonicalAlias`) |

---

## §9 RFC 待决问题(后续 review 解)

1. **生产域名最终?** `app.agent-network.io` vs 复用 `agent-network-dashboard.vercel.app/app` 子路径 — 通信龙拍
2. **是否要 dashboard 同站合并** — RFC-017 dashboard 是 Next.js, client APP 是 React PWA, 长期是否合并到一个 Next.js? — Phase 2 设计时再决
3. **MVP 用户范围** — Vincent 自己 + 团队 alpha test, 还是直接开 public? — Vincent 拍
4. **Auth 强制 ntok_ 给 SSE 合理吗?** — MVP 强制能用, P2 review 是否给 utok_ SSE 权限(简化)

---

## §10 跟 Tier 1 团队协作

| 团队 | 怎么 reuse | 怎么 协作 |
|---|---|---|
| **commhub-server** (通信工程马) | 现 API surface 100% 复用 | 无改动需求; P2 可选优化 SSE auth |
| **dashboard** (通信文档马 + 通信工程马) | 复用 SSE 长连接模式 + 状态徽章 UI 风格 | 抽公共 `commhub-client.ts` 库, dashboard + APP 共享(Phase 2) |
| **IM 接入** (通信IM马) | 共享 chat 抽象 — APP message vs IM message 都是 task + reply | RFC-020 IM 抽象层做完后, APP 可考虑接入同 abstraction |
| **anet-network-core** | 解耦 — APP 不在 npm chain 上 | 独立 release, 不阻塞 cascade |

---

## §11 Lead-scope decisions (本 RFC 直接定不 gate Vincent, per [[feedback_greater_autonomy]])

1. **Stack**: React + Vite + TypeScript PWA — 定
2. **路径**: `prototype/anet-client-app/` 在主 repo, MVP 阶段不独立仓库 — 定
3. **零新 server 端点** — 定; 复用所有现有
4. **MVP scope 只主线 4 故事** — 定; Phase 2/3 留 Vincent 后续 ramp 决策
5. **Auth utok_+ntok_ 复用现体系** — 定, 不发明新 token 类
6. **Push main 直接, 不开 PR** — per [[feedback_push_workflow]], anet 仓库直接 push

---

## §12 SOP / 红线 遵守清单

- [x] 不动 prod hub (47.116.5.73) — APP 纯本地开发 + 静态部署, 不连 prod commhub
- [x] 不碰本机生产 commhub.db — APP 是 client, 不读 db, 走 HTTP API
- [x] 不发 npm preview — APP 不走 npm chain
- [x] 不做端到端实测(per `feedback_no_host_test_nodes`) — 原型骨架以「能跑起来 + login screen 渲染 + API client 编译通过」为 ship 门槛, 不起本地 hub 实测; Vincent UAT 时用现有 hub 测
- [x] 中文 RFC + code 英文 — per [[feedback_rfc_chinese]]
- [x] 不加 Co-Authored-By Claude — per [[feedback_no_claude_attribution]]
- [x] ETA 用小时不天 — 本 RFC 估 4-6h, 实际 ETA 跟 commhub 报

---

## §13 Author

- **Agent**: 通信SDK马
- **runtime**: claude-code-cli
- **Lead-scope sponsor**: 通信龙 (R7011 dispatch)
- **Vincent context**: telegram 7010 "做APP" + 7012 "派"

---

**End of RFC-022 Draft v0.1.**
