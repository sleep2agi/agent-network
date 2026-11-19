#!/usr/bin/env bash
# release-watch.sh —— 单一常驻发版看门狗（#573 演练后改造，负责人 2026-11-20 批准 ①–⑥）
#
# 为什么要有它：0.570 与 0.573 两次「没派发 / 没起 watch」都是因为**每版手动复制脚本**，
# 漏一次就完全无声（日志文件都不存在）。这里改成常驻 + 自动发现 bump PR。
#
# 用法：
#   release-watch.sh                 # 常驻（默认；合并后由 systemd/pm2 或 nohup 拉起）
#   release-watch.sh --once          # 跑一拍就退出（自测/CI 用）
#   release-watch.sh --dry-run       # 只打印将要做的动作，不调用任何写接口
#
# 环境变量：
#   APP_REPO     默认 sleep2agi/agent-network-app
#   HUB_REPO     默认 sleep2agi/agent-network
#   GH_TOKEN     必填（从 ~/.config/gh 读；不落盘、不回显）
#   WATCH_POLL   轮询秒数，默认 120
#   QUEUE_LIMIT_MIN  构建 job 排队超时分钟，默认 20
#   MAX_RERUN    自动 rerun-failed-jobs 上限，默认 6
#   ALERT_SCRIPT 告警脚本，默认 ~/.commhub/drill/hub-alert.sh
set -uo pipefail

APP_REPO="${APP_REPO:-sleep2agi/agent-network-app}"
HUB_REPO="${HUB_REPO:-sleep2agi/agent-network}"
WATCH_POLL="${WATCH_POLL:-120}"
QUEUE_LIMIT_MIN="${QUEUE_LIMIT_MIN:-20}"
MAX_RERUN="${MAX_RERUN:-6}"
ALERT="${ALERT_SCRIPT:-$HOME/.commhub/drill/hub-alert.sh}"
STATE_DIR="${STATE_DIR:-$HOME/.commhub/state}"
LOG="${LOG:-$HOME/.commhub/logs/release-watch.log}"
mkdir -p "$STATE_DIR" "$(dirname "$LOG")"

MODE="${1:-}"
[ -z "${GH_TOKEN:-}" ] && { GH_TOKEN=$(python3 -c "import yaml;print(yaml.safe_load(open('$HOME/.config/gh/hosts.yml'))['github.com']['oauth_token'])" 2>/dev/null); }
[ -z "${GH_TOKEN:-}" ] && { echo "FATAL: no GH_TOKEN and cannot read ~/.config/gh" | tee -a "$LOG" >&2; exit 2; }
export GH_TOKEN APP_REPO HUB_REPO QUEUE_LIMIT_MIN MAX_RERUN

log() { printf '%s %s\n' "$(date -u '+%FT%TZ')" "$*" >> "$LOG"; }
say() { printf '%s %s\n' "$(date -u '+%FT%TZ')" "$*" | tee -a "$LOG"; }
alert() { "$ALERT" "release-watch.sh" "${1:--}" "${2:-}" >> "$LOG" 2>&1 || true; }

