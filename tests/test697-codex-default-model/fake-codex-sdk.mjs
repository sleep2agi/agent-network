// Test-only package body copied over @openai/codex-sdk inside the disposable
// Docker container. Each fresh agent-node process imports this through the
// exact production dynamic-import path.
import { appendFileSync } from "node:fs";

const capture = process.env.TEST697_CODEX_CAPTURE || "/tmp/test697-codex-capture.jsonl";
let streamedCalls = 0;
const record = (kind, value) => appendFileSync(capture, JSON.stringify({ kind, value }) + "\n");

function thread(opts) {
  return {
    id: "test697-thread",
    async runStreamed() {
      streamedCalls++;
      record("runStreamed", { call: streamedCalls });
      if (process.env.TEST697_CODEX_FAIL_FIRST === "1" && streamedCalls === 1) {
        throw new Error("test697 forced first-turn failure");
      }
      return { events: (async function* () {
        yield { type: "item.completed", item: { type: "agent_message", text: "TEST697_OK" } };
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
      })() };
    },
    async run() { record("run", opts); return { finalResponse: "TEST697_RETRY_OK" }; },
  };
}

export class Codex {
  constructor(config) { record("Codex", config); }
  startThread(opts) { record("startThread", opts); return thread(opts); }
  resumeThread(id, opts) { record("resumeThread", { id, opts }); return thread(opts); }
}
