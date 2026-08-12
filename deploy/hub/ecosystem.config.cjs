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
      min_uptime: 20_000,
      max_restarts: 20,
      exp_backoff_restart_delay: 200,
    },
  ],
};
