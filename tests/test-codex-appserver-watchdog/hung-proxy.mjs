// #465 —— 让一个活着的 app-server「卡死」:在 --listen 端口上做 TCP 转发到真正的(假)app-server,
// 按模式文件决定每条**新**连接怎么处理(已建立的连接照常转发,和现场一样:桥的老连接还在,新握手全失败)。
//
//   (空 / 没有文件)  正常转发
//   close1006        接受连接后立刻断开 → 客户端 ws 以 1006(异常关闭)结束,握手不成
//   silent           接受连接后一个字节都不回 → 客户端握手超时;并且忽略 SIGTERM / SIGHUP(逼出 SIGKILL 那条路)
//
// 用法:bun hung-proxy.mjs <listenPort> <innerPort> <modeFile>
import { createConnection, createServer } from "node:net";
import { readFileSync } from "node:fs";

const [listenPort, innerPort, modeFile] = process.argv.slice(2);
const mode = () => { try { return readFileSync(modeFile, "utf8").trim(); } catch { return ""; } };
const log = (m) => console.log(`[hung-proxy] ${m}`);

// silent 模式下 SIGTERM 和 SIGHUP 都忽略:pane 里的 bash 一死,tmux 会给整个进程组发 SIGHUP,
// 不忽略它的话 SIGKILL 那条路永远走不到(真 codex 是 pane 进程本身,不靠这个)。
for (const sig of ["SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (mode() === "silent") { log(`${sig} ignored (silent mode)`); return; }
    log(`${sig} → exit`);
    process.exit(0);
  });
}

const server = createServer((client) => {
  const m = mode();
  if (m === "close1006") { client.destroy(); return; }
  if (m === "silent") { client.on("error", () => {}); return; }
  const upstream = createConnection({ host: "127.0.0.1", port: Number(innerPort) });
  client.pipe(upstream).pipe(client);
  const drop = () => { client.destroy(); upstream.destroy(); };
  client.on("error", drop);
  upstream.on("error", drop);
  client.on("close", drop);
  upstream.on("close", drop);
});
server.listen(Number(listenPort), "127.0.0.1", () => log(`listening ${listenPort} → ${innerPort}`));
