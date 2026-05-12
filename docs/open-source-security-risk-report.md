# Agent Network 开源前安全风险审计报告（历史 - 阻断项已处理）

审计日期：2026-05-10  
审计范围：当前工作区（对应远端 `github.com/sleep2agi/agent-network`）。  
审计目标：评估项目开源发布、npm 发布、按文档部署时的安全风险，并给出修复优先级。

> **⚠️ 当前状态（2026-05-12 更新）**
>
> 本报告中标记为阻断（P0）的项已在 v0.8.0 / v0.8.1 全部处理：
> - ✅ master token (`COMMHUB_AUTH_TOKEN`) 软废弃 + admin utok_ bootstrap → [RFC-001](rfcs/RFC-001-deprecate-commhub-auth-token.md) Phase 2
> - ✅ 密码强度 ≥ 8 + 弱密码字典；首次 `anet hub start` 自动 prompt admin
> - ✅ install.sh / hub-only.sh 默认 localhost + 风险 banner
> - ✅ README 加 SECURITY DISCLAIMER
> - ✅ 生产部署指南补 TLS / 反向代理 / 备份 checklist
> - ✅ 仓库 OSS-readiness scan 三个 repo 全过；dashboard 历史 PAT 泄漏已 nuke 历史
>
> **项目已于 2026-05-11 正式开源**（Apache 2.0）。本报告保留为审计记录。
>
> 仍未关闭的：Argon2id 哈希迁移（v0.9+，task 跟踪在 GitHub Issues）；server `shell:true` spawn 审计（持续中）。

## 结论摘要（历史，仅作审计记录）

当前项目不建议直接开源或扩大公开部署。需要先处理以下阻断项：

1. **凭证泄露风险已经存在**：本地 git remote 使用了内嵌 GitHub PAT 的 HTTPS URL；本地 `.env` 包含 `NPM_TOKEN` 和 GitHub token。虽然 `.env` 被忽略，但 remote token 需要立即轮换。
2. **直接启动 server 是 open mode**：`commhub-server` 默认 `HOST=0.0.0.0`，且未设置 `COMMHUB_AUTH_TOKEN` 时所有需要 `requireAuth()` 的接口放行。暴露后可远程调用 MCP、REST、tmux HTTP/WebSocket。
3. **默认账号和一键脚本会放大公网风险**：CLI 和文档默认创建/宣传 `admin / anethub`；一键云服务器脚本默认绑定 `0.0.0.0`，并提示开放 9200/3000。
4. **MCP/SSE 多网络隔离不完整**：部分 MCP 读工具没有按用户 membership 收窄；SSE 只按 alias 建通道，任意有效 token 可订阅其他 alias 的事件。
5. **认证和凭证存储需要加强**：密码是静态盐 SHA-256；token 可放 URL query；登录 token 默认无过期；CLI 把 token/API key 写入配置但未统一 `chmod 600`。

## 方法和证据来源

- 查看 git 状态：当前分支 `main`，工作区无已跟踪改动。
- 查看远端：`origin` 为带 PAT 的 HTTPS URL，报告内只保留脱敏形式。
- 静态审计：`server/src/*`、`agent-network/bin/cli.ts`、`agent-node/src/cli.ts`、安装脚本、README、测试脚本。
- secret 搜索：排除 `.git`、`node_modules`、二进制图片后搜索 token/API key/default password 相关模式。
- npm 发布边界：执行 `npm pack --dry-run --json`，确认三个 npm 包未包含 `.env`、`.anet`、本地数据库等文件。
- 依赖审计：`agent-network` 的 `npm audit` 为 0 个漏洞；`docs-site` 有 5 个 moderate 漏洞。
- 未运行 Docker E2E；本报告是静态审计 + npm pack/audit 结果，不替代完整渗透测试。

## 风险清单

