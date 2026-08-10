import { readFileSync, writeFileSync } from "node:fs";

const [mode, path] = process.argv.slice(2);
if (!mode || !path) throw new Error("usage: mutate.mjs <mode> <path>");

const mutations = {
  "terminal-precedence": [
    "if (TERMINAL_STATUSES.has(input.status)) {",
    "if (false) {",
  ],
  "runtime-consumed-precedence": [
    "} else if (input.consumedAt) {",
    "} else if (false) {",
  ],
  "no-sse-gate": [
    "} else if (liveSseConnections === 0) {",
    "} else if (false) {",
  ],
  "cross-network-sse": [
    'const liveSseConnections = getSSEStats().sessions[`${taskNetworkId || "global"}:${targetAlias}`] ?? 0;',
    'const liveSseConnections = Object.entries(getSSEStats().sessions).filter(([key]) => key.endsWith(`:${targetAlias}`)).reduce((sum, [, count]) => sum + count, 0);',
  ],
};

const pair = mutations[mode];
if (!pair) throw new Error(`unknown mutation mode: ${mode}`);
const source = readFileSync(path, "utf8");
const [anchor, replacement] = pair;
if (source.split(anchor).length - 1 !== 1) {
  throw new Error(`expected exactly one ${mode} anchor`);
}
const mutated = source.replace(anchor, replacement);
if (mutated === source) throw new Error(`${mode} mutation was byte-identical`);
writeFileSync(path, mutated);
