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
      min_uptime: 20_000,
      max_restarts: 20,
      exp_backoff_restart_delay: 200,
    },
  ],
};
