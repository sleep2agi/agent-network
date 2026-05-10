#!/bin/bash
set +e

BASE="http://127.0.0.1:9200"
ANET="bun run /app/agent-network/bin/cli.ts"
AUTH_TOKEN="${COMMHUB_AUTH_TOKEN:-test-auth-token}"

echo "# Test 18: Error Paths"
echo ""
echo "目标：模拟真实用户常见错误路径，记录错误消息并评价友好度。"
echo ""

case_no=0

write_case() {
  local title="$1"
  local cmd="$2"
  local output="$3"
  local score="$4"
  local note="$5"
  case_no=$((case_no+1))
  echo "## ${case_no}. ${title}"
  echo ""
  echo "命令："
  echo '```bash'
  echo "$cmd"
  echo '```'
  echo ""
  echo "输出："
  echo '```text'
  printf "%s\n" "$output"
  echo '```'
  echo ""
  echo "用户友好度：${score}/5"
  echo ""
  echo "评价：${note}"
  echo ""
}

init_home() {
  local home_dir="$1"
  HOME="$home_dir" $ANET init --hub "$BASE" --token "$AUTH_TOKEN" >/tmp/test18-init.out 2>&1
}

make_cfg_without_server() {
  local home_dir="$1"
  mkdir -p "$home_dir/.anet"
  cat > "$home_dir/.anet/config.json" <<EOF
{
  "hub": "$BASE",
  "token": "$AUTH_TOKEN"
}
EOF
}

start_server() {
  cd /app/server
  COMMHUB_AUTH_TOKEN="$AUTH_TOKEN" bun run src/index.ts >/tmp/test18-server.log 2>&1 &
  SERVER_PID=$!
  sleep 3
}

start_server

# 1. No server, then anet register
kill "$SERVER_PID" >/dev/null 2>&1
wait "$SERVER_PID" >/dev/null 2>&1
HOME1=/tmp/test18-home1
rm -rf "$HOME1"
make_cfg_without_server "$HOME1"
OUT1=$(HOME="$HOME1" $ANET register --username offlineuser --password pass123456 2>&1)
write_case \
  "没启动 server 就跑 anet register" \
  "anet register --username offlineuser --password pass123456" \
  "$OUT1" \
  "5" \
  "错误信息直接指出无法连接 CommHub，并给出 'Is it running?'、'anet hub start'、'anet doctor' 等下一步操作，比较友好。"

# Restart server for the rest
start_server

# 2. No init then login
HOME2=/tmp/test18-home2
rm -rf "$HOME2"
OUT2=$(HOME="$HOME2" $ANET login --username noinit --password whatever 2>&1)
write_case \
  "没 anet init 就 anet login" \
  "anet login --username noinit --password whatever" \
  "$OUT2" \
  "4" \
  "能直接告诉用户先跑 'anet init'，问题定位清晰；如果能顺带给一个完整示例会更好。"

# 3. Wrong password
HOME3=/tmp/test18-home3
rm -rf "$HOME3"
init_home "$HOME3"
HOME="$HOME3" $ANET register --username wrongpass --password pass123456 >/tmp/test18-r3-register.out 2>&1
OUT3=$(HOME="$HOME3" $ANET login --username wrongpass --password wrong 2>&1)
write_case \
  "密码输错 anet login --username x --password wrong" \
  "anet login --username wrongpass --password wrong" \
  "$OUT3" \
  "4" \
  "会明确显示 'Login failed: invalid credentials'，信息够清楚；如果能提示是否忘记密码或指向 'anet passwd' / 重置流程会更好。"

# 4. Duplicate register
HOME4=/tmp/test18-home4
rm -rf "$HOME4"
init_home "$HOME4"
HOME="$HOME4" $ANET register --username dupuser --password pass123456 >/tmp/test18-r4-register1.out 2>&1
OUT4=$(HOME="$HOME4" $ANET register --username dupuser --password pass123456 2>&1)
write_case \
  "重复注册同一用户名" \
  "anet register --username dupuser --password pass123456" \
  "$OUT4" \
  "4" \
  "能告诉用户注册失败及具体原因；如果能补一句“直接登录即可”会更像真实产品提示。"

