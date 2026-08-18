# PM2 fleet boot — Git authority and recovery boundary

This directory versions the non-secret boot chain that was previously present
only on the production host:

```text
systemd --user pm2-fleet.service
  -> ~/.local/bin/pm2-fleet-boot.sh
  -> pm2 resurrect (only when the live PM2 list is empty)
```

The host files are deployment copies. The files here are the reviewable Git
authority. Installing them does **not** authorize a restart or a fleet upgrade.

## Install the software-side boot chain

The current production recipe is deliberately pinned to user `vansin`, NVM
Node `v20.20.0`, and its PM2 binary. A different recovery user or Node layout
requires an explicit reviewed change; do not silently rewrite paths during an
incident.

```bash
install -d -m 700 "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 755 deploy/fleet/pm2-fleet-boot.sh \
  "$HOME/.local/bin/pm2-fleet-boot.sh"
install -m 644 deploy/fleet/pm2-fleet.service \
  "$HOME/.config/systemd/user/pm2-fleet.service"

test "$(git hash-object deploy/fleet/pm2-fleet-boot.sh)" = \
     "$(git hash-object "$HOME/.local/bin/pm2-fleet-boot.sh")"
systemd-analyze --user verify "$HOME/.config/systemd/user/pm2-fleet.service"
systemctl --user daemon-reload
systemctl --user enable pm2-fleet.service

# 🔴 linger 是这条链能否在开机时起来的**前提**,不是可选项。
#    pm2-fleet.service 是 **user** unit(WantedBy=default.target):没有 linger,
#    user manager 只在该用户登录期间存在 —— 机器重启后没人登录,单元根本不会跑,
#    而 `systemctl --user is-enabled` 仍然显示 enabled,看不出问题。
#    此前这里只有下面那条 show-user(**查看**),没有启用步骤:
#    照着走会看到 Linger=no,然后手册没有下一句。
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger      # 必须是 Linger=yes
```

Do not start the unit until the process inventory and recovery inputs below are
ready. `RemainAfterExit=yes` means an active/exited unit only proves that the
oneshot completed once; it does not prove every PM2 app is healthy.

## `dump.pm2` is sensitive backup state, not Git configuration

PM2's generated `~/.pm2/dump.pm2` contains much more than app names and script
paths. It can persist the daemon's inherited environment, including
secret-bearing variables. Therefore:

- never commit, paste, or attach the dump to a public issue;
- store it only as an encrypted owner-controlled backup with restrictive file
  permissions;
- restore secret values from their vault/owner source, never from Git;
- after recovery, recreate apps from their repository authorities where
  possible, complete behavior checks, and only then run `pm2 save`.

The exact encrypted backup record name for the dump and node configs is
**NOT COVERED**. Until an owner supplies it, Git-only recovery is incomplete.

## Current non-secret inventory

[`process-inventory.json`](./process-inventory.json) records the five captured
PM2 app names and their authority status without copying args, environment, or
tokens. It is a review inventory, not an executable secret store.

- Hub and Dashboard launchers belong to this repository.
- The representative OpenCode node has a repository process recipe, but its
  identity, token, node config, and session state require encrypted backup or
  fresh registration.
- `weixin-listen` and `weixin-admin` point outside this repository. Their exact
  repository and build commit are **NOT COVERED**; do not claim full fleet
  reconstruction until that ownership link is filled.

## Recovery and verification order

1. Install the pinned Node/PM2 version and the files above.
2. Restore each service from its listed repository authority. Restore data and
   node identity only from approved encrypted backups, or re-register cleanly.
3. Create/start one app at a time from its ecosystem definition. Do not import
   an unreviewed historical dump merely because it exists.
4. Verify real behavior: Hub health and session count; Dashboard external route
   and version; node identity plus a routed task/reply; external service owner
   checks. `pm2 online` alone is insufficient.
5. Run `pm2 save`, record its encrypted-backup coordinate, then start/enable
   the bootstrap unit.
6. Re-run the behavior checks after a controlled PM2 daemon restart before
   declaring the recovery exercised.

## Upgrade and rollback

Before changing any runtime, record per app: current package/runtime version,
launcher/config path, PID, and behavior result. Upgrade no more than ten nodes
per batch. If a node does not resume heartbeat within ten minutes, stop the
batch and restore its prior runtime/launcher while preserving config/session.

