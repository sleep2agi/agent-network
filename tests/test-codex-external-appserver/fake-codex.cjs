#!/usr/bin/env node
// Fake codex for tests/test-codex-external-appserver. Records what it was given
// (argv, env NAMES, cwd) to $FAKE_DIR/<mode>-<pid>.json — env VALUES are never
// written, except two booleans that answer "did the token / CODEX_HOME arrive".
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const dir = "/tmp/fake-codex";
fs.mkdirSync(dir, { recursive: true });
const argv = process.argv.slice(2);
const mode = argv.includes("app-server") ? "appserver" : argv.includes("resume") ? "tui" : "other";
let tokenMatchesConfig = null;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config.json"), "utf8"));
  tokenMatchesConfig = typeof cfg.token === "string" && cfg.token.length > 0 && process.env.ANET_CODEX_COMMHUB_TOKEN === cfg.token;
} catch { /* not run from a node dir */ }
const rec = {
  mode, pid: process.pid, ppid: process.ppid, argv, cwd: process.cwd(), t: Date.now(),
  envNames: Object.keys(process.env).sort(),
  codexHome: process.env.CODEX_HOME || null,
  tokenMatchesConfig,
};
fs.writeFileSync(path.join(dir, `${mode}-${process.pid}.json`), JSON.stringify(rec));
if (argv[0] === "--version") { console.log("codex-cli 0.0.0-fake"); process.exit(0); }
if (mode === "appserver") {
  const url = new URL(argv[argv.indexOf("--listen") + 1]);
  const t0 = Date.now();
  let delay = 0;
  try { delay = Number(fs.readFileSync(path.join(dir, "ready-delay-ms"), "utf8").trim()) || 0; } catch {}
  const never = fs.existsSync(path.join(dir, "never-ready"));
  http.createServer((req, res) => {
    if (req.url === "/readyz") {
      const ok = !never && Date.now() - t0 >= delay;
      if (ok && !fs.existsSync(path.join(dir, `ready-${process.pid}`))) fs.writeFileSync(path.join(dir, `ready-${process.pid}`), String(Date.now()));
      res.writeHead(ok ? 200 : 503); res.end(ok ? "ok" : "starting");
      return;
    }
    res.writeHead(404); res.end();
  }).listen(Number(url.port), url.hostname, () => console.log(`fake app-server listening on ${url.href}`));
} else {
  console.log(`fake codex ${mode}`);
  setInterval(() => {}, 1 << 30);
}
