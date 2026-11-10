// 队列控制命令 —— 用户能对"还没跑的那几条"做事。
//
// 为什么需要它：队列再可见，也只有"看着"。用户真正的需求是三种动作：
//   看还剩谁（/q）· 把某条提到前面（/prio 2）· 撤掉发错的那条（/cancel 2）
//
// 设计取舍：
//   · 只认**独立成行**的短命令（`/q`、`/cancel 2`），不做前缀匹配 ——
//     否则"帮我 /q 一下"这种正常句子会被当成命令吃掉。
//   · 命令只作用于**未开始**的条目；正在跑的那条撤不掉（那是"打断"，另一套机制）。
//   · 认不出参数时不猜：回一句用法，而不是默默什么都不做。

export type QueueCommand =
  | { kind: "list" }
  | { kind: "cancel"; position: number }
  | { kind: "promote"; position: number }
  | { kind: "clear"; onlyMine: true }
  | { kind: "steer"; text: string }
  | { kind: "help" }
  | { kind: "none" };

const CMD = /^\/(q|queue|cancel|drop|prio|promote|clear|steer)(?:\s+([\s\S]+))?\s*$/i;

/**
 * 解析一条消息是不是队列命令。
 *
 * 只看**整条消息**（trim 后）是否形如 `/q` / `/cancel 2`。
 * 返回 `{kind:"none"}` 表示"这是正常内容，进入队列"。
 */
export function parseQueueCommand(text: string | undefined): QueueCommand {
  const raw = (text ?? "").trim();
  if (!raw.startsWith("/")) return { kind: "none" };
  const m = CMD.exec(raw);
  if (!m) {
    // 以 / 开头但不是已知命令：不要吞掉（可能是路径、或是别人的斜杠命令），
    // 只有当它明显是想管队列时才回用法。
    if (/^\/(q|queue|cancel|drop|prio|promote|clear)\b/i.test(raw)) return { kind: "help" };
    return { kind: "none" };
  }
  const verb = m[1].toLowerCase();
  const arg = m[2];
  if (verb === "steer") {
    // 改口：把这条并进正在跑的那一轮。必须有正文，空的那是打错字。
    const text = (arg ?? "").trim();
    return text ? { kind: "steer", text } : { kind: "help" };
  }
  if (verb === "q" || verb === "queue") return { kind: "list" };
  if (verb === "clear") return { kind: "clear", onlyMine: true };
  if (verb === "cancel" || verb === "drop" || verb === "prio" || verb === "promote") {
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1) return { kind: "help" };
    return verb === "prio" || verb === "promote" ? { kind: "promote", position: n } : { kind: "cancel", position: n };
  }
  return { kind: "help" };
}

export const QUEUE_HELP_TEXT = [
  "队列命令（只作用于**还没开始**的条目）：",
  "  /q            看排了谁（位次 + 等了多久）",
  "  /cancel <位次> 撤掉那一条（发错/不想等了）",
  "  /prio <位次>   把那条提到前面",
  "  /clear        撤掉我还没开始的全部",
  "  /steer <新指令> 把这条**并进**正在跑的那一轮（改口；不排队）",
  "正在跑的那条撤不掉 —— 那属于「打断」，不是「撤回」。",
].join("\n");
