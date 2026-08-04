import { readFileSync, writeFileSync } from "node:fs";

const path = "./src/runtime/codex-app-server-bridge.ts";
const source = readFileSync(path, "utf8");
const mutation = process.argv[2];

function replaceExact(before: string, after: string) {
  const matches = source.split(before).length - 1;
  if (matches !== 1) throw new Error(`${mutation}: expected one anchor, got ${matches}`);
  writeFileSync(path, source.replace(before, after));
}

switch (mutation) {
  case "aggregate_active_shortcut":
    replaceExact(`        forceFullHistory ||\n`, `        false ||\n`);
    break;
  case "wrong_turn_attribution":
    replaceExact(
      `.find((candidate) => candidate.id === activeAtStart);`,
      `.find((candidate) => isTerminalTurnStatus(candidate.status));`,
    );
    break;
  case "missing_turn_fail_open":
    replaceExact(
      `.find((candidate) => candidate.id === activeAtStart);`,
      `.find((candidate) => candidate.id === activeAtStart) ?? { id: activeAtStart, status: "completed", items: [] };`,
    );
    break;
  case "drain_during_successor":
    replaceExact(
      `if (this.turnClaimed || this.activeTurnId || this.externalActiveTurnId) return;`,
      `if (this.turnClaimed || this.activeTurnId) return;`,
    );
    break;
  default:
    throw new Error(`unknown mutation: ${mutation}`);
}
