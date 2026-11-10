// 桥侧入站路径的**本地仿真**：不连飞书，直接喂一条合成事件给
// createIPCEventHandler，看它对"收到消息之后"做了哪些事。
//
// 为什么值得做：真机验证要等一个真人发消息，而桥这一侧的逻辑（去重、队列提示、
// 上下文拉取、回复转投）与飞书传输无关 —— 用假 adapter 就能把它的行为钉住。
// 它证明不了"飞书把事件推给了我们"，但能证明"事件到了之后我们做对了"。
import { createIPCEventHandler, withDedup } from "../agent-network/src/im/feishu/bridge.ts";

const sent: Array<{ text: string; kind: string }> = [];
const fakeAdapter: any = {
  connectionName: "仿真节点",
  send: async (m: any) => { sent.push({ text: m.text ?? "(image/file)", kind: "send" }); return { messageId: "om_fake" }; },
  fetchRecentContext: async () => ([
    { msg_type: "text", body: { content: JSON.stringify({ text: "上一句：那个报错还在吗" }) }, sender: { id: "ou_x", sender_type: "user" } },
  ]),
};

// 假装自己是 fork 出来的子进程
const outbox: any[] = [];
(process as any).send = (msg: any) => { outbox.push(msg); return true; };

// 签名是位置参数：(adapter, ttlMs, ackPlaceholder, correlationStore)
// 去重**不在** createIPCEventHandler 里，它是外面包的一层（withDedup）——
// 真机上由 worker 的 dispatcher 套上。仿真要把同一套包装也套上，否则测的是另一条路。
const handler = withDedup(createIPCEventHandler(fakeAdapter, 60_000, false, undefined));

const ev = (key: string) => ({
  platform: "feishu",
  connectionId: "仿真节点#feishu",
  conversation: { platform: "feishu", conversationId: "oc_fake", conversationType: "group", threadRootId: null },
  sender: { id: "ou_x" },
  messageId: "om_1",
  mentioned: true,
  content: { text: "在吗" },
  receivedAt: Date.now(),
  idempotencyKey: key,
});

// ① 第一条：应该直接转给父进程（agent-node），带上下文块
await handler(ev("k1") as any);
const first = outbox[0]?.event;
console.log("① 第一条 → 转给父进程:", !!first);
console.log("   带 contextBlock:", typeof outbox[0]?.contextBlock === "string" && outbox[0].contextBlock.includes("不是新指令"));
console.log("   outboundDir 是否给出:", typeof outbox[0]?.outboundDir === "string");

// ② 同一条再投一次（飞书会重复投递）→ 必须被去重，不再转
const before = outbox.length;
await handler(ev("k1") as any);
console.log("② 重复投递 → 被去重:", outbox.length === before);

// ③ 第二条不同的消息，在第一条还没回复时 → 应发"排队"提示
const sentBefore = sent.length;
await handler(ev("k2") as any);
const queued = sent.slice(sentBefore).some((s) => s.text.includes("已排队"));
console.log("③ 有积压时 → 发排队提示:", queued, queued ? `(${sent[sentBefore].text.slice(0, 24)}…)` : "");

// ④ 模拟父进程回复第一条 → 应该发到会话里
process.emit("message", { type: "reply", eventKey: "k1", text: "在的，你说" } as any);
await new Promise((r) => setTimeout(r, 50));
console.log("④ 父进程回复 → 发到飞书会话:", sent.some((s) => s.text === "在的，你说"));
