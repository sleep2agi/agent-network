const { homedir } = require("node:os");
const { join } = require("node:path");

const home = process.env.HOME || homedir();

module.exports = {
  apps: [
    {
      name: "commhub-hub",
      script: join(home, ".local/bin/hub-daemon.sh"),
      cwd: join(home, ".commhub"),
      interpreter: "bash",
      exec_mode: "fork",
      autorestart: true,
      // min_uptime 必须大于「进程失败退出所需时间」。低于它，PM2 会把这次启动
      // 算成功、不计入失败，backoff 永不触发 —— 崩溃循环看起来像正常重启。
      //
      // 🔴 这里原本是 20_000，而 hub-daemon.sh 的每一条预检失败都走 fail_slow()：
      //    `sleep 30` 之后才 `exit 1`，所以一次失败启动要 ~30 秒才退出。20_000 < 30s
      //    ⇒ 这道保护是死的。容器里拿真 PM2 对同一个「30 秒后失败退出」脚本实测
      //    （100 秒，约 3 个周期）：
      //      min_uptime=20000 → restarts 3, unstable restarts 【0】← 退避从不触发
      //      min_uptime=45000 → restarts 3, unstable restarts  3
      //    unstable restarts 停在 0 = PM2 认为每次都启动成功，max_restarts: 20
      //    永远累加不上。核对时要看这个字段，只看 restarts 两种情况长得一样。
      //
      //    deploy/dashboard/ecosystem.config.cjs 早已因同一原因从 20_000 对齐到
      //    45000（dash-start.sh 的失败路径同样是 sleep 30），当时漏了 hub 这份 ——
      //    而 hub 是全网单点。这里补上。
      min_uptime: 45_000,
      max_restarts: 20,
      exp_backoff_restart_delay: 200,
    },
  ],
};
