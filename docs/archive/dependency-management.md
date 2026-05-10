# 依赖安装方案

> 状态：草稿 | 日期：2026-04-10 | 作者：SDK马

---

## 包关系图

```
用户安装
  └── @sleep2agi/agent-network (anet CLI)      ← 入口，全局安装
        ├── 内置 CommHub SDK client
        └── spawn 时需要:
              ├── @sleep2agi/agent-node         ← codex-sdk / claude-agent-sdk runtime
              │     ├── @anthropic-ai/claude-agent-sdk (peer dep)
              │     └── @openai/codex-sdk (peer dep)
              ├── claude CLI (@anthropic-ai/claude-code) ← claude-code-cli runtime
              └── codex CLI (@openai/codex)      ← codex-sdk 的底层 CLI

可选:
  └── @sleep2agi/commhub-server                 ← 自建 CommHub Server
```

## 按 runtime 的依赖矩阵

| runtime | 必须全局安装 | 说明 |
|---------|------------|------|
| `claude-code-cli` | anet + claude CLI | `claude auth login` 登录 |
| `codex-sdk` | anet + agent-node + codex CLI | `codex auth login` 登录 |
| `claude-agent-sdk` | anet + agent-node + claude CLI | Claude Agent SDK 底层 spawn claude CLI 子进程 |

## 依赖检测三态

| 状态 | 含义 | 显示 |
|------|------|------|
| installed | 已安装且版本兼容 | ✅ agent-node v1.1.0 |
| available | 命令存在但版本不兼容或无法解析 | ⚠ agent-node v0.9.0 (需要 >= 1.0.0) |
| missing | 未安装 | ❌ agent-node 未安装 |

## anet setup（新用户入口）

```bash
$ anet setup

检测已安装的包...
  ✅ anet v1.2.0
  ❌ agent-node — 未安装
  ✅ claude CLI v2.1.39
  ❌ codex CLI — 未安装
  ❌ commhub-server — 未安装

? 你需要哪些 runtime？（空格选择，回车确认）
  [x] claude-code-cli    — Claude Code CLI（已就绪 ✅）
  [x] codex-sdk          — Codex SDK（需要安装 agent-node + codex CLI）
  [ ] claude-agent-sdk   — Claude Agent SDK（需要安装 agent-node）

? 要安装 CommHub Server 吗？（本地开发/测试用）
  [ ] commhub-server

即将安装:
  npm install -g @sleep2agi/agent-node@^1.1.0
  npm install -g @openai/codex@latest

确认？(y/n): y

安装中...
  ✅ @sleep2agi/agent-node@1.1.0
  ✅ @openai/codex@0.118.0

验证:
  ✅ agent-node v1.1.0
  ✅ codex v0.118.0
  ⚠ codex 需要登录: codex auth login

完成！下一步: anet create <node-name>
```

## anet upgrade（统一升级）

```bash
$ anet upgrade

检测已安装的包...
  anet             v1.2.0  → v1.3.0 ⬆
  agent-node       v1.0.2  → v1.1.0 ⬆
  claude CLI       v2.1.39 （最新）
  codex CLI        v0.118.0（最新）
  commhub-server   未安装

升级:
  npm install -g @sleep2agi/agent-network@latest
  npm install -g @sleep2agi/agent-node@latest

确认？(y/n): y

  ✅ anet v1.3.0
  ✅ agent-node v1.1.0

npx 缓存已清理 ✅
```

实现要点：
- 只升级已安装的包，不装新的
- 升级后跑 `anet -v` 展示全量版本

## anet create 依赖检测

```bash
$ anet create 小明 --runtime codex-sdk

[anet] 检测 codex-sdk 依赖...
[anet] ❌ agent-node 未安装
[anet] ❌ codex CLI 未安装

[anet] 缺少依赖，运行 "anet setup" 安装:
  anet setup
```

create 不自动安装，只提示导向 setup。create 本身只生成 config.json。

## anet start 兼容性门禁

```bash
$ anet start 小明

[anet] 检测依赖版本...
[anet] ❌ agent-node v0.9.0 < 1.0.0（需要 >= 1.0.0）
[anet] 运行: anet upgrade
```

兼容矩阵：

| 约束 | 说明 |
|------|------|
| anet >= 1.0.0 需要 agent-node >= 1.0.0 | config 格式变更 |
| agent-node codex-sdk 需要 codex CLI 可用 | SDK spawn CLI |
| agent-node claude-agent-sdk 需要 claude CLI 可用 | SDK spawn claude CLI 子进程（待确认：是否所有场景都需要） |

## 版本探测实现

```typescript
async function detectVersion(command: string): Promise<string | null> {
  try {
    const { execSync } = await import("child_process");
    const output = execSync(`${command} --version`, { encoding: "utf-8", timeout: 5000 }).trim();
    // 提取版本号: "agent-node v1.1.0" → "1.1.0"
    const match = output.match(/v?(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

// 探测所有包
const versions = {
  anet: PKG_VERSION,
  "agent-node": await detectVersion("agent-node"),
  claude: await detectVersion("claude"),
  codex: await detectVersion("codex"),
  "commhub-server": await detectVersion("commhub-server"),
};
```

## 新用户完整流程

```bash
# 1. 安装入口
npm install -g @sleep2agi/agent-network

# 2. 交互式装依赖
anet setup

# 3. 配置 hub
anet init --hub http://YOUR_IP:9200

# 4. 创建 node
anet create 指挥室

# 5. 启动
anet start 指挥室
```

最短路径（已知 runtime）：
```bash
npm install -g @sleep2agi/agent-network @sleep2agi/agent-node
anet init --hub http://YOUR_IP:9200
anet create 小明 --runtime codex-sdk
anet start 小明
```

## 不要做的事

- ❌ 不自动升级（只提示）
- ❌ 不装多余的包（按 runtime 选择性安装）
- ❌ 不固定 CLI 工具版本（claude/codex 由用户管理）
- ❌ 不替换用户已有的全局包（只检测版本）
- ❌ 不在 agent-node 里检测依赖（这是 anet CLI 的职责）

## 决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | anet setup 交互式 | 新用户友好，不装多余的 |
| 2 | anet upgrade 只升已装包 | 不意外引入新依赖 |
| 3 | anet create 缺依赖时提示安装 | 及时发现，不用跑到 start 才报错 |
| 4 | anet start 硬失败 | 版本不兼容会导致奇怪错误 |
| 5 | agent-node 不管依赖检测 | 职责分离，agent-node 专注运行 |
| 6 | 清 npx 缓存 | 避免旧版本残留 |

---

**请通信牛 review。文件路径: ~/agent-orchestra/docs/dependency-management.md**