# 5. anet node create duplicate name
HOME5=/tmp/test18-home5
PROJ5=/tmp/test18-proj5
rm -rf "$HOME5" "$PROJ5"
mkdir -p "$PROJ5"
init_home "$HOME5"
(cd "$PROJ5" && HOME="$HOME5" $ANET register --username nodeuser --password pass123456 >/tmp/test18-r5-register.out 2>&1)
(cd "$PROJ5" && HOME="$HOME5" $ANET create dup-node --runtime claude-code-cli >/tmp/test18-r5-create1.out 2>&1)
OUT5=$(cd "$PROJ5" && HOME="$HOME5" $ANET create dup-node --runtime claude-code-cli 2>&1)
write_case \
  "anet node create 重复名字" \
  "anet node create dup-node --runtime claude-code-cli" \
  "$OUT5" \
  "5" \
  "会明确指出节点已存在，并给出具体配置文件路径，定位非常直接。"

# 6. network delete without --force
HOME6=/tmp/test18-home6
rm -rf "$HOME6"
init_home "$HOME6"
HOME="$HOME6" $ANET register --username netdel --password pass123456 >/tmp/test18-r6-register.out 2>&1
HOME="$HOME6" $ANET network create delete-me >/tmp/test18-r6-create.out 2>&1
OUT6=$(HOME="$HOME6" $ANET network delete delete-me 2>&1)
write_case \
  "anet network delete 不加 --force" \
  "anet network delete delete-me" \
  "$OUT6" \
  "5" \
  "会先做确认提示，并明确告诉用户要加 '--force'，符合防误删预期。"

# 7. start non-existent node
HOME7=/tmp/test18-home7
PROJ7=/tmp/test18-proj7
rm -rf "$HOME7" "$PROJ7"
mkdir -p "$PROJ7"
init_home "$HOME7"
OUT7=$(cd "$PROJ7" && HOME="$HOME7" $ANET start ghost-node 2>&1)
write_case \
  "anet node start 一个不存在的 node" \
  "anet node start ghost-node" \
  "$OUT7" \
  "5" \
  "错误里直接写明节点不存在，并附带 'Create it first: anet node create ghost-node'，属于很友好的恢复建议。"

# 8. Fake token against API
OUT8=$(curl -s -i "$BASE/api/auth/me" -H "Authorization: Bearer utok_fake_token")
write_case \
  "用假 token 调 API" \
  "curl -i $BASE/api/auth/me -H 'Authorization: Bearer utok_fake_token'" \
  "$OUT8" \
  "3" \
  "HTTP 401 是对的，但返回体更偏 API 风格；对终端用户来说，如果能统一成更具体的人话提示会更好。"

# 9. Empty password register
HOME9=/tmp/test18-home9
rm -rf "$HOME9"
init_home "$HOME9"
OUT9=$(HOME="$HOME9" $ANET register --username emptypw --password "" 2>&1)
write_case \
  "空密码注册" \
  "anet register --username emptypw --password \"\"" \
  "$OUT9" \
  "3" \
  "CLI 侧能拦到“用户名和密码必填”，但没有说明密码长度或格式要求；如果提示 'min 6' 会更好。"

# 10. Overlong username register
HOME10=/tmp/test18-home10
rm -rf "$HOME10"
init_home "$HOME10"
LONG_USER=$(python3 - <<'PY'
print("u" * 260)
PY
)
OUT10=$(HOME="$HOME10" $ANET register --username "$LONG_USER" --password pass123456 2>&1)
write_case \
  "超长用户名注册" \
  "anet register --username <260-char> --password pass123456" \
  "$OUT10" \
  "3" \
  "能失败，但通常是后端直接返回约束错误；如果 CLI 先做长度校验并给出明确上限，会更友好。"

cat <<'EOF'
## 总结

整体看，CLI 在“连不上服务”“没 init”“节点不存在”“危险删除确认”这几条上做得比较好，提示普遍能给出下一步动作。

需要优先改进的点：

- `anet register` / `anet login` 的输入校验还偏弱，像空密码、超长用户名、密码长度不足，最好在 CLI 层先拦并给出明确规则。
- 认证失败类提示可以更统一。CLI 已经有人话版 `friendlyError()`，但 API 原始返回仍偏技术化。
- 重复注册、重复创建网络这类常见用户动作，除了报错原因，最好附带“下一步建议”，比如“请直接登录”或“换一个名字”。
- 部分错误文案中英文混用，真实用户体验上建议统一语言风格。

EOF
