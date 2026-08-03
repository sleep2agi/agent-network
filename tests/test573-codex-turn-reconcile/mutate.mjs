import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mutation, root] = process.argv.slice(2);
if (!mutation || !root) throw new Error("usage: mutate.mjs <mutation> <agent-node-root>");

function replaceExactlyOnce(relativePath, before, after) {
  const path = join(root, relativePath);
  const source = readFileSync(path, "utf8");
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${mutation}: expected exactly one anchor in ${relativePath}`);
  }
  writeFileSync(path, source.replace(before, after));
  console.log(`MUTATED ${mutation}: ${relativePath}`);
}

if (mutation === "drop-watchdog-start") {
  replaceExactlyOnce(
    "src/runtime/codex-app-server/runtime.ts",
    '    bridge.on("task_error", onError);\n    scheduleReconciliation();\n\n    bridge\n',
    '    bridge.on("task_error", onError);\n\n    bridge\n',
  );
} else if (mutation === "drop-terminal-release") {
  replaceExactlyOnce(
    "src/runtime/codex-app-server-bridge.ts",
    "      const recovered = this.finishOwnedTurn(activeAtStart, {\n",
    "      const recovered = false && this.finishOwnedTurn(activeAtStart, {\n",
  );
} else if (mutation === "accept-interrupted") {
  replaceExactlyOnce(
    "src/runtime/codex-app-server-bridge.ts",
    ': terminal.status === "interrupted"\n          ? "Codex turn was interrupted without an error message"',
    ': false\n          ? "Codex turn was interrupted without an error message"',
  );
} else {
  throw new Error(`unknown mutation: ${mutation}`);
}
