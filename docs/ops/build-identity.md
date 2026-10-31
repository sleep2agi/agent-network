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
