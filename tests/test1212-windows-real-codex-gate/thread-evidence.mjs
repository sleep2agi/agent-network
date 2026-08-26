import { createHash } from "node:crypto";

const ASSISTANT_TYPES = new Set(["assistant", "outputmessage", "agentmessage"]);
const normalizedType = item => String(item?.type || item?.role || "").toLowerCase().replace(/[^a-z]/g, "");
function textParts(value, key = "") {
  if (typeof value === "string") return /^(text|content|message)$/i.test(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(v => textParts(v, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => textParts(v, k));
}
export function assistantItems(turn) {
  return (turn?.items || []).filter(item => ASSISTANT_TYPES.has(normalizedType(item))).map(item => ({
    id: typeof item.id === "string" ? item.id : null,
    hash: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
    text: textParts(item).join("\n"),
  }));
}
export function assistantSnapshot(turn) {
  return new Set(assistantItems(turn).flatMap(item => [item.id && `id:${item.id}`, `hash:${item.hash}`]).filter(Boolean));
}
export function newHumanDoneAssistant(turn, before, nonce) {
  return assistantItems(turn).find(item => {
    const known = (item.id && before.has(`id:${item.id}`)) || before.has(`hash:${item.hash}`);
    return !known && item.text.includes(nonce) && item.text.includes("HUMAN_DONE");
  });
}
export async function pollCompletedAssistant(read, turnId, before, nonce, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const thread = await read();
    const turn = thread.turns?.find(candidate => candidate.id === turnId);
    const item = turn?.status === "completed" ? newHumanDoneAssistant(turn, before, nonce) : undefined;
    if (item) return { turn, item };
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error("bounded thread/read never observed a new completed-turn HUMAN_DONE assistant item");
}
