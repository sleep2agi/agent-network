#!/bin/bash
# 飞书渠道体检 —— 一条命令回答「为什么机器人不说话」。
#
# 用法： bash scripts/feishu-doctor.sh [节点目录] [节点别名]
#   默认： $HOME/comm-feishu-ou/.anet/nodes/通信飞书欧  通信飞书欧
#
# 设计原则：**每一行都能独立判死**。排障最怕的是"看起来都正常"，
# 所以这里把六种不同的失败分开报，而不是给一个总分。
set -u
NODE_DIR=${1:-$HOME/comm-feishu-ou/.anet/nodes/通信飞书欧}
ALIAS=${2:-通信飞书欧}
CH="$NODE_DIR/channels/feishu"
ok()   { printf "  ✅ %s\n" "$1"; }
bad()  { printf "  ❌ %s\n" "$1"; }
warn() { printf "  ⚠️  %s\n" "$1"; }

echo "== 飞书渠道体检：$ALIAS =="
echo "$NODE_DIR"

# 1) 配置文件在不在、权限对不对
echo "-- 1. 配置"
for f in .env access.json; do
  if [ -f "$CH/$f" ]; then
    mode=$(stat -c %a "$CH/$f")
    if [ "$mode" = "600" ] || [ "$mode" = "400" ]; then ok "$f (mode=$mode)"
    else bad "$f 权限过宽 (mode=$mode，应为 600)"; fi
  else bad "缺 $CH/$f"; fi
done

# 2) channels 里有没有真的挂上
echo "-- 2. 节点配置"
CFG="$NODE_DIR/config.json"
if [ -f "$CFG" ]; then
  if python3 -c "
import json,sys
d=json.load(open('$CFG'))
sys.exit(0 if any(str(c).startswith('feishu') for c in (d.get('channels') or [])) else 1)"; then
    ok "channels 含 feishu"
  else bad "channels 不含 feishu —— 桥不会被 fork"; fi
else bad "缺 $CFG"; fi

# 3) 凭据能不能换到 token（这一步失败，后面都不用看）
echo "-- 3. 凭据"
python3 - "$CH/.env" <<'PY'
import json,sys,urllib.request,os
p=sys.argv[1]
if not os.path.exists(p):
    print("  ❌ 没有 .env"); sys.exit(1)
env={}
for line in open(p):
    line=line.strip()
    if not line or line.startswith('#'): continue
    k,_,v=line.partition('='); env[k.strip()]=v.strip().strip('"').strip("'")
app_id=env.get('FEISHU_APP_ID',''); sec=env.get('FEISHU_APP_SECRET','')
if not app_id or not sec:
    print("  ❌ .env 里 app_id / secret 不全"); sys.exit(1)
try:
    b=json.dumps({"app_id":app_id,"app_secret":sec}).encode()
    r=urllib.request.Request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                             data=b, headers={"Content-Type":"application/json"})
    d=json.loads(urllib.request.urlopen(r, timeout=12).read())
except Exception as e:
    print("  ❌ 换 token 失败:", type(e).__name__, str(e)[:80]); sys.exit(1)
if d.get("code")!=0 or not d.get("tenant_access_token"):
    print("  ❌ 飞书拒绝凭据:", d.get("code"), d.get("msg")); sys.exit(1)
t=d["tenant_access_token"]
print(f"  ✅ token 可用 (app_id={app_id})")
# 机器人与群数
try:
    bi=json.loads(urllib.request.urlopen(urllib.request.Request(
        "https://open.feishu.cn/open-apis/bot/v3/info", headers={"Authorization":f"Bearer {t}"}), timeout=10).read())
    bot=bi.get("bot") or {}
    print(f"     机器人: {bot.get('app_name')}")
except Exception as e:
    print("  ⚠️  取机器人信息失败:", type(e).__name__)
try:
    ci=json.loads(urllib.request.urlopen(urllib.request.Request(
        "https://open.feishu.cn/open-apis/im/v1/chats?page_size=20", headers={"Authorization":f"Bearer {t}"}), timeout=10).read())
    n=len(((ci.get("data") or {}).get("items")) or [])
    print(f"     所在群数: {n}" + ("  ← 0 表示只能单聊" if n==0 else ""))
except Exception as e:
    print("  ⚠️  取群列表失败:", type(e).__name__)
PY

# 4) 桥进程与长连接
echo "-- 4. 桥"
PID=$(pgrep -f "feishu/worker.js" | head -1)
if [ -n "$PID" ]; then
  ok "worker 在跑 (pid=$PID)"
  if ss -tnp 2>/dev/null | grep -q "pid=$PID"; then
    ok "有 ESTABLISHED 连接（长连接已建立）"
  else
    bad "worker 在跑但没有对外连接 —— 长连接没连上（看飞书事件订阅是否=长连接、是否先起客户端）"
  fi
else
  bad "没有 worker 进程 —— 桥没起来（看节点日志 [feishu] forked worker）"
fi

# 5) 白名单（最常见的"发了但没反应"）
echo "-- 5. 白名单"
if [ -f "$CH/access.json" ]; then
  python3 - "$CH/access.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
af=d.get('allowFrom') or []; ac=d.get('allowChats') or []
print(f"     allowFrom={af}  allowChats={ac}")
if '*' in af:
    print("  ⚠️  allowFrom 是通配符 ⇒ 任何找到这个机器人的人都能驱动节点")
if not af and not ac:
    print("  ❌ 两个白名单都空 ⇒ 谁发都会被拒")
PY
fi

# 6) 最近事件
echo "-- 6. 最近事件（有新事件说明链路通）"
LOG="$NODE_DIR/logs/$(date +%Y-%m-%d).log"
if [ -f "$LOG" ]; then
  last=$(grep -a "\[feishu\] event" "$LOG" | tail -1)
  if [ -n "$last" ]; then ok "$last"; else warn "今天还没有入站事件（没人在发，或被白名单挡了）"; fi
  gl=$(grep -a "refused sender" "$LOG" | tail -1)
  [ -n "$gl" ] && warn "有角色闸门拦截记录: $gl"
else warn "没有今天的日志文件：$LOG"; fi

echo
echo "判读顺序：1 配置 → 2 channels → 3 凭据 → 4 桥 → 5 白名单 → 6 事件。"
echo "前三步错 = 起不来；第 4 步错 = 连不上；第 5/6 步错 = 连上了但消息进不来。"
