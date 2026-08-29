// 共存启动失败时，用户看到什么。
//
// 由 #1225 的一次真实诊断催生：`anet node start <node> --copresence` 打的是
//
//   [anet] ❌ OpenCode copresence server did not produce its attach launcher within 30s.
//
// 就这一行，没有别的。真正的死因是 bridge 里的 agent-node 崩了
// （`MCP error -32602 … at host.ip`，见 #1498），而那段 stderr 谁都拿不到：
//
//   • CLI 取现场用的是 `tmux capture-pane`，可等待循环的退出条件之一**就是**
//     「bridge 会话已经没了」——会话没了，capture 必然是空；
//   • agent-node 的日志文件里也没有：崩溃走 stderr，日志最后一行停在启动横幅。
//
// 于是定位这条只有一行输出的失败，花掉了一整个复现容器。这个模块负责让
// 下一次不必如此：把 bridge 的输出**落盘**（落盘的东西不随会话消失），
// 失败时指名**是哪一步没成、去哪儿看**。
//
// 🔴 只讲观测到的事实，不猜原因。"attach launcher 没出现"是事实；
//    "opencode 没装好"是猜测 —— 猜错的诊断比没有诊断更贵。

export interface CopresenceStartupFailure {
  /** 等的那个 attach launcher 路径。 */
  attachScript: string;
  /** bridge 输出的落盘文件（可能还不存在——bridge 可能压根没起来）。 */
  bridgeLog: string;
  /** 节点自己的日志目录。 */
  nodeLogDir: string;
  /** 判定失败的那一刻，bridge 的 tmux 会话还在不在。 */
  bridgeAlive: boolean;
  /** 等了多少秒。 */
  waitedSeconds: number;
  /** 落盘日志的尾巴（读不到就给空串）。 */
  logTail: string;
  /** tmux pane 的尾巴；会话已死时必然是空。 */
  paneTail: string;
}

// 按**行**取尾，不按字节取尾，并且逐行截断。
//
// 实测出来的：agent-node 崩溃时 Node 会把出错那一行源码原样打出来，而那是
// 一行 **minified bundle** —— 几十 KB 挤在一行里。按字节取最后 3000 字节，
// 拿到的整整齐齐全是那行压缩代码的中段，真正有用的 `MCP error …` 反而被挤掉。
// #1225 那次我第一版就是这样，屏幕上滚了半屏乱码。
const TAIL_LINES = 20;
const TAIL_LINE_CHARS = 200;

function renderTail(raw: string): string[] {
  if (!raw) return [];
  const all = raw.split("\n");
  while (all.length && all[all.length - 1].trim() === "") all.pop();
  const kept = all.slice(-TAIL_LINES);
  return kept.map((line) => line.length > TAIL_LINE_CHARS
    ? `${line.slice(0, TAIL_LINE_CHARS)}…(本行另有 ${line.length - TAIL_LINE_CHARS} 字符)`
    : line);
}

export function describeCopresenceStartupFailure(f: CopresenceStartupFailure): string[] {
  const lines: string[] = [];
  lines.push(
    `[anet] ❌ OpenCode 共存启动失败：等了 ${f.waitedSeconds}s，attach launcher 没有出现。`,
  );
  lines.push(`[anet]    等的是: ${f.attachScript}`);

  // 🔴 这两种情况的排查方向完全不同，所以必须分开说，而不是合成一句
  //    "启动失败"：会话没了 = 桥里的进程已经退出（去看落盘日志）；
  //    会话还在 = 进程还活着但没走到写 launcher 那一步（超时/卡住）。
  if (f.bridgeAlive) {
    lines.push(`[anet]    bridge 还在跑，但没走到写 launcher 那一步 —— 更像是慢或卡住，不是崩了。`);
  } else {
    lines.push(`[anet]    bridge 已经退出 —— 桥里的 agent-node 在写出 launcher 之前就结束了。`);
  }

  const tail = renderTail(f.logTail.trim() || f.paneTail.trim());
  if (tail.length) {
    lines.push(`[anet]    ── bridge 最后的输出 ──`);
    for (const line of tail) lines.push(`[anet]    ${line}`);
  } else {
    // 说清楚"没有"是什么意思，别让空白被读成"没有异常"。
    lines.push(`[anet]    bridge 没有留下任何输出。`);
  }

  lines.push(`[anet]    完整 bridge 日志: ${f.bridgeLog}`);
  lines.push(`[anet]    节点日志目录:     ${f.nodeLogDir}`);
  return lines;
}
