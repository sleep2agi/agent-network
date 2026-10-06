# CommHub v0.9.0-preview.108

本版带上 `0.9.0-preview.107`（发版合并 `d25d89ff`，#2433）之后合入的 Hub 改动。`git log d25d89ff..<发版提交> -- server/` 列出：

| 提交 | PR | 内容 |
|---|---|---|
| 9428e4d8 | #2440 | #649：用弱密码登录成功时，Hub 给账号打上 `must_change_password` 标记 |
| d174f894 | #2434 | #637 #638：`server/` 里只改了两处注释（daemon 写密钥的文件名改称 `secrets.env`），Hub 行为不变；功能部分已随 agent-node `2.5.0-preview.116` 发布 |

## 你会看到的变化

- **弱密码登录会被要求改密码（#2440，#649，安全）。** `POST /api/auth/login` **成功**时，如果明文密码不满足注册 / 改密码用的同一条强度规则（`validatePasswordStrength`：少于 8 个字符，或在弱密码表 `WEAK_PASSWORDS` 里，不分大小写），Hub 把 `users.must_change_password` 置为 `1`，并在登录响应里带 `must_change_password: true`。
  - 主要针对 #261（2026-06-28）加入这个标记之前建的账号：它们的标记是 `0`，有的仍在用旧的启动默认密码。
  - 🔴 行为变化：仍在用弱密码的账号，升级后**下一次登录**就会被标记，客户端会要求改密码。改成强密码（`POST /api/auth/password`）后标记清除，之后登录的响应不再带这个字段。
  - 登录失败从不改标记。已被标记的账号仍照旧报告（与 #261 相同）。写标记失败只记 `user_id`，从不记录密码。
  - 生产库里的已有账号不会被批量改动，只在它们下次登录时判断。

## 数据库与设置

- 不新增表、不改表结构；只会把已有列 `users.must_change_password` 置为 `1`。
- 没有新的环境变量、端口或密钥来源，默认值都不变。`hub.env` 不用动。

## 检查

- **`tests/hub-release-compat`**：见 PR 说明（候选为 main `9428e4d8` + 本版本号，基线 npm 上的 `0.9.0-preview.107`，App desktop-v0.2.212 / .213 / .214 / .215）。
- #2440：`server/src/auth-weak-password-login.test.ts` 10 个用例，每个都对 `bootServer({port: 0})` 发真实 `POST /api/auth/login`：太短、弱密码表、弱密码表的大写变体、旧 sha256 哈希的弱密码（同时重哈希为 scrypt）都被标记；强密码不标记、响应无该字段；错误密码 401 且不改标记；已标记账号用强密码登录仍报告；弱密码登录后改成强密码，标记回到 0。登录过程的控制台输出不含明文。去掉新增代码块后 10 个里 6 个变红。由 `tests/test798-server-unit-ci` 自动收进 CI。

本说明不代表已发布。只通过 release.yml、用包含这些改动的 main 完整 SHA 发布：
包 `@sleep2agi/commhub-server`，版本 `0.9.0-preview.108`，渠道 preview。

promote 时的 `must_contain`：`weak-password flag write failed`（本树 `server/src/auth.ts` 有 1 处；npm 上 `.107` 的 tarball 里 0 处）。

## Install

在允许安装的隔离环境里（Hub 需要 Bun）装确切版本：

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.108
```

安装命令本身不会切换任何生产进程。

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.108
```

不迁移数据，已有设置含义不变。🔴 升级前确认要长期登录的脚本 / 探针账号用的是强密码：弱密码账号升级后下次登录会收到 `must_change_password: true`。

## 回滚

回到 `0.9.0-preview.107` 是安全的：不改表结构。回滚后弱密码登录不再自动标记，但已经被置为 `1` 的标记保留，直到该账号改密码。

不要覆盖已发布的包。包内不含任何已有数据、用户、网络成员或密钥。
