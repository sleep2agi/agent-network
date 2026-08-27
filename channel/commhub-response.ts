// #1100 — parse a commhub MCP `tools/call` response envelope into a plain
// result object, WITHOUT ever throwing on a non-JSON or isError body.
//
// Bug this fixes: the old inline logic did
//   `content[0].text ? JSON.parse(content[0].text) : json`
// unconditionally. A commhub tool that fails input validation comes back
// as an isError result whose text is a human-readable STRING, e.g.
//   "MCP error -32602: … Too big: expected number to be <=100 at progress"
// JSON.parse'ing that threw, and the throw surfaced to the caller as an
// opaque `-32603 JSON Parse error: Unexpected identifier "MCP"` — a
// parameter-range error wearing a protocol-error mask, which sends
// debugging to the wrong layer (the reporter chased task text / MCP link
// for three retries before isolating `progress > 100`).
//
// Contract: the returned value is ALWAYS a plain object; error paths yield
// `{ ok: false, error: <readable message> }` so the caller can read WHY
// the call was rejected. Pure + side-effect free so it is unit-testable
// without importing node-server.ts (which connects a stdio transport at
// module load).
export function parseCommhubToolResult(json: any): any {
  const contentText = json?.result?.content?.[0]?.text;
  if (contentText != null && contentText !== "") {
    // isError → the text is an error STRING, not JSON. Surface it as a
    // structured error instead of parsing (and throwing on) it.
    if (json.result.isError) return { ok: false, error: contentText };
    // Success payloads are JSON-stringified by commhub tools; still never
    // let a non-JSON body throw — degrade to a readable structured error.
    try { return JSON.parse(contentText); }
    catch { return { ok: false, error: contentText }; }
  }
  // JSON-RPC error envelope (no result.content) — surface readably too.
  if (json?.error) {
    return { ok: false, error: `commhub error: ${typeof json.error === "string" ? json.error : JSON.stringify(json.error)}` };
  }
  return json;
}
