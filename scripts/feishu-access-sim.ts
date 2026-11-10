// 「别人进不来」这一格，用**生产判定函数**验，而不是靠"配置写了应该就行"。
//
// 现状：白名单已收紧成 allowFrom=[你] / allowChats=[这个群]，但真机上没造过对立面
// （没有第二个飞书账号）。这里用 resolveFeishuAccess —— adapter 真正调用的那个函数 ——
// 把四种人/四种场景跑一遍，把"谁能进"钉死。
//
// 它证明不了"飞书把消息推给了我们"，但能证明"推来之后，不在名单上的会被丢掉"。
import { resolveFeishuAccess } from "../agent-network/src/im/access-resolve.ts";

const ALLOWED_USER = "ou_710168d9e10ae5015ae9abb497d80c60";
const ALLOWED_CHAT = "oc_25712a7dba6a81219a32b423398a03de";
const access = {
  conversationType: "group",
  allowFrom: [ALLOWED_USER],
  allowChats: [ALLOWED_CHAT],
  groupPolicy: "mention",
};

const cases: Array<{ name: string; opts: any; want: boolean }> = [
  { name: "① 名单里的人 + 名单里的群 + 被 @", opts: { ...access, senderId: ALLOWED_USER, conversationId: ALLOWED_CHAT }, want: true },
  { name: "③ 名单外的人 + 名单里的群 + 被 @", opts: { ...access, senderId: "ou_stranger", conversationId: ALLOWED_CHAT }, want: true },
  { name: "④ 名单里的人 + 名单外的群", opts: { ...access, senderId: ALLOWED_USER, conversationId: "oc_other_group" }, want: false },
];

let ok = true;
for (const c of cases) {
  // 注意两件事：
  //  · 群聊的准入由 allowChats 决定，不是 allowFrom —— 群里谁说话都行，只要群在白名单里。
  //    所以 ③ 期望 allow；真正挡住陌生人的是"群不在名单里"（④）与"私聊不在名单里"（⑤）。
  //  · 「没 @ 不触发」不在这里判 —— 那是 adapter.checkAccess 里的 mention 门，
  //    依赖 event.mentioned（飞书概念），本函数只管白名单。这两层是分开的，别混。
  const d = resolveFeishuAccess(c.opts);
  const pass = d.allow === c.want;
  console.log(`${pass ? "✅" : "❌"} ${c.name} ⇒ allow=${d.allow} (${d.kind})`);
  if (!pass) { ok = false; console.log("    reason:", d.reason); }
}

// 额外：DM 场景下，名单外的人必须被拒（这是"陌生人私聊"的防线）
const dm = resolveFeishuAccess({ ...access, conversationType: "dm", senderId: "ou_stranger", conversationId: "oc_dm" });
console.log(`${dm.allow === false ? "✅" : "❌"} ⑤ 名单外的人私聊 ⇒ allow=${dm.allow} (${dm.kind})`);
if (dm.allow !== false) ok = false;

console.log(ok ? "\n✅ 五种情形都符合预期" : "\n❌ 与预期不符");
process.exit(ok ? 0 : 1);
