import { test } from "bun:test";

// 🔴 见证 #1（#1309 评审）：**隐式**默认超时。没有 `}, N)`、没有
//    `bunfig.toml`、`qa.sh` 也不传 `--timeout` ⇒ 撞的就是运行器默认。
//    钉死的 bun 1.3.14 实测是 **5000ms**（不是 20000ms）。
test("implicit default", async () => {
  await new Promise(() => {});
});
