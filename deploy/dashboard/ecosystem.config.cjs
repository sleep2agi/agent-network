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
    },
  ],
};
