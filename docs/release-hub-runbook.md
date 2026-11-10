# Hub 发版 runbook（2026-10-31 实测版）

> 为什么需要这份：**「卡发布」不是一个状态，它是两件具体的外部动作。**
> 今晚（2026-10-31）实测确认：
> - `~/.npmrc` 里**没有** `_authToken` ⇒ 这台机器发不了 npm 包（红线：令牌必须由人生成，不能代办）
> - `server/package.json` version = `0.9.0-preview.219`，正在跑的 runtime 目录也是
>   `runtime-0-9-0-preview-219` ⇒ **今晚的提交尚未进入任何已发布版本**，发布前必须先 bump
>
> 但代码侧已经验过可部署：用 HEAD 起了一个独立实例（`PORT=18999` + 临时 DB），
> `/health` 返回 200、`cache-control: no-store`、`status: ok`、`version_role: deployment_label`、
> 匿名响应里没有 `git_commit`。⇒ 剩下的是发布动作，不是代码问题。

## 0. 前置检查（不通过就别往下走）

```bash
cd <repo>/server
python3 - <<'PY'
import json, pathlib
v = json.loads(pathlib.Path("package.json").read_text())["version"]
print("package version:", v)
print("running runtime dirs:")
for p in sorted(pathlib.Path.home().glob(".commhub/runtime-*")):
    print("  ", p.name)
PY
```

- 版本号与线上 runtime 目录**相同** ⇒ 必须 bump（否则发了也没变）
- `grep -c _authToken ~/.npmrc` 为 0 ⇒ **停下来**，找有令牌的人

## 1. Bump

```bash
cd <repo>/server
# preview 线按 219 → 220 递增（与 runtime 目录命名一致：runtime-0-9-0-preview-220）
npm version --no-git-tag-version 0.9.0-preview.220
```

同时确认 agent-node 的配对版本（若本次动了 agent-node）：
`agent-node/package.json` 的 version，以及 `scripts/check-pair-published.mjs` 的期望。

## 2. 发布前本地门（三条都必须绿）

```bash
bash scripts/qa.sh --l0                     # 本仓定义的 L0 层（实测 4s，ALL PASS）
python3 scripts/check-test-inventory.py     # 测试清单棘轮
python3 scripts/check-keyset-join.py        # 键集拼接静态门（instrument: valid）
python3 scripts/check-script-references.py  # 「去跑 X」的 X 必须存在
```

## 3. 发布

```bash
cd <repo>/server && npm publish --tag preview   # 需要 _authToken
```

## 4. 重启（这一步会短暂影响全网协调，需要窗口）

```bash
anet hub stop        # 或按部署形态 systemctl / pm2
anet hub start
```

## 5. 发布后验收（**必须是读数，不是「起来了」**）

```bash
HUB=<hub 地址>
curl -s "$HUB/health" | python3 -c 'import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ("ok","status","status_reasons","version","version_role","build_identified")})'
curl -si "$HUB/health" | head -3          # 必须有 Cache-Control: no-store
curl -s "$HUB/health" | grep -c git_commit # 匿名必须为 0（landmark 不进匿名）
```

判据：

| 检查 | 通过的样子 | 说明 |
|---|---|---|
| HTTP | 200 | watchdog 契约不变 |
| `Cache-Control` | `no-store` | 304 会造出 flapping 假阳性 |
| `status` | `ok`（或 `degraded` + 非空 reasons） | 200 只证明「还在」，不证明「还好」 |
| `version_role` | `deployment_label` | 防止把 version 当指纹 |
| 匿名 `git_commit` | 不出现 | landmark 分类生效 |
| 鉴权 `/health` 的 `git_commit` | 等于本次发布的 commit | 这才是代码指纹 |

## 6. 回滚

```bash
# npm 侧：不支持 unpublish 的情况下，把启动指向旧版本目录即可
anet hub stop
# 把运行时切回 ~/.commhub/runtime-0-9-0-preview-219 的安装方式（按部署形态）
anet hub start
```

回滚判据：上面第 5 节的六个格子全部恢复成发布前的读数。
**没有这条判据时，「回滚了」与「重启了一次」同形。**

## 7. 发布后仍要单独验的三件（不随发版自动完成）

- `#3178`：升级后读的是**失败耗时 P50/P95**，不是失败条数（修复只降「多久才知道」）
- `#3168`：向一台 `systemd_supervision=not_supervised` 的节点发 restart-tier 补丁，读 warnings 是否出现
- `#3166`：无 TUI 的 v2 节点切模型后 `startedAt` 是否不变