| ID | 严重级别 | 风险 | 影响 | 证据 | 修复建议 |
|---|---:|---|---|---|---|
| R1 | Critical | Git remote 内嵌 GitHub PAT | 任何拿到本机配置、日志或误贴输出的人都可能获得仓库权限 | `git remote get-url origin` 显示 `https://***REDACTED***@github.com/sleep2agi/agent-network.git` | 立即 revoke/rotate 该 PAT；改为 SSH remote 或 GitHub credential manager；检查 GitHub audit log；确认 token 没进 shell history/CI 日志 |
| R2 | High | 本地 `.env` 有发布 token | 若误提交、打包或分享工作区，会泄露 npm/GitHub 发布权限 | `.env` 存在 `NPM_TOKEN`、`SLEEP2AGI_GITHUB_TOKEN`；`.gitignore:2` 忽略 `.env` | 开源前清理工作区；使用 secret manager；执行 gitleaks/trufflehog 全历史扫描；为 npm token 限制 scope/2FA |
| R3 | Critical | `commhub-server` 直接启动默认 open mode | 公网暴露后可匿名调用 MCP/REST/tmux 控制面 | `server/src/index.ts:9-11` 默认 `HOST=0.0.0.0`；`server/src/index.ts:73-88` 未设置 token 时放行；`server/README.md:18-22` 支持直接 `bunx` | 默认必须要求鉴权；未显式 `--dev-open` 时拒绝启动；默认监听 `127.0.0.1`；文档禁止生产 open mode |
| R4 | Critical | open mode 下 tmux HTTP/WebSocket 可远程读写终端 | 可读取 tmux 输出、向 tmux 注入按键，接近远程命令执行 | `server/src/index.ts:244-248` WebSocket 仅 `requireAuth()`；`server/src/index.ts:780-825` tmux capture/send；open mode 下 `requireAuth()` 放行 | tmux 功能默认关闭；仅 admin + 本机/allowlist 可用；加 CSRF/origin 检查；不要暴露到公网 |
| R5 | Critical | 一键脚本公网部署默认弱账号 | 用户照文档开安全组后，外网可尝试默认 `admin/anethub` | `docs-site/docs/public/hub-only.sh:35` 默认 `0.0.0.0`；`:163` 启 hub；`:231` 打印默认账号；`README.md:63-70` 明示默认凭证 | 首次启动强制生成随机密码或交互设置；公网脚本默认只 bind localhost；拒绝默认密码公网启动；文档移除默认密码示例 |
| R6 | High | hub-only root 阶段创建 NOPASSWD sudo 用户 | 一键脚本被滥用或用户环境被攻陷时，`anet` 用户可无密码提权 | `docs-site/docs/public/hub-only.sh:47-50` 写入 `anet ALL=(ALL) NOPASSWD:ALL` | 删除 NOPASSWD；仅按需授予最小 sudo；systemd 服务用受限用户、`NoNewPrivileges`、`ProtectSystem` |
| R7 | High | MCP 读工具未完整做 membership scope | 拥有任意有效 user token 的用户可读全局状态、inbox、task、completion，造成跨网络/跨租户泄露 | `server/src/tools.ts:261-286` `get_inbox` 无读权限检查；`:329-355` `get_all_status` 可无 scope；`:697-755` `get_task/list_tasks` 无读检查；`:879-909` `get_completions` 无读检查 | 增加 `canRead()`；user token 默认限定其所有 networkIds；客户端传 `network_id` 时验证 membership；无 network scope 时拒绝 |
| R8 | High | SSE 通道只按 alias，不按 token/network | 任意有效 token 可订阅其他 alias 事件；`send_message`/broadcast 事件会泄露内容片段或全文 | `server/src/index.ts:281-286` 只解析 path alias；`server/src/push.ts:17-34` clients map key 为 sessionName；`server/src/push.ts:71-80` push 只按 sessionName | `/events/:alias` 解析 token 后校验 alias 所属 network；SSE key 改为 `network_id + alias`；事件不要携带消息正文 |
| R9 | High | 密码哈希为静态盐 SHA-256 | 数据库泄露后可快速离线爆破，尤其默认/弱密码 | `server/src/db.ts:326-328` `sha256("anet:"+password)`；`server/src/auth.ts:26` 最低 6 位 | 使用 Argon2id/bcrypt/scrypt，per-user salt 和参数版本；提高密码策略；为默认账号强制改密 |
| R10 | High | token 可通过 URL query 传递 | token 容易进入浏览器历史、代理日志、Referer、server access log | `server/src/index.ts:73-77`、`:92-96`、`:360-363`、`:462-479` 多处读取 `?token=` | 禁止 query token，或仅短期一次性 token；统一只接受 `Authorization: Bearer` |
| R11 | Medium | 登录 token 默认无过期且登录会累积 token | 凭证泄露后长期有效；用户多次登录产生多个活跃 token | `server/src/auth.ts:88-96` 每次登录插入新 token；`server/src/db.ts:181-190` `expires_at` 可空 | 给 user/session token 设置默认 TTL；支持 refresh/rotate；列表显示 last used/IP/device；提供一键 revoke all |
| R12 | Medium | API token scope 字段未被充分执行 | `api_tokens.scope` 存在，但 `resolveToken()` 不返回/校验 scope，容易把 token 当 full 使用 | `server/src/auth.ts:129-151` resolve 只返回 user/network/tokenName；`server/src/db.ts:181-190` 有 scope 字段 | 在 auth context 中返回 scope；按 endpoint/tool enforce `user/network/full/read/write/admin` |
| R13 | Medium | license 激活接口无鉴权且“任意 anet-*”即 pro | 任何人可篡改 license 状态，若商业功能上线会直接被绕过 | `server/src/index.ts:305-321` public activate；`tests/test3-security/run.sh:102-111` 把 fake pro key 作为通过用例 | license 接口 admin-only；服务端签名校验；测试应把未授权激活视为失败 |
| R14 | Medium | rate limit 信任客户端可伪造 header | 攻击者可通过伪造 `X-Forwarded-For` 绕过 login/register 限流；localhost/unknown 跳过限流 | `server/src/index.ts:39-53` 跳过 unknown/localhost；`:329`、`:344` 直接读 `x-forwarded-for` | 只在受信任反代后使用 forwarded header；否则用 socket IP；对所有来源限流；加账号维度限流 |
| R15 | Medium | 本地配置文件含 token/API key 但未统一设权限 | 多用户机器上可能被同组/其他用户读取；备份/同步工具也可能泄露 | `agent-network/bin/cli.ts:51-66` save config 无 chmod；`:188-207` node config 无 chmod；`:1444-1449` `.anet/.env` 写 token 无 chmod；`agent-node/src/cli.ts:191-199` 写回 session 无 chmod | 所有含 secret 的文件创建后 `chmod 600`；目录 `700`；配置分离 secret 与非 secret |
| R16 | Medium | 安装脚本供应链风险高 | `curl | bash`、NodeSource/Bun/npx/npm 全局安装，缺少 checksum/SLSA/固定版本策略 | `docs-site/docs/public/install.sh:43-48` 全局 npm；`setup-anet.sh:61-72` apt + NodeSource + Bun；`hub-only.sh:67-78` 同类逻辑 | 提供可校验 release artifact；pin 版本和 checksum；文档提示审阅脚本；生产建议 Docker image digest |
| R17 | Medium | HTTP 明文传输是默认文档路径 | user token、network token、模型 API key 相关操作可能在局域网/公网明文传输 | README、docs 多处使用 `http://...:9200`；`agent-only.sh:7` 示例远端 HTTP | 生产文档必须要求 HTTPS/TLS；支持 `anet hub start` 反代模板；拒绝公网 HTTP 默认向导 |
| R18 | Medium | PostgreSQL adapter 把连接串嵌入 `node -e` 进程参数 | 同机用户可通过进程列表看到 DB credential；每 query spawn 也易被 DoS | `server/src/db-adapter.ts:143-164` script 中 JSON.stringify connection string | 改为长驻 worker/async pg client；连接串只放 env/stdin；避免出现在 argv |
| R19 | Low | `/health` 泄露运行状态 | 未授权可看到版本、auth 状态、SSE session 名称 | `server/src/index.ts:621-639` 返回 version/auth/sse_sessions/license | 生产模式减少 health 内容；详细健康信息 admin-only |
| R20 | Low | docs-site 依赖有 moderate 漏洞 | 主要影响开发服务器/文档构建链；不是核心运行时，但开源后会被审计工具标红 | `npm audit`：docs-site 有 `esbuild`、`vite`、`vitepress`、`uuid` 等 5 个 moderate | 升级 vitepress/vite/esbuild/uuid；若无可用 fix，在 SECURITY/README 说明影响范围 |

