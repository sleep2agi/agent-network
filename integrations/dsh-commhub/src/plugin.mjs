// DSH (DeepSeek Harness) plugin: makes a DSH agent a node on an Agent Network hub.
// Glue only — the protocol lives in node-loop.mjs / hub-client.mjs.
import { brandString } from "@deepseek-ai/dsh-brand";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHubClient } from "./hub-client.mjs";
import { createLedger } from "./ledger.mjs";
import { createCommhubNode } from "./node-loop.mjs";
import { commhubToolSpecs } from "./tools.mjs";
import { resolveConfig } from "./config.mjs";

export const name = "commhub";
export const inject = ["agents", "agentDefaultModel", "sessions", "tools"];

const VERSION = "dsh-commhub@0.1.0-preview.0";

/** Final assistant text of the turn that started at `firstSeq` (same approach as dsh-headless). */
export function summarizeTurn(session, firstSeq) {
  let started = false; let text = ""; let reason; const errors = [];
  for (let seq = firstSeq; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq));
    if (!event) continue;
    if (event.type === "turn/start") { started = true; continue; }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
    if (/error/i.test(event.type)) errors.push(describe(event.data));
  }
  return { text, reason, errors };
}

const describe = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v).slice(0, 400); } catch { return String(v); }
};

async function runTurn(ctx, prompt, sessionId) {
  const selection = ctx.agentDefaultModel.currentSelection();
  const { agent } = await ctx.agents.create({
    sessionId: brandString(sessionId),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: void 0 }); },
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(createUserMessage({ content: [{ type: "text", text: prompt }], source: { kind: "user" } }));
  await agent.whenIdle();
  await ctx.sessions.flush(agent.session);
  const { text, reason, errors } = summarizeTurn(agent.session, firstSeq);
  if (!text && reason && typeof reason === "object" && reason.kind && reason.kind !== "completed") {
    // Surface whatever the session recorded, so the task sender sees the real cause.
    const detail = [describe(reason), ...errors].filter(Boolean).join("; ").slice(0, 600);
    throw new Error(`turn ended: ${reason.kind}${detail ? ` — ${detail}` : ""}`);
  }
  return text;
}

export function apply(ctx, config) {
  const log = (m) => console.log(`[commhub] ${new Date().toISOString().slice(11, 19)} ${m}`);
  let cfg;
  try { cfg = resolveConfig(config); } catch (e) {
    console.warn(`[commhub] not starting: ${e.message}`);
    return;
  }
  const client = createHubClient({ hub: cfg.hub, token: cfg.token, networkId: cfg.networkId, clientVersion: VERSION });

  for (const spec of commhubToolSpecs(client, cfg.alias)) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: { type: "object", additionalProperties: true, properties: {
          ok: { type: "boolean", required: true }, id: { type: "string", required: true } } },
        render: (_args, value) => [{ type: "text", text: spec.render(value) }],
      },
      async execute(args) {
        const out = await spec.handler(args);
        log(`tool ${spec.name}${args?.alias ? ` → ${args.alias}` : ""}: ${out.id}`);
        return out;
      },
    }));
  }

  const node = createCommhubNode({
    client, alias: cfg.alias, ledger: createLedger(cfg.ledgerPath), log,
    heartbeatMs: cfg.heartbeatMs, pollMs: cfg.pollMs, turnTimeoutMs: cfg.turnTimeoutMs, version: VERSION,
    runTurn: (prompt, task) => runTurn(ctx, prompt, `commhub-${task.task_id || task.id}`),
  });

  ctx.effect(() => {
    void node.start();
    log(`plugin loaded alias=${cfg.alias} hub=${client.hub}`);
    return () => { void node.stop(); };
  }, "commhub.lifecycle");
}
