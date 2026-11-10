#!/bin/bash
# 给任意节点接飞书（OpenCode V2 也能用）—— 一条命令，替代手工三处改动。
#
# 用法：
#   bash feishu-provision-node.sh <节点目录> <凭据文件> <open_id> [chat_id] [--dry-run]
# 例：
#   bash feishu-provision-node.sh ~/comm-feishu-ou/.anet/nodes/某节点 \
#        /tmp/app.env ou_abc123 oc_xyz --dry-run
#
# 做四件事（每步都可单独判死）：
#   1. 凭据换成一次 tenant_access_token（换不到就退出，**一个字节都不写**）
#   2. 写 channels/feishu/{.env,access.json}（0600）；已有则先备份
#   3. 把 config.json 的 channels 补上 "feishu"（已有的不重复加）
#   4. 提示重启（本脚本**不重启**：重启会杀掉调用者正在跑的这一轮）
#
# 为什么单独存在：`anet channel add feishu` 只允许 runtime=claude-agent-sdk
# （因为它的工具拒绝层实现为 claude 的 PreToolUse hook）。OpenCode V2 节点
# 目前只能手工配 —— 这个脚本就是那条手工路径的固化。
set -u
NODE_DIR=${1:?用法: feishu-provision-node.sh <节点目录> <凭据文件> <open_id> [chat_id] [--dry-run]}
CRED=${2:?缺凭据文件（两行：FEISHU_APP_ID/SF_APP_ID 与 FEISHU_APP_SECRET/SF_APP_KEY）}
OPEN_ID=${3:?缺 open_id（白名单里的人）}
CHAT_ID=${4:-}
DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done
[ "$CHAT_ID" = "--dry-run" ] && CHAT_ID=""

CH="$NODE_DIR/channels/feishu"
CFG="$NODE_DIR/config.json"
# 2026-11-06 —— 临时文件从写死的 /tmp/.feishu-provision-appid 改成 mktemp：
# 固定名在「两个进程同时给两台节点接线」时会互相覆盖，而崩溃残留会让下一次
# 读到一个旧的 app_id（看起来成功，实际是别人的）。tmp-hygiene 门就是拦这个的。
APPID_FILE=$(mktemp "${TMPDIR:-/tmp}/feishu-provision-appid.XXXXXX") || { echo "无法创建临时文件"; exit 3; }
trap 'rm -f "$APPID_FILE"' EXIT INT TERM
ok(){ printf "  ✅ %s\n" "$1"; }
bad(){ printf "  ❌ %s\n" "$1"; }
warn(){ printf "  ⚠️  %s\n" "$1"; }

echo "== 接飞书：$NODE_DIR${DRY:+ (dry-run)} =="

# 0) 前置
[ -d "$NODE_DIR" ] || { bad "节点目录不存在"; exit 2; }
[ -f "$CFG" ] || { bad "缺 config.json"; exit 2; }
[ -f "$CRED" ] || { bad "缺凭据文件"; exit 2; }
printf '%s' "$OPEN_ID" | grep -q '^ou_' || { bad "open_id 应以 ou_ 开头（收到 $OPEN_ID）"; exit 2; }
if [ -n "$CHAT_ID" ]; then printf '%s' "$CHAT_ID" | grep -q '^oc_' || { bad "chat_id 应以 oc_ 开头"; exit 2; }; fi

# 1) 凭据验真（别名兼容 FEISHU_/SF_）
python3 - "$CRED" "$APPID_FILE" <<'PY'
import json,sys,urllib.request
env={}
for line in open(sys.argv[1]):
    line=line.strip()
    if not line or line.startswith('#'): continue
    k,_,v=line.partition('='); env[k.strip()]=v.strip().strip('"').strip("'")
aid = env.get("FEISHU_APP_ID") or env.get("SF_APP_ID")
sec = env.get("FEISHU_APP_SECRET") or env.get("SF_APP_KEY")
if not aid or not sec:
    print("  ❌ 凭据文件里没有 app_id / secret（接受 FEISHU_APP_ID|SF_APP_ID 与 FEISHU_APP_SECRET|SF_APP_KEY）"); sys.exit(2)
