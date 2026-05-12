# V3 Trial Period + License Key Design（已废弃 - 历史设计稿）

> **⚠️ 本文档已不代表当前方向（2026-05-12 更新）**
>
> 本文写于 V3 早期（2026-03 ~ 04），描述的是"14 天试用 + license key + 官方托管"的商业模式。**该方向已被废弃**（2026-04 转向），原因是产品定位转向开源工具 + 自部署，不做官方 SaaS 托管。
>
> **当前真实商业模式**：
> - Apache 2.0 开源
> - **课程**（B 站系列教程）
> - **服务咨询**（企业落地辅导）
> - 不做 SaaS 托管 / 不卖 license key
>
> **代码现状**：
> - Hub server 仍保留 SQLite `licenses` 表 + `send_task` 过期检查作为后向兼容。如果命中 `license_expired`，按 [troubleshooting](https://anet.sh/troubleshooting) 清空 licenses 表即可。
> - `anet license` / `anet activate <key>` CLI 命令在 `cli.ts` 仍存在但不再推荐使用，[RFC-001](rfcs/RFC-001-deprecate-commhub-auth-token.md) 之后的整体清理会一并移除。
>
> 本文保留为**历史归档**，方便理解为什么 hub 还有 license 相关代码路径。**新用户请忽略本文。**

## 商业模式（已废弃，仅作历史参考）

```
免费试用 (14天) → 到期提示 → 输入授权码继续使用
                              → 或连接官方免费托管网络
```

## 两种部署模式

### A) 官方托管网络 (免费)
- 用户直接 `anet init --hub https://hub.sleep2agi.com`
- 无需自部署 Server
- 共享网络, 有配额限制 (100 tasks/day, 5 agents)

### B) 自部署 Server (试用+授权)
- `bunx @sleep2agi/commhub-server`
- 14 天免费试用, 全功能
- 到期后:
  - 只读模式 (可查询, 不可发任务)
  - 输入授权码恢复: `anet activate <license-key>`
  - 或购买: https://sleep2agi.com/pricing

## License Key 格式

```
anet-XXXX-XXXX-XXXX-XXXX
```

16 字符, 4 组, A-Z0-9。包含:
- 产品: anet
- 类型: trial / pro / team / enterprise
- 过期: 编码在 key 中 (HMAC 校验)

## 数据库

```sql
-- licenses 表 (在 server 端)
CREATE TABLE IF NOT EXISTS licenses (
  id            TEXT PRIMARY KEY,
  license_key   TEXT UNIQUE NOT NULL,
  type          TEXT DEFAULT 'trial',     -- trial/pro/team/enterprise
  max_agents    INTEGER DEFAULT 5,
  max_networks  INTEGER DEFAULT 1,
  max_tasks_day INTEGER DEFAULT 100,
  activated_at  TEXT,
  expires_at    TEXT,
  owner_id      TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

## Server 启动检查

```typescript
// 启动时检查 license
const license = getLicense();
if (!license) {
  // 首次启动: 自动创建 14 天 trial
  createTrialLicense();
  console.log("🎉 14-day free trial started!");
} else if (isExpired(license)) {
  console.log("⚠ Trial expired. Run: anet activate <key>");
  console.log("  Or use free hosted: anet init --hub https://hub.sleep2agi.com");
  // 进入只读模式: send_task 返回 license_expired 错误
}
```

## CLI

```bash
anet activate <license-key>    # 输入授权码
anet license                   # 查看当前 license 状态
anet license --trial           # 显示剩余试用天数
```

## API

```
GET  /api/license              # 当前 license 信息
POST /api/license/activate     # { key: "anet-XXXX-..." }
```

## 实施计划

### Phase 1: Trial 基础
1. licenses 表 + 首次启动自动创建 trial
2. Server 启动检查 + 过期提示
3. send_task 检查 license (过期 → 拒绝)
4. anet license / anet activate CLI

### Phase 2: 授权码生成
1. 管理后台生成 license key
2. HMAC 校验 (离线验证)
3. 不同 tier 的配额限制

### Phase 3: 官方托管
1. hub.sleep2agi.com 部署
2. 免费 tier 配额管理
3. 付费 tier 对接支付
