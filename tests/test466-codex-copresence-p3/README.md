# test466 — real Codex co-presence identity teardown

This suite closes the evidence gap recorded by issue #466 and PR #477.  It
starts the installed Codex `app-server`, the real agent-node bridge, and the
installed Codex remote TUI inside isolated Docker/tmux sessions.

The security-bearing case replaces a lost real app-server tmux session with
an unrelated session of the same name but a different marker.  `anet node
stop` must reap the real marker generation and leave the impostor alive.  A
name-based fallback therefore turns the case red.

No host config, token, session, port, or production process is mounted.

## 为什么这个套件不在 CI 矩阵里（2026-10-29 实测，别再试着接回去）

它需要**真实的 Codex 登录**。套件给节点用隔离的 `CODEX_HOME`，CI runner 上那个 HOME 里
没有任何可用凭据，于是 TUI 停在登录页、三件套起不来：

```
[anet] ⚠ test466-codex started but its TUI is waiting on an interactive prompt
  Blocked on: the codex sign-in page.
  Its isolated CODEX_HOME has no usable credential.
FAIL real three-piece co-presence did not start
```

（`#604` 曾把它当「漏登记」接进 `hub semantics` 矩阵，跑出来就是上面这段。
那不是接线错误，是**凭据依赖**——CI 里没有 codex 账号。）

手工跑之前另需注意：`HOME` 必须在**非 world-writable** 目录下（`/tmp` 是 1777），
否则包身份校验会直接拒绝：`directory /tmp … is mode 1777`。`run.sh` 已默认
`WORK=/app/.work/test466` 并 `chmod 700`。
