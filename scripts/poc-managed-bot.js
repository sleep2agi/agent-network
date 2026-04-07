#!/usr/bin/env node
/**
 * PoC: Telegram Managed Bots API 9.6
 *
 * 演示用父 Bot 自动创建和管理子 Bot。
 *
 * 前置条件：
 * 1. 在 @BotFather 中为父 Bot 启用 "Bot Management Mode"
 * 2. 设置环境变量 PARENT_BOT_TOKEN
 *
 * 用法：
 *   PARENT_BOT_TOKEN=xxx node poc-managed-bot.js
 *
 * 流程：
 * 1. 监听 managed_bot update（用户通过链接创建了子 Bot）
 * 2. 调用 getManagedBotToken 获取子 Bot token
 * 3. 用子 Bot token 调用 getMe 验证
 * 4. 可选：用子 Bot 发消息
 */

const PARENT_TOKEN = process.env.PARENT_BOT_TOKEN;
if (!PARENT_TOKEN) {
  console.error("Usage: PARENT_BOT_TOKEN=xxx node poc-managed-bot.js");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${PARENT_TOKEN}`;

async function callAPI(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function main() {
  // 1. 验证父 Bot 身份和 can_manage_bots 能力
  const me = await callAPI("getMe");
  if (!me.ok) {
    console.error("getMe failed:", me);
    process.exit(1);
  }
  console.log(`父 Bot: @${me.result.username} (id: ${me.result.id})`);
  console.log(`can_manage_bots: ${me.result.can_manage_bots ?? "未知（需要先在 BotFather 启用）"}`);

  if (!me.result.can_manage_bots) {
    console.log("\n⚠️  请先在 @BotFather 中为此 Bot 启用 Bot Management Mode");
    console.log("   打开 BotFather → 选择此 Bot → Bot Settings → Bot Management Mode → Enable");
    console.log("\n启用后，分享以下链接给用户创建子 Bot：");
    console.log(`   https://t.me/newbot/${me.result.username}/MyAgentBot?name=My+Agent`);
  }

  // 2. 生成创建链接
  const createLink = `https://t.me/newbot/${me.result.username}/{bot_username}?name={bot_name}`;
  console.log(`\n创建链接模板: ${createLink}`);

  // 3. 长轮询监听 managed_bot update
  console.log("\n开始监听 managed_bot updates（等待用户通过链接创建子 Bot）...");
  console.log("按 Ctrl+C 退出\n");

  let offset = 0;
  while (true) {
    try {
      const updates = await callAPI("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["managed_bot", "message"],
      });

      if (!updates.ok) {
        console.error("getUpdates error:", updates);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      for (const update of updates.result) {
        offset = update.update_id + 1;

        // 处理 managed_bot update（子 Bot 创建/token 变更）
        if (update.managed_bot) {
          const mb = update.managed_bot;
          console.log("━━━ managed_bot update ━━━");
          console.log(`  创建者: ${mb.user?.first_name} (id: ${mb.user?.id})`);
          console.log(`  子 Bot: @${mb.bot?.username} (id: ${mb.bot?.id})`);

          // 4. 获取子 Bot token
          console.log("  正在获取子 Bot token...");
          const tokenResult = await callAPI("getManagedBotToken", {
            bot_id: mb.bot.id,
          });

          if (tokenResult.ok) {
            const childToken = tokenResult.result;
            console.log(`  ✅ Token 获取成功: ${childToken.slice(0, 20)}...`);

            // 5. 用子 Bot token 验证
            const childAPI = `https://api.telegram.org/bot${childToken}`;
            const childMe = await fetch(`${childAPI}/getMe`).then((r) => r.json());
            if (childMe.ok) {
              console.log(`  ✅ 子 Bot 验证成功: @${childMe.result.username}`);
              console.log(`  子 Bot 已就绪，可用于 Agent session`);

              // 可以在这里启动 Agent session：
              // - 配置 Telegram channel plugin 用子 Bot token
              // - 启动 Claude Code / OpenCode session
              // - 子 Bot 自动成为该 Agent 的 Telegram 入口
            } else {
              console.log(`  ❌ 子 Bot 验证失败:`, childMe);
            }
          } else {
            console.log(`  ❌ Token 获取失败:`, tokenResult);
          }
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━");
        }

        // 处理 message 中的 managed_bot_created 服务消息
        if (update.message?.managed_bot_created) {
          const mbc = update.message.managed_bot_created;
          console.log("━━━ managed_bot_created (service message) ━━━");
          console.log(`  子 Bot: @${mbc.bot?.username} (id: ${mbc.bot?.id})`);
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        }
      }
    } catch (err) {
      console.error("轮询错误:", err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch(console.error);
