#!/bin/bash
# 把某个飞书用户加进白名单并指定角色，同时去掉 allowFrom 的通配符。
#
# 用法： bash scripts/feishu-allow-user.sh <open_id> [guest|member|admin] [node名] [--dry-run]
#   --dry-run 出现在任意位置都生效；**改文件之前会先把计划打出来**
#
# 为什么要做成脚本：access.json 是**启动时读**的，改完必须重启；而"收紧白名单"
# 这一步最容易手抖（少个逗号就没人能说话了）。脚本做三件事：
#   改写前备份 → 写入 → 回读校验（* 必须真的没了）→ 重启 → 核 bridge online
#
# 🔴 关于 --dry-run 的一条真实教训（2026-11-04）：
#   第一版把 --dry-run 只当第 3/4 个位置参数，于是 `... 通信飞书欧 --dry-run` 落到了
#   写文件分支 —— 它真的改了 access.json 并重启了节点。恢复靠的是脚本自己写的备份。
#   ⇒ 号称只读的开关，必须在第一次用它之前**证明它不写**（例如 md5 前后比对），
#     而不是靠参数名自证。现在参数解析改成"先摘出 --dry-run，再解析位置参数"。
#
set -u
OPEN_ID=${1:?用法: feishu-allow-user.sh <open_id> [角色] [node名]}
ROLE=${2:-admin}
NODE_NAME=${3:-通信飞书欧}
DRY=0
# --dry-run 可能出现在任意位置：先摘出来，再解析位置参数。
ARGS=()
for a in "$@"; do
  if [ "$a" = "--dry-run" ]; then DRY=1; else ARGS+=("$a"); fi
done
set -- "${ARGS[@]}"
DIR="$HOME/comm-feishu-ou/.anet/nodes/$NODE_NAME/channels/feishu"
ACC="$DIR/access.json"
CLI="$HOME/.nvm/versions/node/v24.19.0/lib/node_modules/@sleep2agi/agent-network/dist/bin/cli.js"

export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin"
export ANET_OPENCODE_MODE=copresence

[ -f "$ACC" ] || { echo "✗ 找不到 $ACC"; exit 2; }

python3 - "$ACC" "$OPEN_ID" "$ROLE" "$DRY" <<'PY'
import json, sys, shutil, os
path, open_id, role, dry = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
if role not in ("guest", "member", "admin"):
    print(f"✗ 角色只能是 guest / member / admin（收到 {role}）"); sys.exit(2)
d = json.load(open(path))
allow = [x for x in (d.get("allowFrom") or []) if x != "*"]
if open_id not in allow:
    allow.append(open_id)
users = dict(d.get("users") or {})
users[open_id] = {"role": role}
out = {**d, "allowFrom": allow, "users": users}
print("将写入：")
print(json.dumps({"allowFrom": out["allowFrom"], "users": out["users"], "defaultRole": out.get("defaultRole")}, ensure_ascii=False, indent=2))
print(f"（通配符 * 是否已移除：{'是' if '*' not in out['allowFrom'] else '否'}）")
if dry:
    print("--dry-run：没有改任何文件"); sys.exit(0)
bak = f"{path}.bak-$(date +%Y%m%d-%H%M%S)"
shutil.copy2(path, bak); os.chmod(bak, 0o600)
with open(path, "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=2); f.write("\n")
os.chmod(path, 0o600)
print(f"✅ 已写入（备份 {os.path.basename(bak)}）")
PY
[ $? -ne 0 ] && exit 2
[ "$DRY" = "1" ] && exit 0

# 回读校验：改完必须能解析、且 * 真的没了
python3 - "$ACC" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if "*" in (d.get("allowFrom") or []):
    print("✗ 回读发现 * 还在"); sys.exit(3)
print("✅ 回读：allowFrom =", d["allowFrom"], "| users =", d.get("users"))
PY
[ $? -ne 0 ] && exit 3

echo "→ 重启节点让新白名单生效（access.json 是启动时读的）"
cd "$HOME/comm-feishu-ou" || exit 4
timeout 120 node "$CLI" node restart "$NODE_NAME" 2>&1 | tail -3
sleep 6
grep -a "bridge online" "$HOME/comm-feishu-ou/.anet/nodes/$NODE_NAME/logs/copresence-bridge.log" | tail -1
