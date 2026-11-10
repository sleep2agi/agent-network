import { test } from "bun:test";

// 🔴 见证 #2（#1309 评审）：**显式 500ms** 是合法声明。
//    旧解析器 `val if val >= 1000 else None` 把它当数组下标丢掉，
//    于是 450ms/500ms 被按 20000ms 报成 2.25%（应该报 90%）。
test("declared 500 takes 450", async () => {
  await Bun.sleep(450);
}, 500);

// 同一条声明的**反面**：900ms 撞 500ms ⇒ `timed out after 500ms`。
test("declared 500 takes 900", async () => {
  await Bun.sleep(900);
}, 500);

// 🔴 评审见证的**原样**写法：**单行** —— opener 与 closer 在同一行。
//    只认「行首是 `}`」的解析器看不到这一行，会把 450ms 算成 450/5000 = 9%。
test("one line 500 takes 450", async () => { await Bun.sleep(450); }, 500);
