import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
const specs = {
  origin: {
    path: "agent-node/src/runtime/feishu-envelope.ts",
    before: "return `feishu:${type}:${conversationId}:${senderId}`;",
    after: "return `feishu:${conversationId}`;",
  },
  codex: {
    path: "agent-node/src/runtime/codex-app-server-bridge.ts",
    before: "const fromLabel = displaySender(input.from);",
    after: "const fromLabel = undefined; // test mutation: drop channel provenance",
  },
};

const spec = specs[mode];
if (!spec) throw new Error(`usage: mutate.mjs ${Object.keys(specs).join("|")}`);
const source = readFileSync(spec.path, "utf8");
const hits = source.split(spec.before).length - 1;
if (hits !== 1) throw new Error(`mutation anchor ${mode} matched ${hits} times`);
writeFileSync(spec.path, source.replace(spec.before, spec.after));
console.log(`mutation ${mode}: applied exact anchor in ${spec.path}`);
