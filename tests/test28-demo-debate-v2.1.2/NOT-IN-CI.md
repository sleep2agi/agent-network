# 为什么 test28-demo-debate-v2.1.2 不进 per-PR CI

Verified: 2026-08-20
Revisit-when: 这个 demo 不再需要真实模型回复才能走完 9 步流程时
              （例如引入可注入的 mock runtime，或 CI 获得可用的模型凭据）——
              那时它就该进 qa.sh 的 L1_TESTS，并删掉本文件。

## 理由：它需要**真实模型凭据**，而 CI 没有

`anet demo debate` 会真的创建并启动 **6 个 agent**（主持人 / 正反 4 辩 / 评委），
然后逐步驱动 9 步流程，每一步都**等一个真实的模型回复**。

干净容器里实测（origin/main `8cef4477`，`--no-cache`）：

```
  [2/4] 启动 6 个 agent (tmux session)...
  [3/4] 驱动辩论流程 (9 步)...
  [1/9] 开场 (主持人-…) ...
  ❌ 流程失败: timeout waiting for 主持人-… reply
```

而同一个容器里凭据是空的：

```
  ANTHROPIC_API_KEY        <empty>
  OPENAI_API_KEY           <empty>
  CLAUDE_API_KEY           <empty>
  XAI_API_KEY              <empty>
  GROK_CODE_XAI_API_KEY    <empty>
  ~/.claude 存在: 否
```

⇒ **主持人不可能回复**，所以第 1 步必然超时。**这不是代码缺陷，是环境要求。**

## 🔴 它其实跑得比看起来远

值得写下来，免得下一个人只看退出码就以为它一开始就崩了：

- 6 个 agent **创建成功**、tmux 启动成功
- 超时之后**清理逻辑全部正确执行**（删掉 6 个 agent + 删掉独立 network）
- 日志最后甚至打印 `🏁 完成！`

⇒ 也就是说：**尾部输出看起来像成功，而 rc=1。**
判据是 `grep -q "流程失败" "$LOG_DIR/demo.log"`（`run.sh:104-105`），
那句 `流程失败` 在日志**中间**（第 67 行），全文只出现 **1 次**。
只看 `tail` 会得出"它成功了"的相反结论 —— 这一格我自己先踩了一次。

## 不要用这些方式让它变绿

- ❌ 放宽/删掉 `grep -q "流程失败"` ⇒ 那样它在**真的**流程失败时也不会红
- ❌ 加长超时 ⇒ 没有凭据时等多久都不会有回复
- ✅ 正解是给它一个**可注入的 mock runtime**，或在有凭据的环境里手动跑：
      docker run --rm -e ANTHROPIC_API_KEY=... <img>
