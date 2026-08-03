import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: mutate.mjs <runtime.ts>");
const source = readFileSync(path, "utf8");
const before = '          if (message?.info?.role !== "assistant" || message?.info?.parentID !== messageId) {';
const after = '          if (false) {';
const first = source.indexOf(before);
if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
  throw new Error("expected exactly one reply ownership anchor");
}
writeFileSync(path, source.replace(before, after));
console.log("MUTATED drop-reply-ownership");
