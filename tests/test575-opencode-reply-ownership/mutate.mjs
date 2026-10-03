import { readFileSync, writeFileSync } from "node:fs";

const [mutation, path] = process.argv.slice(2);
if (!mutation || !path) throw new Error("usage: mutate.mjs <mutation> <runtime.ts>");
const source = readFileSync(path, "utf8");
const mutations = {
  // #520: retargeted after #1910 (ab245d4c) replaced the single
  // role/parentID check with a parent-chain walk. The refusal now happens at
  // `!verdict.accepted`; disabling it lets a human-owned reply through.
  "drop-reply-ownership": [
    "            if (!verdict.accepted) {",
    "            if (false) {",
  ],
  "use-unordered-message-id": [
    "          const messageId = createOpenCodeAscendingMessageId();",
    '          const messageId = `msg_anet_${randomBytes(16).toString("hex")}`;',
  ],
};
const pair = mutations[mutation];
if (!pair) throw new Error(`unknown mutation: ${mutation}`);
const [before, after] = pair;
const first = source.indexOf(before);
if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
  throw new Error(`${mutation}: expected exactly one anchor`);
}
writeFileSync(path, source.replace(before, after));
console.log(`MUTATED ${mutation}`);
