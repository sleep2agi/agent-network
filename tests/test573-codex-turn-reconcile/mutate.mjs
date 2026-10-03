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

// #520: the three anchors below were retargeted after #577 (78763365) reshaped
// both files -- the listener list grew past `task_error`, reconciliation now
// resolves the owned turn through `resolvedTurnId`, and the interrupted-status
// wording also appears in the steered-turn path (emitSteeredTask). Each
// mutation still breaks the same behaviour it was written for in #573.
if (mutation === "drop-watchdog-start") {
  // The per-task reconciliation watchdog is never armed.
  replaceExactlyOnce(
    "src/runtime/codex-app-server/runtime.ts",
    '    bridge.on("steer_deferred", onRequeued);\n    scheduleReconciliation();\n',
    '    bridge.on("steer_deferred", onRequeued);\n',
  );
} else if (mutation === "drop-terminal-release") {
  // thread/read finds the owned turn terminal but never releases the claim.
  replaceExactlyOnce(
    "src/runtime/codex-app-server-bridge.ts",
    "      const recovered = ownedAtStart\n        ? this.finishOwnedTurn(resolvedTurnId, {\n",
    "      const recovered = ownedAtStart\n        ? false && this.finishOwnedTurn(resolvedTurnId, {\n",
  );
} else if (mutation === "accept-interrupted") {
  // An interrupted owned turn is reported as a successful reply. Only the
  // finishOwnedTurn copy is mutated (the network-task path #573 covers); the
  // emitSteeredTask copy belongs to #577's steered human turns.
  replaceExactlyOnce(
    "src/runtime/codex-app-server-bridge.ts",
    '        : terminal.status === "interrupted"\n          ? "Codex turn was interrupted without an error message"\n          : undefined);\n    if (turnErr) {\n',
    '        : false\n          ? "Codex turn was interrupted without an error message"\n          : undefined);\n    if (turnErr) {\n',
  );
} else {
  throw new Error(`unknown mutation: ${mutation}`);
}