# ---- 一次完整检查 ------------------------------------------------------------
tick() {
  local payload
  payload=$(python3 - <<'PY' 2>>"$LOG"
import json, os, re, sys, urllib.request, urllib.error

TOK=os.environ['GH_TOKEN']; APP=os.environ['APP_REPO']
H={'Authorization':'Bearer '+TOK,'Accept':'application/vnd.github+json','Content-Type':'application/json'}
def get(url):
    req=urllib.request.Request(url, headers=H)
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
def parse(s):
    m=re.match(r'^(\d+)\.(\d+)\.(\d+)$', s.strip())
    return tuple(int(x) for x in m.groups()) if m else None

out={'actions':[], 'notes':[]}

# ① 自动发现最近的 bump PR（标题 release: x.y.z）
q='repo:%s is:pr in:title "release:"' % APP
import urllib.parse
items=get('https://api.github.com/search/issues?q='+urllib.parse.quote(q)+'&per_page=20').get('items') or []
cands=[]
for it in items:
    m=re.search(r'release:\s*(\d+\.\d+\.\d+)', it.get('title') or '')
    if m: cands.append((m.group(1), it['number']))
if not cands:
    out['notes'].append('no bump PR found')
    print(json.dumps(out)); raise SystemExit(0)

cands.sort(key=lambda c: (parse(c[0]) or (0,0,0)))
ver, num = cands[-1]
pr=get(f'https://api.github.com/repos/{APP}/pulls/{num}')
out['version']=ver; out['pr']=num; out['merged']=bool(pr.get('merged'))

# ② 已合入 ⇒ 三步检查后派发（未派发过才派）
disp_file=os.path.join(os.environ.get('STATE_DIR',''), 'dispatched-%s' % ver)
os.environ.setdefault('STATE_DIR', os.path.expanduser('~/.commhub/state'))
disp_file=os.path.join(os.environ['STATE_DIR'], 'dispatched-%s' % ver)
published = any(r['tag_name']=='desktop-v'+ver and not r.get('draft') for r in get(f'https://api.github.com/repos/{APP}/releases?per_page=30'))
if published:
    out['notes'].append('already published: %s' % ver)
if pr.get('merged') and not published and not os.path.exists(disp_file):
    sha=pr.get('merge_commit_sha') or ''
    if len(sha)==40:
        cmp=get(f'https://api.github.com/repos/{APP}/compare/main...{sha}')
        drafts=[r['tag_name'] for r in get(f'https://api.github.com/repos/{APP}/releases?per_page=30') if r.get('draft') and r['tag_name']=='desktop-v'+ver]
        runs=get(f'https://api.github.com/repos/{APP}/actions/runs?per_page=100')['workflow_runs']
        exist=[w['id'] for w in runs if w.get('head_sha')==sha and ('release-desktop-auto-update' in (w.get('name') or '') or 'ios-build' in (w.get('name') or '').lower())]
        if cmp.get('status') in ('identical','behind') and not drafts and not exist:
            out['actions'].append({'do':'dispatch','version':ver,'sha':sha})
        else:
            out['actions'].append({'do':'blocked','version':ver,'why':{'compare':cmp.get('status'),'drafts':drafts,'existing':exist}})

# ③ draft 已就绪 ⇒ 四前置（+ ⑤）判定
for r in get(f'https://api.github.com/repos/{APP}/releases?per_page=30'):
    if r.get('draft') and r['tag_name']=='desktop-v'+ver:
        n=len(r.get('assets') or [])
        latest=get(f'https://api.github.com/repos/{APP}/releases/latest')['tag_name'].replace('desktop-v','')
        newer = (parse(ver) or (0,0,0)) > (parse(latest) or (0,0,0))
        tag_ok = bool(pr.get('merge_commit_sha')) and (r.get('target_commitish') or '') == pr.get('merge_commit_sha')
        ready = n>=9 and newer and tag_ok
        out['release']={'assets':n,'newer':newer,'tag_ok':tag_ok,'ready':ready,'id':r['id']}
        if ready:
            out['actions'].append({'do':'publish','version':ver,'sha':pr.get('merge_commit_sha') or ''})

# ③ 待批准的部署（macos-signing 等）：只批「本次版本的 release run 且 head_sha == merge sha」
for w in runs:
    if not ('release-desktop-auto-update' in (w.get('name') or '')): continue
    if w.get('head_sha') != pr.get('merge_commit_sha'): continue
    try:
        pend=get(f"https://api.github.com/repos/{APP}/actions/runs/{w['id']}/pending_deployments")
    except Exception:
        pend=[]
    for d in (pend or []):
        if d.get('current_user_can_approve') is False:
            continue
        out['actions'].append({'do':'approve','run':w['id'],'env_id':d.get('environment',{}).get('id') or d.get('environment_id')})

# ⑥ 构建 job 排队超时 / 因容量被取消
runs=get(f'https://api.github.com/repos/{APP}/actions/runs?per_page=20')['workflow_runs']
for w in runs:
    if not ('release-desktop-auto-update' in (w.get('name') or '')): continue
    if w.get('head_sha')!=pr.get('merge_commit_sha'): continue
    jobs=get(f"https://api.github.com/repos/{APP}/actions/runs/{w['id']}/jobs?per_page=100")['jobs']
    for j in jobs:
        st=j.get('status'); concl=j.get('conclusion') or ''
        if st=='queued' and j.get('created_at'):
            from datetime import datetime, timezone
            t=datetime.fromisoformat(j['created_at'].replace('Z','+00:00'))
            mins=(datetime.now(timezone.utc)-t).total_seconds()/60
            if mins > float(os.environ.get('QUEUE_LIMIT_MIN','20')):
                out['actions'].append({'do':'stuck','run':w['id'],'job':j.get('name'),'minutes':int(mins)})
        if concl=='cancelled':
            # 「not acquired by Runner」只在 check-run 的 annotations 里，jobs JSON 不含这段文字。
            jid=j.get('id')
            try:
                anns=get(f'https://api.github.com/repos/{APP}/check-runs/{jid}/annotations?per_page=50')
                text=json.dumps(anns)
            except Exception:
                text=''
            if 'not acquired by Runner' in text or 'capacity' in text.lower():
                out['actions'].append({'do':'capacity','run':w['id'],'job':j.get('name'),'head_sha':w.get('head_sha')})
print(json.dumps(out))
PY
)
  [ -z "$payload" ] && { alert "-" "tick 输出为空（python 失败或 API 异常）"; return 0; }
  log "$payload"

  python3 - "$payload" <<'PY' > /tmp/rw-actions.$$
import json,sys
d=json.loads(sys.argv[1])
for a in d.get('actions',[]): print(json.dumps(a))
PY
  while IFS= read -r act; do
    [ -z "$act" ] && continue
    do=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('do'))" "$act")
    ver=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('version',''))" "$act")
    sha=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('sha',''))" "$act")
    case "$do" in
      dispatch)
        [ "$MODE" = "--dry-run" ] && { say "DRY dispatch $ver $sha"; continue; }
        for wf in release-desktop-auto-update.yml ios-build.yml; do
          body=$(python3 -c "import json,sys;wf=sys.argv[1];sha=sys.argv[2];inputs={'commit':sha} if wf.startswith('release-desktop') else {};print(json.dumps({'ref':'main','inputs':inputs}))" "$wf" "$sha")
          code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
            -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' \
            -H 'Content-Type: application/json' -d "$body" \
            "https://api.github.com/repos/$APP_REPO/actions/workflows/$wf/dispatches")
          say "dispatch $wf for $ver -> $code"
        done
        touch "$STATE_DIR/dispatched-$ver"
        ;;
      publish)
        [ "$MODE" = "--dry-run" ] && { say "DRY publish $ver"; continue; }
        say "publishing $ver"
        python3 "$HOME/.commhub/finish-release.py" "$ver" "$sha" >> "$LOG" 2>&1 || alert "$ver" "finish-release 失败"
        python3 "$HOME/.commhub/finish-release.py" "$ver" "$sha" --open-fallback-pr >> "$LOG" 2>&1 || true
        ;;
      stuck)
        minutes=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('minutes'))" "$act")
        key=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print('stuck-%s-%s' % (d.get('run'), (d.get('job') or '').replace(' ','_')))" "$act")
        [ -f "$STATE_DIR/$key" ] && continue
        job=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('job'))" "$act")
        run=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('run'))" "$act")
        alert "$ver" "构建 job「$job」已排队 ${minutes} 分钟（run $run），按 ⑥ 处理"
        touch "$STATE_DIR/$key"
        ;;
      capacity)
        job=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('job'))" "$act")
        run=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('run'))" "$act")
        att=$(curl -s -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/$APP_REPO/actions/runs/$run" | python3 -c "import json,sys;print(json.load(sys.stdin).get('run_attempt',''))" 2>/dev/null)
        ckey="$STATE_DIR/capacity-$run-$att"
        [ -f "$ckey" ] && continue
        touch "$ckey"
        n=0; f="$STATE_DIR/rerun-$run"; [ -f "$f" ] && n=$(cat "$f")
        # ⑤ 只在 run 已 completed 时 rerun（in_progress 会被 403，白烧计数）
        state=$(curl -s -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/$APP_REPO/actions/runs/$run" \
          | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
        alert "$ver" "构建 job「$job」因 runner 容量被取消（run $run，status=$state），尝试自动 rerun（已用 $n/$MAX_RERUN）"
        if [ "$n" -lt "$MAX_RERUN" ] && [ "$MODE" != "--dry-run" ] && [ "$state" = "completed" ]; then
          code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $GH_TOKEN" \
            -H 'Accept: application/vnd.github+json' -d '{}' \
            "https://api.github.com/repos/$APP_REPO/actions/runs/$run/rerun-failed-jobs")
          say "rerun-failed-jobs run $run -> $code"
          # ⑤ 只在 201（真的建了重跑）时递增
          [ "$code" = "201" ] && echo $((n+1)) > "$f"
        fi
        ;;
      approve)
        run=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('run'))" "$act")
        env=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('env_id'))" "$act")
        [ "$MODE" = "--dry-run" ] && { say "DRY approve run $run env $env"; continue; }
        # 正确端点：POST /actions/runs/{run_id}/pending_deployments（没有 /{env}/approve 这个路径）
        body=$(python3 -c "import json,sys;print(json.dumps({'environment_ids':[int(sys.argv[1])],'state':'approved','comment':'release-watch '+sys.argv[2]}))" "$env" "$ver")
        code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $GH_TOKEN" \
          -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' \
          -d "$body" "https://api.github.com/repos/$APP_REPO/actions/runs/$run/pending_deployments")
        say "approve run $run env $env -> $code (body=$body)"
        ;;
      blocked)
        say "blocked: $act"
        ;;
    esac
  done < /tmp/rw-actions.$$
  rm -f /tmp/rw-actions.$$
}

case "$MODE" in
  --once|--dry-run) tick ;;
  "") while :; do tick; sleep "$WATCH_POLL"; done ;;
  *) echo "usage: $0 [--once|--dry-run]" >&2; exit 2 ;;
esac