b=json.dumps({"app_id":aid,"app_secret":sec}).encode()
r=urllib.request.Request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", data=b, headers={"Content-Type":"application/json"})
try:
    d=json.loads(urllib.request.urlopen(r, timeout=12).read())
except Exception as e:
    print("  ❌ 换 token 失败:", type(e).__name__); sys.exit(2)
if d.get("code")!=0 or not d.get("tenant_access_token"):
    print("  ❌ 飞书拒绝凭据:", d.get("code"), d.get("msg")); sys.exit(2)
print(f"  ✅ 凭据可用（app_id={aid}）")
open(sys.argv[2],"w").write(aid)
PY
[ $? -ne 0 ] && { echo "⇒ 没有写任何文件"; exit 3; }
APP_ID=$(cat "$APPID_FILE" 2>/dev/null)

# 2) 计划（dry-run 在这里打印完就退出）
echo "-- 计划"
python3 - "$CFG" "$OPEN_ID" "$CHAT_ID" <<'PY'
import json,sys
cfg,open_id,chat=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(cfg)); ch=list(d.get("channels") or [])
if not any(str(x).startswith("feishu") for x in ch): ch.append("feishu")
print("  channels →", ch)
allow={"allowFrom":[open_id],"users":{open_id:{"role":"admin"}},"outboundRender":"card"}
if chat: allow["allowChats"]=[chat]
print("  access.json →", json.dumps(allow, ensure_ascii=False))
PY
if [ "$DRY" = "1" ]; then echo "  (dry-run：不改任何文件、不重启)"; exit 0; fi

# 3) 落地
mkdir -p "$CH"; chmod 700 "$CH"
[ -f "$CH/.env" ] && cp "$CH/.env" "$CH/.env.bak-$(date +%Y%m%d-%H%M%S)"
grep -qE '^(FEISHU_APP_ID|SF_APP_ID)=' "$CRED" && cp "$CRED" "$CH/.env" || {
  python3 - "$CRED" "$CH/.env" <<'PY'
import sys
env={}
for line in open(sys.argv[1]):
    line=line.strip()
    if not line or line.startswith('#'): continue
    k,_,v=line.partition('='); env[k.strip()]=v.strip().strip('"').strip("'")
aid = env.get("FEISHU_APP_ID") or env.get("SF_APP_ID")
sec = env.get("FEISHU_APP_SECRET") or env.get("SF_APP_KEY")
open(sys.argv[2],"w").write(f"FEISHU_APP_ID={aid}\nFEISHU_APP_SECRET={sec}\n")
PY
}
chmod 600 "$CH/.env"
python3 - "$CH/access.json" "$OPEN_ID" "$CHAT_ID" <<'PY'
import json,os,sys
path,open_id,chat=sys.argv[1],sys.argv[2],sys.argv[3]
d={}
if os.path.exists(path):
    try: d=json.load(open(path))
    except Exception: d={}
d["allowFrom"]=[open_id]
d.setdefault("users",{})[open_id]={"role":"admin"}
d["outboundRender"]=d.get("outboundRender") or "card"
if chat: d["allowChats"]=[chat]
open(path,"w").write(json.dumps(d, ensure_ascii=False, indent=2)+"\n"); os.chmod(path,0o600)
PY
python3 - "$CFG" <<'PY'
import json,sys
cfg=sys.argv[1]; d=json.load(open(cfg)); ch=list(d.get("channels") or [])
if not any(str(x).startswith("feishu") for x in ch): ch.append("feishu")
d["channels"]=ch
open(cfg,"w").write(json.dumps(d, ensure_ascii=False, indent=2)+"\n")
PY
ok "已写 $CH/{.env,access.json}（0600）"
ok "config.json channels 含 feishu"
echo
echo "-- 还差一步（重启）："
echo "   anet node restart <节点名>"
echo "   重启后到飞书开放平台：事件订阅选「使用长连接」+ 勾 im.message.receive_v1"
echo "   （顺序：先起客户端再保存，反了飞书会检测不到连接）"
echo
echo "-- 验：bash scripts/feishu-doctor.sh \"$NODE_DIR\""
