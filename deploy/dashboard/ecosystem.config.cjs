// Dashboard 的 PM2 进程定义 —— 与 deploy/hub/ecosystem.config.cjs 同一形状。
//
// 为什么需要它:README 里只有 `pm2 restart anet-dashboard`,而那假定 app
// **已经存在**。空机上没有任何办法从仓里把这个 app 建出来 —— hub 有
// ecosystem 文件、dashboard 没有,这是 #778 纸面演练在 dashboard 链上发现的缺口。
//
// 🔴 只放**非敏感**定义。COMMHUB_TOKEN 等由 PM2 的 saved-env 注入,
//    不在此文件里,也不该进仓。因此:
//      pm2 restart anet-dashboard   ← 不要带 --update-env,带了会丢 saved-env
const { homedir } = require("node:os");
const { join } = require("node:path");

const home = process.env.HOME || homedir();

module.exports = {
  apps: [
    {
      name: "anet-dashboard",
      script: join(home, ".local/bin/dash-start.sh"),
      interpreter: "bash",
      exec_mode: "fork",
      autorestart: true,
      // min_uptime 必须大于「进程失败退出所需时间」。低于它，PM2 会把这次启动
      // 算成功、不计入失败，backoff 永不触发 —— 崩溃循环看起来像正常重启。
      // 这里原本是 20_000，比 docs-site/docs/deploy/daemon.md 记录的 45000 小，
      // 照本仓重建出来的 dashboard 会正好落进那个盲区。对齐到 45000。
      min_uptime: 45000,
      max_restarts: 20,
      exp_backoff_restart_delay: 200,
      // 没有 cwd 是**有意的**,别照着在跑的进程补。
      //
      // 2026-08-18 逐字段比对 `pm2 jlist` 与本文件时,cwd 是唯一一处真实差异:
      // 在跑的 anet-dashboard 的 pm_cwd 是 /home/vansin/agent-orchestra。那不是
      // 一个被选择的值,是**当初谁在哪个目录敲的 `pm2 start`** —— 一个仓库检出
      // 路径,换台机器就不存在。把它写进来会让本文件在别的机器上直接失效。
      //
      // 判据是脚本本身:dash-start.sh 里没有任何 `cd`、没有任何相对路径依赖
      // (唯一一处 `cd` 出现在一句 echo 的提示文案里),所以它与 cwd 无关。
      // 对比 deploy/hub/ecosystem.config.cjs —— 那里的 cwd 是真需要的,而且
      // 写成 join(home, ".commhub") 而不是绝对路径。
    },
  ],
};
