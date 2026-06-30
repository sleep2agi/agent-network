# 经典案例：飞书 Bot「连接正常，消息却石沉大海」

> 一次真实排障的复盘。Bot 显示在线、日志一切正常，用户发消息却始终没有回复。最终根因既不是网络、也不是事件订阅，而是 **Channel 访问白名单里存着旧 App 下的身份 ID**。
>
> 这个案例的价值有两层：① 一个换 App 后极易踩、且症状极具迷惑性的坑；② 一套「不要从症状直接跳根因」的排障纪律。

## 现象

- 飞书自建应用换了一个新 App（从任务型应用切到带 IM 能力的新应用）。
- Bot 进程健康：日志有 `client ready`、`event-dispatch is ready`、`bridge online`，长连接已建立。
- 用户在单聊里发「你好」，**Bot 毫无反应**——既不报错，也不回复。
- 反复重启、反复确认飞书后台「权限、事件订阅、发布版本都配了」，依旧无效。

## 三次误判（弯路）

排障过程中先后给出三个**错误**结论，每一个听起来都很合理，但都没有决定性证据支撑：

1. **「新 App 的已发布版本没订阅 `im.message.receive_v1`」**
   依据是日志里只看到任务类事件被推送。看似成立，但只是「没看到消息事件」，不等于「订阅缺失」。
2. **「多个长连接在抢事件」**
   多次重启确实留下过孤儿连接，飞书会把事件分发到同一 App 的多个活跃长连接上。这是个**真实存在但非本例根因**的干扰项。
3. **怀疑模型层（空响应）**
   因为该模型经某些网关确有「成功信号但抽不出文本」的历史问题，一度怀疑是模型回了空。同样没有证据。

> 教训：**每一个「根因」结论都应该有一条决定性日志/实验支撑，而不是「症状看起来像」。** 前三次都是从症状直接跳结论，所以全错。

## 决定性诊断

用户的一句话点醒了方向：「你先别用容器，用最简单的代码测一下不就知道了？」

于是写了一段**最小独立脚本**（纯 SDK 长连接，绕开整个产品栈），用新 App 凭证订阅 `im.message.receive_v1`，打印收到的事件。结果：

```
>>>>> GOT im.message.receive_v1 — text="你好" <<<<<
```

**这一条就推翻了前两个结论**：新 App 确实订阅了消息事件、长连接确实能收到消息。问题一定在产品栈内部。

把范围锁回容器后，清理到只剩一个干净连接，再发消息，日志里出现了真正的决定性证据：

```
[feishu:audit] deny from=ou_XXXXXXXX conv=dm — sender not in allowFrom (dm)
```

消息**收到了**，但被 Channel 的访问控制**拒收**了。

## 根因

飞书的 `open_id`（用户身份）和 `chat_id`（会话）都是**按 App 隔离**的——**同一个人，在不同 App 下的 `open_id` 完全不同**。

换 App 后：

- 用户在新 App 下的 `open_id` 变了；
- 但 Channel 的 `access.json` 里 `allowFrom` / `allowChats` 存的还是**旧 App 下的 ID**；
- 于是每条消息都命中「发件人不在白名单」→ 静默拒收。

所以「收不到消息」的真相是「**收到了，但被自己这边的白名单拒了**」。日志里那条 `[feishu:audit] deny` 就是铁证，可惜前期没去看它。

## 修复

把用户在**新 App 下**的 `open_id` 加进 `allowFrom`、把单聊 `chat_id` 加进 `allowChats`，重启节点让 Worker 重新加载 `access.json`：

```jsonc
// <node>/channels/feishu/access.json
{
  "allowFrom": [
    "ou_NEW_APP_OPEN_ID"        // 用户在新 App 下的 open_id（不是旧 App 的！）
  ],
  "allowChats": [
    "oc_NEW_APP_CHAT_ID"        // 单聊 / 群会话在新 App 下的 chat_id
  ]
}
```

重启后再发消息，链路全通：

```
[feishu:bridge] placeholder sent ...      # 接收并占位
[claude] success | ... | out>0            # 模型正常生成回复
[feishu:bridge] reply text sent ...        # 回复送达
```

## 换飞书 App 必须同步改的三处

这是本案例最核心的 Checklist。**换 App 时三处都要改，最容易漏的是第三处：**

