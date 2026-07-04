# GA-blocker #2 → create-node wizard end-to-end shots

Vincent asked twice for step-by-step screenshots of the dashboard's
create-node wizard against a live hub + `host_supervisor` daemon.

Reuses the `p-ga2-compat-repro/` docker (aligned versions,
`config_snapshot` populated on first shot, `list_host_supervisors`
count=1). Same container gets kept alive with `repro-stay.sh`, port
9234 forwarded to host. Dashboard prod build (`origin/main`, includes
#33 admin-picker fix) runs on host, `COMMHUB_URL=http://127.0.0.1:9234`.
Playwright drives cookie-inject admin → `/nodes` → new wizard.

## The 11 shots (0 → success)

| File | Step | Notes |
|------|------|-------|
| `00-nodes.png` | `/nodes` landing | admin session already established via `POST /api/auth/v3` |
| `01-step0-picker.png` | ⓪ 服务器 | picker rendered `将在 ga-daemon (…) 上创建` (count=1 auto-pick) — the #33 GA-blocker fix path in action |
| `02-step0-daemon-selected.png` | ⓪ 服务器 (after click) | picker echoes runtime badges (claude-agent-sdk / codex-sdk / grok-build-acp) — sourced from `daemon.runtimes_supported` |
| `03-step1-name.png` | ① 名字 | typed `ga2-child-a` |
| `04-step2-runtime.png` | ② Runtime | claude-agent-sdk selected (checkmark) |
| `05-step3-model.png` | ③ 模型 | `claude-sonnet-4-6` picked. Hub's `create_node.node_spec.model` schema requires a non-empty string; the wizard's "默认" option leaves it empty and the hub 400s — worth surfacing in a later polish. |
| `06-step4-flags.png` | ④ 参数 | default permissionMode / maxTurns / budget / timeout |
| `07-step5-confirm.png` | ⑤ 确认 | review card with all six knobs enumerated |
| `08-creating.png` | dispatched | `POST /api/anet/node-create → 200` |
| `09-dispatched.png` | ~poll | hub route replied, daemon SSE doorbell landed, child spawn in flight |
| `10-online.png` | ✓ 上线 | wizard shows **✓ ga2-child-a 已上线 / 节点已注册，已出现在节点列表**; all six wizard tabs highlighted |

The `.log` companions live in `p-ga2-compat-repro/`; the wizard driver
script is at `/tmp/verify-ga2-wizard-shots.mjs` (host-side, not
container-side).

## Reproduce (host machine)

```bash
# 1. Container — hub + daemon, port 9234 forwarded, admin.env dropped
#    into /tmp/ga2-shared for the driver.
docker build -t anet-ga2-repro tests-repro/ga2/     # (or wherever this fixture lives)
mkdir -p /tmp/ga2-shared
docker run -d --rm --name ga2-stay -p 9234:9234 \
  -v /tmp/ga2-shared:/shared \
  --tmpfs /tmp:rw,exec --tmpfs /root:rw,exec \
  anet-ga2-repro /repro-stay.sh

# 2. Dashboard prod build (this repo) — must include #33 admin-picker
#    fix (merged 2026-07-04).
cd path/to/agent-network-dashboard
git checkout origin/main
rm -rf .next
COMMHUB_URL=http://127.0.0.1:9234 DASHBOARD_PASSWORD=verifyGA2 npm run build
COMMHUB_URL=http://127.0.0.1:9234 DASHBOARD_PASSWORD=verifyGA2 PORT=3260 npm start &

# 3. Drive the wizard.
node verify-ga2-wizard-shots.mjs
```

Expected verdict line: `[verdict] child registered visible in wizard: true`.

## Fixture gotcha — `ANET_BIN_ABS`

The daemon must know the absolute path of the `anet` CLI so it can
safely fork child agent-nodes (`anet_bin_unsafe_path` if neither
`/etc/anet-daemon/path.conf` nor `ANET_BIN_ABS` env is set). The
`repro-stay.sh` fixture now exports it before `anet daemon up`. Real
operator installs get this out of the box via the anet installer;
the docker image doesn't, so the fixture handles it explicitly.
