import {
  MOCK_LLM_FALLBACK,
  loadMockLlmRules,
  resolveMockLlmReply,
} from "../../agent-network/src/mock-llm";

export { MOCK_LLM_FALLBACK, loadMockLlmRules, resolveMockLlmReply };

function fail(message: string): never {
  throw new Error(`[mock-llm] ${message}`);
}

function parsePort(raw: string | undefined): number {
  const value = raw ?? "32100";
  if (!/^\d+$/.test(value)) fail("MOCK_LLM_PORT must be an integer from 1 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    fail("MOCK_LLM_PORT must be an integer from 1 to 65535");
  }
  return port;
}

export function startMockLlmServer(
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof Bun.serve> {
  const rules = loadMockLlmRules(env.MOCK_LLM_REPLIES_FILE ?? "");
  const port = parsePort(env.MOCK_LLM_PORT);

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, rules: rules.length });
      }
      if (request.method !== "POST" || url.pathname !== "/reply") {
        return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      }

      let value: unknown;
      try {
        value = await request.json();
      } catch {
        return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
      }
      const prompt = (value as { prompt?: unknown } | null)?.prompt;
      if (typeof prompt !== "string") {
        return Response.json({ ok: false, error: "invalid_prompt" }, { status: 400 });
      }

      const result = resolveMockLlmReply(rules, prompt);
      return Response.json({
        ok: true,
        reply: result.reply,
        matched: result.matched,
        rule_index: result.ruleIndex,
      });
    },
  });
}

if (import.meta.main) {
  try {
    const server = startMockLlmServer();
    console.log(`[mock-llm] listening on http://${server.hostname}:${server.port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
