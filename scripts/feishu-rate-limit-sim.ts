// 验证「白名单里的人连发不再被限流拒」——用生产代码 withRateLimit，两个方向都测：
//   ① 有限白名单 + 发件人在其中 ⇒ 第 2、3 条都放行（进队列）
//   ② 通配符 * ⇒ 仍然限流（那是"陌生人"的形状，洪水保护必须留着）
import { withRateLimit } from "../agent-network/src/im/feishu/bridge.ts";

function makeAdapter(allowFrom: string[]) {
  const sent: string[] = [];
  return {
    sent,
    adapter: {
      getAllowFrom: () => allowFrom,
      send: async (m: any) => { sent.push(m.text ?? ""); return { messageId: "om_x" }; },
    } as any,
  };
}

const ev = (sender: string, chat = "oc_g") => ({
  platform: "feishu",
  connectionId: "n#feishu",
  conversation: { platform: "feishu", conversationId: chat, conversationType: "group", threadRootId: null },
  sender: { id: sender },
  messageId: `om_${Math.random()}`,
  mentioned: true,
  content: { text: "@bot 第几条" },
  receivedAt: Date.now(),
  idempotencyKey: `k_${Math.random()}`,
});

async function run(label: string, allowFrom: string[], sender: string) {
  const { adapter, sent } = makeAdapter(allowFrom);
  let passed = 0;
  const inner = async () => { passed += 1; };
  const limited = withRateLimit(inner as any, adapter);
  for (let i = 0; i < 4; i++) await limited(ev(sender) as any);
  const notices = sent.filter((t) => t.includes("处理频率超出限制")).length;
  console.log(`${label}: 放行 ${passed}/4 · 限流提示 ${notices} 条`);
  return { passed, notices };
}

const a = await run("① 有限白名单（发件人在其中）", ["ou_admin"], "ou_admin");
const b = await run("② 通配符 *（公开形态）", ["*"], "ou_admin");

let ok = true;
if (!(a.passed === 4 && a.notices === 0)) { console.log("❌ 期望：名单内连发全部放行"); ok = false; }
if (!(b.passed < 4 && b.notices > 0)) { console.log("❌ 期望：通配符下仍限流"); ok = false; }
console.log(ok ? "✅ 两个方向都符合预期" : "❌ 与预期不符");
process.exit(ok ? 0 : 1);
