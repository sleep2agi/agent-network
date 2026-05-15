# anet 节点接入 Telegram — 完整指南

把 anet 节点（agent）接入 Telegram bot，让你在手机上跟 agent 对话 / 派任务 / 看回复。

> 这份文档解决三个常见疑问：① 命令长什么样 ② token 哪儿来 ③ **`--allow <UID>` 怎么拿**（最容易卡的一步）

---

## 0. 一句话流程

```bash
anet channel add telegram <node-alias> --bot-token <BOT_TOKEN> --allow <USER_UID>
# 然后重启节点（channels 在进程启动时读，不会热加载）
tmux kill-session -t <node-alias>
cd <node workdir>
tmux new-session -d -s <node-alias> "anet node start <node-alias>"
```

---

## 1. Quick Start — 给某个节点加你自己的 telegram（单用户）

### 1.1 拿 BOT_TOKEN（一次性，每个 bot 一个）

每个 anet 节点需要**自己独立的 Telegram bot**（不能多节点共用一个 bot）。

1. 在 Telegram 里搜 [@BotFather](https://t.me/BotFather)，开聊天
2. 发 `/newbot`
3. 输入 bot 显示名（如 `B站负责人 (BlueLeap Lead)`）
4. 输入 bot username（必须以 `bot` 或 `_bot` 结尾，如 `blueleap_lead_bot`）
5. BotFather 返回类似：
   ```
   Use this token to access the HTTP API:
   7612221352:AAH-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
   —— 这串就是 **BOT_TOKEN**

### 1.2 拿你的 USER_UID

详见下面 [§3 三种方法获取 UID](#3-获取-telegram-uid-的-3-种方法)。

### 1.3 装 channel 并重启节点

```bash
# 进节点 workdir（比如 /home/vansin/blueleap）
cd <node workdir>

# 装 telegram channel
anet channel add telegram <node-alias> \
  --bot-token <BOT_TOKEN> \
  --allow <YOUR_UID>

# 重启节点让 channels 生效（hot reload 不支持）
tmux kill-session -t <node-alias>
tmux new-session -d -s <node-alias> "anet node start <node-alias>"
```

### 1.4 验证

在 telegram 里给你刚创的 bot 发一句话，应该几秒内收到 agent 的回复。
没回复 → 见 [§6 故障排查](#6-故障排查)。

---

## 2. CLI 命令参考

### `anet channel add telegram <node-id>`

| Option | 说明 | 必填 |
|--------|------|------|
| `--bot-token <token>` | BotFather 给的 token | ✅ |
| `--allow <user-id>` | 允许哪个 telegram user 跟 bot 对话（白名单） | ✅ |

### `anet channel ls [node-id]`

列出节点已配的 channels。

### 当前未实现的（feature gap）

- `anet channel rm telegram <node-id>` — 删除 telegram channel（当前只能手编 config.json）
- `anet channel add telegram <node-id> --allow <new-uid>` 增量加用户 — 当前再跑会覆盖，要保留全列表得一次性传所有 `--allow`（或手编 `access.json`）

---

## 3. 获取 Telegram UID 的 3 种方法

**这是装 telegram 最容易卡的一步**。3 种方法按推荐度排：

### 🟢 方法 A — Telegram 自带的 UID bot（最快，针对自己）

任何人 DM 这些 bot 都能秒拿自己的 UID：

| Bot username | 操作 |
|--------------|------|
| **@userinfobot** | 发 `/start` 或随便一句话 → 返回 `User ID` |
| **@getmyid_bot** | 自动返回 numeric ID |
| **@JsonDumpBot** | 返回完整 user JSON（含 ID/username/lang） |

**适用**：你自己拿自己的 UID。

**注意**：国内网络偶尔抽风访问不到 telegram，多试几次 / 切代理。

### 🟢 方法 B — 看 bot inbox log（针对别人）

当**其他用户**想加入 bot 白名单（如团队成员）—— 你（admin）不能让他们装第三方 bot，最稳的是：

1. 让 ta dm 你这个节点的 bot 发任意消息（哪怕 `/start` 也行）
2. 你看 bot 的 inbox log，里面会含发送者 chat_id：
   ```bash
   # 节点 workdir 下：
   ls -lt <workdir>/channel/.anet/nodes/<alias>/channels/telegram/inbox/
   cat <最新的 .json 文件> | grep -E 'chat_id|user_id|sender'
   ```
3. grep 出 chat_id（纯数字）= ta 的 UID
4. 用 `anet channel add telegram <node> --allow <他的 UID>` 加白名单（注意这会覆盖 allow list，得带上你已经 allow 的 UID 一起）

**适用**：批量加团队成员、用户在国内网络拿不到方法 A。

### 🟡 方法 C — Self-pair（**当前未实现**）

理想 UX：
1. 用户 dm bot 发 `/pair`
2. Bot 自动回一个 6 位数 pairing code
3. Admin 在 anet 里 `anet channel pair-approve <code>` 自动 add allow

**这是 anet 还没有的 feature** —— 跟踪在 issue（如果有需求开 P2 issue 跟踪）。当前只能用方法 A + B。

---

## 4. 多用户白名单管理（团队场景）

当前 `--allow` 一次只能传一个 UID。要给一个 bot 配多人 access，两条路：

### 路 A — 一次 add 传多个 `--allow`（CLI 是否支持待验证）

```bash
anet channel add telegram B站负责人 \
  --bot-token <TOKEN> \
  --allow 7612221352 \
  --allow 1234567890 \
  --allow 9876543210
```
（如果 CLI 不支持，需要走路 B）

### 路 B — 直接编辑 access.json

```bash
<workdir>/.anet/nodes/<alias>/channels/telegram/access.json
```
按现有格式补 user_id 数组，然后重启节点。

---

## 5. 完整实操示例（以 B站负责人 接入为例）

```bash
# 1. 在 telegram 创 bot 拿 token（BotFather → /newbot → 取 token）
# 假设拿到 token: 7612221352:AAH-xxxxxxxxxxxxxxxxxxxx

# 2. 拿到 Vincent 的 UID = 7612221352（已通过方法 A 或 B 拿到）

# 3. 进 blueleap workdir 装 channel
cd /home/vansin/blueleap
anet channel add telegram B站负责人 \
  --bot-token 7612221352:AAH-xxxxxxxxxxxxxxxxxxxx \
  --allow 7612221352

# 4. 重启节点
tmux kill-session -t B站负责人
tmux new-session -d -s B站负责人 "cd /home/vansin/blueleap && anet node start B站负责人"

# 5. 等 10s 后 anet ls 看节点 status 是 idle、SSE 是 ●

# 6. Telegram 找你刚建的 bot 发 "你好"，等几秒应该收到 agent 回复
```

---

## 6. 故障排查

### Bot 收不到消息
- 检查 token 是不是 paste 全了（含冒号 `:` 和后面那串）
- BotFather `/mybots` 看 bot 是不是 enabled
- 节点重启了吗？（channels 不热加载）

### Agent 不回 telegram 消息
- 节点 `anet ls` status 是 idle / ●？不是的话 capture-pane 看实际 pane
- 你的 UID 真的在 allow list 里？（看 access.json）
- agent 是不是 busy in commhub？（telegram 跟 commhub 是两条独立 channel，但 agent 一次只能处理一个 conversation）

### channel add 后 anet ls 没显示 telegram
- `anet channel ls <node>` 直接确认 channels 列表
- 看 `<workdir>/.anet/nodes/<node>/config.json` 的 `channels` 数组有没有 `plugin:telegram@claude-plugins-official`

---

## 7. 已知坑

| 坑 | workaround |
|---|---|
| `--allow` 重复 add 覆盖前面的 allow list（不增量） | 一次传齐所有 UID，或手编 access.json |
| Channel 改了不热加载 | 改完必须 `tmux kill + start` 重启节点 |
| 多节点不能共享一个 bot token | BotFather 每个节点 `/newbot` 单建一个 |
| Self-pair 流程没实现 | 当前手动走方法 A+B + admin 加 allow |
| 国内网络访问 @userinfobot 偶发失败 | 走方法 B（让用户 dm bot，看 inbox log） |

---

## 8. Related

- Telegram BotFather: https://t.me/BotFather
- UserInfo Bot: https://t.me/userinfobot
- anet docs: https://anet.sh
- 团队 playbook: [docs/team-collab-playbook.md](./team-collab-playbook.md)
- Rename 节点（重命名后 telegram 是否需重配）: [docs/rename-guide.md](./rename-guide.md)

---

*维护：通信龙 · per Vincent 2026-05-15 telegram 4910 完善请求*