| # | 位置 | 内容 |
|---|---|---|
| 1 | 进程环境 / 部署配置 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` |
| 2 | `<node>/channels/feishu/.env` | 同上（Worker 实际读这个文件，可能覆盖环境变量） |
| 3 | **`<node>/channels/feishu/access.json`** | **`allowFrom` / `allowChats` —— 因为 `open_id` / `chat_id` 随 App 变，旧 ID 会全部失效** |

漏掉第 3 处的典型症状：**`client ready` 正常、能看到事件、但用户消息「毫无反应」**。

## 通用诊断决策树（Bot 收不到消息时）

把这次的教训沉淀成一棵从「连接 → 订阅 → 访问控制」三层依次收窄的决策树：

**先看 Worker 日志有没有 `client ready` / `event-dispatch is ready`。**

- **A) 没有 `client ready`、反复连接失败**
  = 长连接连不上 = **网络阻断**（企业网 / DPI 挑域名阻断）。换到能访问飞书长连接域名的网络部署，重启、改配置都无用。

- **B) 有 `client ready`，但日志零事件**
  = 连上了、平台却不推 = **App 侧事件订阅问题**。最常见：订了错的事件、缺 `im.message.receive_v1`、订阅方式没设成「使用长连接」、或改完没「创建版本 → 发布」。

- **C) 有 `client ready`、有事件进来、但 Bot 不回**（本案例）
  = 消息收到了，被**应用层拒了**。**必须 grep 日志 `deny` / `allowFrom`**：
  - `[feishu:audit] deny ... not in allowFrom` → 白名单问题（换 App 后最常见，见上）。
  - `empty vendor result` → 模型生成了但抽不出文本（多为模型 × 网关响应格式不兼容），换一个兼容的模型。
  - `No conversation found` → 会话状态失效，清理节点的 session 字段后重启。

## 沉淀下来的排障纪律

1. **不要从症状直接跳根因。** 每个「根因」结论都要有一条决定性日志或一个最小实验撑着。
2. **最小可复现优先。** 一段绕开整个产品栈的独立脚本，往往一下就把范围劈成两半（是平台/网络问题，还是自己代码问题）。
3. **先把环境清到「只有一个变量」。** 多个孤儿连接、多份残留配置会让现象漂移、误导判断。
4. **`deny` 这类「被自己拒掉」的日志，要主动去 grep。** 「没反应」既可能是「没收到」，也可能是「收到了被拒」，两者排查方向完全不同。

## 同源案例：图片识别不了

几天后又踩一个**症状相似、纪律相通**的坑，值得一起记。

**现象**：给 bot 发图片，它回「`[agent-node] 收到事件但没有可处理的文本/图片内容`」。文字消息一切正常，唯独图片不认。

**又是三次误判**（同样的毛病）：先怀疑「用户发的是转发卡片不是直接图」，再怀疑「app 缺图片下载权限」，再怀疑「模型不支持 vision」——全凭症状猜，没有证据。

**决定性诊断**：
1. 用独占连接的探针抓飞书**原始事件**，确认 `msg_type=image`、带合法 `image_key` ——**是直接图片，前两个猜测推翻**。
2. 关键一步：worker 的图片下载函数是 `catch { return null }`，**把所有下载错误都吞了**，所以日志里什么都看不到。给这个 `catch` **注入一行错误日志**后再发图，立刻抓到：

```
[feishu:image] … downloadImage threw: X.on is not a function
```

**根因**：飞书 SDK（lark node-sdk v1.68）的 `im.messageResource.get()` 返回的是一个**包装对象**（有 `.getReadableStream()` / `.writeFile()` 方法），**不是**可以直接 `.on("data")` 的原始流。旧版 worker 直接对它调 `.on()` → 抛错 → 被 `catch` 吞掉 → 图片字节读不出 → 当成「没有内容」。

**修复**：`const stream = resp.getReadableStream()` 再 `stream.on("data", …)`。一行之差。这正是官方 [PR #324](https://github.com/sleep2agi/agent-network/pull/324)（`fix(#179 image): downloadImage SDK misuse`）已经修过的——**踩坑的容器跑的是 #324 之前的旧版本**（如 `2.2.22-preview.2`）。升级到含修复的 preview 即根治。修后实测：图片落盘 → `multimodal: 1/1 image(s) attached` → 模型 vision 推理 `success`（出 2000+ token 的看图回复）→ 回复送达，全链路通。

**这个案例补充的两条纪律**：

5. **静默的 `catch { return null }` 是元凶级反模式。** 它把真正的错误藏起来，让你只能盯着「没反应」干瞪眼。排查这类问题，**第一步就是给 catch 加一行日志**，让错误自己说话——本例加完一次发图就定位了。
6. **行为跟最新代码不符时，先怀疑「版本漂移」。** 同一个 bug 可能官方早修了，你的部署却跑着旧版本。`cat node_modules/<pkg>/package.json` 的 version 跟 `npm view <pkg>@preview version` 对一下，往往一秒看穿。

**图片识别 checklist**：① 模型是 vision-capable（MiniMax-M3 / Claude Sonnet 等）；② 节点 `flags.modelImageCapable=true`；③ agent-network 版本含 [#324](https://github.com/sleep2agi/agent-network/pull/324) 下载修复（用够新的 preview）。三者齐备，发图即识别。
