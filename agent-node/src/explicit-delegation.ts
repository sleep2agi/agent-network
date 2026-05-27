export interface ExplicitDelegation {
  alias: string;
  childTask: string;
}

const SELF_REFERENCES = new Set(["你", "我", "他", "她", "它", "对方", "大家", "我们", "你们", "他们"]);

export function normalizeDelegationAlias(alias: string): string {
  return alias
    .trim()
    .replace(/^[@＠]+/, "")
    .replace(/^[「『“"'【\[]+|[」』”"'】\]]+$/g, "")
    .replace(/[：:，,。.!?！？]+$/g, "")
    .trim();
}

export function extractExplicitDelegation(task: string): ExplicitDelegation | null {
  const text = task.trim();
  if (!text) return null;
  if (!/\b(?:mcp_commhub__send_task|commhub_send_task|send_task)\b|发任务|派任务|派给|转给|交给|发给|沟通一下|让|请|麻烦|和/.test(text)) {
    return null;
  }

  const patterns: RegExp[] = [
    /\b(?:mcp_commhub__send_task|commhub_send_task|send_task)\s*\(\s*alias\s*=\s*["']([^"']+)["']\s*,\s*task\s*=\s*["']([\s\S]+?)["']\s*\)/i,
    /\b(?:mcp_commhub__send_task|commhub_send_task|send_task)\s*\(\s*["']([^"']+)["']\s*,\s*["']([\s\S]+?)["']\s*\)/i,
    /给\s+(.+?)\s*(?:发任务|派任务|send_task)(?:\s*[：:]\s*([\s\S]+))?$/i,
    /(?:派给|转给|交给|发给)\s+(.+?)\s*[：:，,]\s*([\s\S]+)$/i,
    /(?:你\s*)?和\s*(@?[\s\S]+?)\s*沟通一下\s*(?:[，,。.!?！？]\s*([\s\S]+))?$/i,
    /(?:让|请|麻烦)\s+(@?[^\s，,：:。.!?！？]+)\s+([\s\S]+)$/i,
  ];

  let alias = "";
  let childTask = "";
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m?.[1]) continue;
    alias = normalizeDelegationAlias(m[1]);
    childTask = m[2]?.trim() || "";
    break;
  }
  if (!alias || SELF_REFERENCES.has(alias)) return null;

  if (!childTask) {
    const afterColon = text.match(/(?:发任务|派任务|send_task)\s*[：:]\s*([\s\S]+)$/i);
    if (afterColon?.[1]) {
      childTask = afterColon[1].trim();
    } else {
      const sentence = text.match(/(?:让|请)\s*(?:他|她|它|对方|该节点)?\s*([\s\S]+?)(?:。|$)/);
      childTask = sentence?.[1]?.trim() || text;
    }
  }

  childTask = childTask
    .replace(/必须.*?(?:总结回|回复)\s*(?:admin|我).*$/i, "")
    .replace(/并?用\s*commhub_get_task[\s\S]*$/i, "")
    .replace(/^[：:，,\s]+/, "")
    .trim();
  if (!childTask) childTask = text;
  return { alias, childTask };
}