## 开源发布卫生检查

### 已确认较好的点

- `npm pack --dry-run` 显示 `@sleep2agi/commhub-server` 只包含 `src`、`bin`、README/LICENSE/package；未包含 `.env`。
- `@sleep2agi/agent-network` 包只包含 `dist`、README/LICENSE/package；未包含 `.anet` 和源码中的本地状态。
- `@sleep2agi/agent-node` 包只包含 `dist/cli.js`、README/LICENSE/package。
- `.gitignore` 覆盖 `.env`、`.env.*`、`.anet/`、runtime logs；`git ls-files` 只跟踪 `.env.example`。
- `SECURITY.md` 已存在并说明私下报告渠道。

### 开源前必须清理

- 轮换 GitHub PAT 和 npm token。
- 将 remote 改为不含凭证的 URL，例如 `git@github.com:sleep2agi/agent-network.git`。
- 删除或重建本地 `.env`、`.anet/`、`channel/.anet/`、`channel/.opencode/`、demo `.env`，确保不会被打包/截图/压缩分享。
- 对 git 全历史跑 secret scan，而不是只扫当前树。
- 在 GitHub 仓库启用 secret scanning、push protection、Dependabot alerts、private vulnerability reporting。

## 测试覆盖缺口

现有 `tests/test3-security/run.sh` 覆盖了 SQL 注入、基础鉴权、token revoke、跨网络 token 创建等，但存在明显缺口：

