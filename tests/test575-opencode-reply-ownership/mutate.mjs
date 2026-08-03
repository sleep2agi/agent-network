import { readFileSync, writeFileSync } from "node:fs";

const [mutation, path] = process.argv.slice(2);
if (!mutation || !path) throw new Error("usage: mutate.mjs <mutation> <runtime.ts>");
const source = readFileSync(path, "utf8");
const mutations = {
  "drop-reply-ownership": [
    '          if (message?.info?.role !== "assistant" || message?.info?.parentID !== messageId) {',
    '          if (false) {',
  ],
  "drop-idle-stability": [
    "  const idleStabilityMs = 250;",
    "  const idleStabilityMs = 0;",
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