The boot-chain rollback is byte-based: restore the prior checked-in launcher
and unit, verify their hashes, `daemon-reload`, and rerun the same behavior
checks. Never use `pm2 kill`, broad `pkill`, or an `ExecStop` that tears down the
whole fleet as a rollback shortcut.

The checked-in launcher deliberately fails closed when `pm2 jlist` fails or
returns malformed JSON. It must never translate an unknown PM2 state into an
empty fleet and call `resurrect`; issue #742 records the captured production
defect that led to this guard.

## Honest status

The boot script behavior is exercised by the Docker gate in
`tests/test736-pm2-fleet-rebuild/`. A full empty-host production recovery has
not been performed. External Weixin authority, secret backup record names, and
production data restoration remain NOT COVERED.

## 第二层:agent 节点(`anet-nodes-boot.service`)

🔴 **这一层此前只存在于那台机器上。** 仓里有 `pm2-fleet.*`,没有它 —— 于是从仓库看,
「~100 个 agent 节点没有任何开机托管」是一个**看起来完全成立**的结论(#839 就是这么写的),
而实际上托管层一直在跑。**机器没了,这 281 行就没了。**

| | 管什么 | 单元 |
|---|---|---|
| 第一层 | `commhub-hub` / `anet-dashboard` / `weixin-*` | `pm2-fleet.service` |
| **第二层** | **跨 ~20 个 project 的 agent 节点** | **`anet-nodes-boot.service`** |

二层 `After=pm2-fleet.service` —— hub 必须先起来,节点才注册得上。

### 判据的演进(这段历史比脚本本身更值钱)

脚本头部的 v2.2 → v2.5 记着四次**判据从松改紧**,每一次都是「存在 ≠ 可用」的一个新形状:

- **v2.2** 137 个目录里 18 个没有 `config.json` ⇒ 分母改成「有 config.json」;
- **v2.3** 全域重名检测 —— 同一个 alias 有两份 config;
- **v2.4** 分母收窄到「有 config 且 `config.token` 非空」;
- **v2.5** 🔴 `token` **存在**还不够,要看**类型**:有的节点拿的是 `utok_`(用户 token)
  而 SSE 需要 `ntok_`(节点 token)⇒ 判据收紧到三条件
  `(a) 有 config.json` + `(b) runtime ∈ 支持集` + `(c) token 以 ntok_ 开头`。

### 已知缺陷(committed 时就是红的,不假装它是绿的)

`2026-08-18 00:39:16` 那次 `exit 1`:

```
🔴 sweep 未达成：still_missing=6 fail_projects=0 conflict=1 → exit 1
   缺失示例：opencode测试1号 指挥狗 通信狗 P站狗 mino A站狗
```

逐个核过(tmux / pm2 / hub 心跳三个视角):**5 个是真的没起来,1 个是假红。**

- **假红**:`opencode测试1号` 由 **pm2** 托管(`opencode-node-测试1号`,online,心跳新鲜),
  而 post-flight 只枚举 tmux ⇒ **一个正确运行的节点让整个单元 exit 1**。
- 🔴 **同一个判据的另一个方向更危险**:`指挥狗` 的 tmux session(`opencode-指挥狗`)当时**还在**,
  而它在 hub 上已经 offline 41 小时。它被判缺失**纯粹因为 session 名带了前缀、精确匹配没命中**
  —— **是被一个拼写差异救回来的,不是被判据救回来的**。命名一旦统一,这类「壳在、人没了」
  的节点就会被判成「在」。

⇒ **post-flight 应该改判 hub 上该 alias 的心跳新鲜度**,那是唯一与托管方式(tmux / pm2 / 别的)
无关的事实。本次提交**不改判据**,只把东西放进仓里 —— 改判据要单独一条,并且要有能红的夹具。

### 还没被验证过的那一格

`anet-nodes-boot.service` **从未经历过一次真实开机**:机器 `2026-08-17 07:06:39` 起来,
而已知的那次运行是 `2026-08-18 00:36`,差 17.5 小时。**开机链路(linger + WantedBy=default.target)
本身是通的,但「开机时它会不会成功」没有观测。**
