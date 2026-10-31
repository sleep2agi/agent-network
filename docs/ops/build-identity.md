# 构建标识（build identity）：为什么它必须由构建期写下

> 起因：`#3177`。部署 `0.9.0-preview.246` 之后实测 `/health` 的 `build_identified = false`。
> 不是配置问题，是**部署形态**问题。

## 一、问题：运行期读 git 在生产上根本不存在

```
detectBootGitIdentity()  从 module_dir 向上最多 6 层找 `.git`，然后 git rev-parse / status
生产 runtime             ~/.commhub/runtime-…/ 是 `npm install` 的产物 —— **没有 .git**
⇒ commit=null、dirty=null、reason=not_a_git_checkout
⇒ /health 的 build_identified 恒为 false
```

后果不是「少一个字段」，而是：

> **同一版本号、不同字节，在生产上无法分辨。**

`.245` 与 `.246` 正好是这种情况：两份不同的运行时，同一个 `0.9.0-preview.24x` 标签。
任何一次「线上跑的是哪份代码」的问题，都只能靠时间线猜。

## 二、改法：构建期写入，运行期只读

| 环节 | 位置 | 做什么 |
|---|---|---|
| 打包 | `server/scripts/write-build-info.mjs`（`prepack`） | 写 `build-info.json`：`{schema, commit, dirty, built_at, source}` |
| 制品 | `server/package.json` 的 `files` | 把 `build-info.json` 带进 tarball |
| 运行 | `server/src/build-info.ts` + `detectBootGitIdentity` | **先读注入**，读不到再退回 git |
| 暴露 | `/health`（鉴权投影） | `git_commit` / `git_dirty` / `git_identity_root: "build_info"` |
| 部署 | `scripts/deploy-hub-runtime.sh` | `DEPLOY … build_commit=<12位> dirty=…`，并断言 `build_identified === true` |

`build-info.json` 由 `prepack` 生成，**不进 git**（`.gitignore` 已排除）。

## 三、三种状态必须分开（这一节是本文的重点）

`readBuildInfo()` 返回三态，而不是 `BuildInfo | null`：

| 状态 | 含义 | 下一步 |
|---|---|---|
| `present` | 读到且通过严格校验 | 用它 |
| `absent` | 文件不存在 | **正常**：源码检出 / 老制品。回落到 git 或如实报 `not_a_git_checkout` |
| `invalid` | 文件在但形状不对 | **缺陷**：`build_identity_note = build_info_invalid` |

如果把 `invalid` 折成 `absent`，那么「注入写坏了」会读成「本来就没有」——
而后者是正常状态。**故障只有在能被单独看见时才算被处理。**

校验是严格的：`schema === 1`、`commit` 必须 40 位小写 hex、`dirty` 必须是布尔、
`built_at` 必须是 ISO-8601 带 `Z`。每一项都是真实会写错的形态（见 `build-info.test.ts`）。

## 四、两条从这段经历里长出来的规则

1. **stdout 是契约，stderr 是日志。**
   `prepack` 脚本第一版往 stdout 打了一行，就把 `npm pack --json` 的输出污染了 ⇒
   tarball 名为空 ⇒ `build tarball` stage 红、publish skipped。日志必须走 stderr；
   而解析侧也要容忍前缀杂质，并在拿不到 JSON 时**显式 throw**，而不是产出空文件名。

2. **「装进去的目录对」≠「跑起来的是这份字节」。**
   前者由 install 的版本比对保证；后者需要进程自证。
   所以部署脚本会断言 `/health` 的 `build_identified === true`（仅当制品里带 `build-info.json`）。
   失败时 `stage=build_identity_absent(22)` 且**不回滚**——版本与健康都正常，
   回滚会把一个好版本换成更旧的；这是「停下来给人看」，不是「撤回去」。

## 五、还没做的

- `agent-node` / `agent-network` 两个包的制品没有同样的注入（本文只覆盖 `commhub-server`）。
- `/health` 的匿名投影仍然只有一个布尔；要回答「是哪一份」必须用鉴权读或读部署日志。

## 六、2026-10-31：三个包都有了，而且第一次被自己的仪器抓到一次错

三个包（`commhub-server` / `agent-node` / `agent-network`）各自在 `prepack` 时写
`build-info.json`，读侧三份独立实现（不能跨包 import：发布后相对路径会断），**判据同一套**：
`present` / `absent` / `invalid` 三态，坏掉的**不冒充没有**。

### 6.1 writer 的优先级原先反了（实测抓到）

```
agent-network .205 发布日志：ref 9bb1a399 ｜ HEAD is now at 9bb1a3995 ｜ commit=9bb1a399
制品 build-info.json：                                  commit=644c95cd   ← 事件的 sha
```
原因是 `GITHUB_SHA ?? git`，而 release workflow 的 checkout 是
`ref: ${{ inputs.commit || github.sha }}`。**「指定 commit 发布」时两者必然不同**：
被打包的树是 `inputs.commit`，`GITHUB_SHA` 是分支 HEAD。

⇒ 改成 **git 优先**（`git rev-parse HEAD` 描述的是这棵树），`GITHUB_SHA` 只兜底没有 `.git` 的安装树；
两者都有且不同时记 `event_sha`，并在 stderr 说清。语义因此定死：

> **`commit` 描述被打包的那棵树；`event_sha` 描述触发事件（只在两者不同时出现）。**

`agent-node@2.5.0-preview.171` 实测：`commit=4bb7094b… source=git dirty=false`，与 dispatch 一致。

### 6.2 判据：「同版本、不同字节必须可分辨」怎么算通过

这条判据**不能**用「读到了一个 40 位 hex」来证明 —— 那只能证明格式。
可执行的形态是：**造两个同为 `.171` 却来自不同树的安装，读侧必须给出不同的 commit。**

```bash
git worktree add /tmp/wt-a 4bb7094b && git worktree add /tmp/wt-b 1c0ed8f5
(cd /tmp/wt-a/agent-node && npm pack --json)     # version 都是 2.5.0-preview.171
(cd /tmp/wt-b/agent-node && npm pack --json)
# 解包后各读一次 build-info，再各跑一次 readBuildInfo(dir)
```

2026-10-31 实测读数：

| 安装 | version | tarball 字节 | commit |
|---|---|---|---|
| A（4bb7094b 打包） | `2.5.0-preview.171` | 6607 | `4bb7094b50ec…` |
| B（1c0ed8f5 打包） | `2.5.0-preview.171` | 6604 | `1c0ed8f5d8a2…` |
| npm 上的 `.171` | `2.5.0-preview.171` | — | `4bb7094b50ec…`（与 A 一致） |

⇒ 同版本、不同字节 ⇒ 读侧给出不同 commit。**这条判据在 6.3 之前一直只是断言，今天是第一次有读数。**

### 6.3 这条判据**不**覆盖什么（必须写在旁边）

`commit` 是**仓库级**的树标识，不是「这个包目录的子树哈希」。

- 两个只差 `.github/` 的提交，`agent-node/` 的内容逐字节相同，`commit` 仍会不同；
- 反过来，工作树脏（`dirty=true`）时，两份 `dirty` 安装可能共用一个 `commit` ——
  此时分辨它们要的第二个量是「构建时间 + 构建主机」，而这两个都不在 `build-info.json` 里。

所以它的用法只有一句：**回答「这台机器跑的是哪一次构建」，不回答「这份二进制是不是被改过」。**
后者需要签名或内容哈希，属于另一张卡。
