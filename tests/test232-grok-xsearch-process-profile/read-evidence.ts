import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

function filesBelow(root: string, name: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(path, name));
    else if (entry.isFile() && entry.name === name) found.push(path);
  }
  return found;
}

const home = process.argv[2];
const output = process.argv[3];
if (!home || !output) throw new Error("usage: read-evidence.ts <grok-home> <stream-output>");

let reply = "";
let ended = false;
for (const line of readFileSync(output, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const row = JSON.parse(line);
    if (row.type === "text" && typeof row.data === "string") reply += row.data;
    if (row.type === "end") ended = true;
  } catch {}
}

const calls: Array<{ name: string; arguments: unknown }> = [];
for (const path of filesBelow(home, "chat_history.jsonl")) {
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error("unexpected oversized chat history");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (
      row?.type === "assistant"
      && typeof row.content === "string"
      && (row.tool_calls === undefined || (Array.isArray(row.tool_calls) && row.tool_calls.length === 0))
    ) {
      reply += row.content;
    }
    if (!Array.isArray(row.tool_calls)) continue;
    for (const call of row.tool_calls) {
      if (call && typeof call.name === "string") calls.push({ name: call.name, arguments: call.arguments });
    }
  }
}

// Backend-served tools (including web_search) are lifecycle updates rather
// than ordinary assistant tool_calls in Grok 0.2.93. Read the authoritative
// session/update record as well as chat history; a returned URL alone is not
// accepted as proof that a search happened.
for (const path of filesBelow(home, "updates.jsonl")) {
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error("unexpected oversized updates log");
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const update = row?.params?.update;
    if (update?.sessionUpdate !== "tool_call" && update?.sessionUpdate !== "tool_call_update") continue;
    const title = typeof update.title === "string" ? update.title : "";
    const backendName = typeof update?._meta?.["x.ai/tool"]?.name === "string"
      ? update._meta["x.ai/tool"].name
      : "";
    const name = backendName || title;
    if (name) calls.push({ name, arguments: update.rawInput });
  }
}

const webCalls = calls.filter((call) => /^(web_search|web search:?)/i.test(call.name));
function containsAllowedX(value: unknown): boolean {
  if (typeof value === "string") {
    try { return containsAllowedX(JSON.parse(value)); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(containsAllowedX);
  if (!value || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "allowed_domains" && Array.isArray(nested) && nested.includes("x.com")) return true;
    if (containsAllowedX(nested)) return true;
  }
  return false;
}
const allowedX = webCalls.some((call) => {
  return containsAllowedX(call.arguments);
});
const urls = [...reply.matchAll(/https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+/g)].map((match) => match[0]);

process.stdout.write(JSON.stringify({
  ended,
  toolNames: [...new Set(calls.map((call) => call.name))].sort(),
  webSearchCalls: webCalls.length,
  allowedX,
  xStatusUrls: [...new Set(urls)],
}) + "\n");