- 测试总是设置 `COMMHUB_AUTH_TOKEN`，没有覆盖 `AUTH_TOKEN` 缺省时的 open mode。
- 没有测试 MCP user token 跨网络读取 `get_inbox/get_all_status/list_tasks/get_completions`。
- 没有测试 `/events/:alias` 的跨网络订阅。
- 没有测试 `/api/tmux/*` 和 `/ws/tmux/*` 的权限边界。
- license 测试把任意 `anet-*` key 升级 pro 当作成功，这与商业/生产安全目标冲突。
- 没有 password hash/KDF、token TTL、query token 泄露、配置文件权限的安全测试。

建议新增 Docker 测试套件：

1. `test28-open-mode-hardening`：无 `COMMHUB_AUTH_TOKEN` 时生产启动应失败，或所有敏感接口仍需 auth。
2. `test29-mcp-network-read-scope`：两个用户/两个网络，验证 user token 不能读对方 inbox/task/status。
3. `test30-sse-network-scope`：验证 token 只能订阅本网络 alias。
4. `test31-tmux-admin-only`：验证 tmux HTTP/WS 仅 admin 且默认关闭。
5. `test32-secret-file-permissions`：验证 `~/.anet/config.json`、node config、`.anet/.env` 权限为 `600`，目录为 `700`。

## 修复优先级

### P0：开源/公开部署前必须完成

1. Revoke/rotate 已暴露的 GitHub PAT、npm token，并清理 remote。
2. 关闭 server open mode：默认 auth required + 默认 bind localhost；必须显式 `--dev-open` 才可无鉴权。
3. 移除公网默认 `admin/anethub`；生成随机初始密码或强制交互设置。
4. 修复 MCP 读权限和 SSE network scope。
5. tmux 控制面默认关闭，改为 admin-only + localhost/allowlist。

### P1：首个公开版本前完成

1. 密码哈希改 Argon2id/bcrypt/scrypt。
2. 禁用 query token。
3. token TTL、revoke all、scope enforcement。
4. 所有 secret 配置文件 `chmod 600`，目录 `700`。
5. 安装脚本 pin 版本/checksum，文档增加 HTTPS/反代部署。

### P2：持续安全建设

1. docs-site 依赖升级并记录 audit 状态。
2. PostgreSQL adapter 去掉 `node -e` argv 中的连接串。
3. health endpoint 生产降噪。
4. 新增 Docker 安全测试套件并接入 CI。

## 是否可以开源

如果只是把代码仓库公开，但不发布 npm、不引导公网部署，最低要求也应先完成 R1/R2 的凭证轮换和历史扫描。  
如果要发布 npm 包、开放文档并鼓励用户部署，至少需要完成 P0 全部事项。当前状态下，最大的真实风险不是 npm 包误带 `.env`，而是用户按 README/一键脚本部署后暴露弱认证 Hub，以及多租户隔离绕过。
