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
  // #201 — broaden gate to admit three new shapes Vincent hit in 6229 UAT:
  //   bare `send_task X Y`, `你去给 X ...`, and `给 X 发/说/沟通/打 ...`.
  // Keep gate cheap (string-fragment OR / no backrefs) — the patterns below
  // do the real shape-matching.
  if (!/\b(?:mcp_commhub__send_task|commhub_send_task|send_task)\b|发任务|派任务|派给|转给|交给|发给|沟通一下|让|请|麻烦|和|你去给|给\s+\S+\s+(?:发|说|沟通|打)/.test(text)) {
    return null;
  }

  const patterns: RegExp[] = [
    /\b(?:mcp_commhub__send_task|commhub_send_task|send_task)\s*\(\s*alias\s*=\s*["']([^"']+)["']\s*,\s*task\s*=\s*["']([\s\S]+?)["']\s*\)/i,
    /\b(?:mcp_commhub__send_task|commhub_send_task|send_task)\s*\(\s*["']([^"']+)["']\s*,\s*["']([\s\S]+?)["']\s*\)/i,
    // #201 Layer 2-① — bare `send_task <alias> <task>` MCP-like syntax
    // Vincent typed directly in UAT (no parens, no quotes). Anchored to
    // start-of-string so we don't accidentally swallow it inside prose.
    /^send_task\s+(\S+)\s+([\s\S]+)$/i,
    /给\s+(.+?)\s*(?:发任务|派任务|send_task)(?:\s*[：:]\s*([\s\S]+))?$/i,
    // #201 Layer 2-③ — `给 X 发/说/沟通/打 [个|消息|一下|...] BODY` generic
    // verb form. Placed after the specific `发任务|派任务|send_task` pattern
    // so e.g. `给 X 发任务: Y` keeps hitting the more specific match. The
    // verb-suffix non-capturing group strips `发个消息` / `打个招呼` / etc
    // so BODY reads as the actual task content.
    /给\s+[「『"'’“@＠]?(\S+?)[」』"'’“]?\s+(?:发(?:个?消息|个)?|说(?:一下)?|沟通(?:一下)?|打(?:个?招呼)?)\s+([\s\S]+)$/i,
    /(?:派给|转给|交给|发给)\s+(.+?)\s*[：:，,]\s*([\s\S]+)$/i,
    // #201 Layer 2-② — `你去给 X BODY` colloquial form. Body keeps its verb
    // (`打个招呼` IS the task, unlike the `给 X 发...` form above where the
    // verb is meta-delegation noise).
    /你去给\s+[「『"'’“@＠]?(\S+?)[」』"'’“]?\s+([\s\S]+)$/i,
    /(?:你\s*)?和\s*(@?[^\s，,：:。.!?！？]+)\s*(?:沟通一下|send_task(?:\s*一下)?)(?:\s*(?:[，,：:]\s*)?([\s\S]+))?$/i,
    /(?:你\s*)?和\s*(@?[\s\S]+?)\s*沟通一下\s*[，,]\s*([\s\S]+)$/i,
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
