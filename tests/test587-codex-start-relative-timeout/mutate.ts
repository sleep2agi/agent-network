import { readFileSync, writeFileSync } from "node:fs";

const mutation = process.argv[2];
const runtimePath = "./src/runtime/codex-app-server/runtime.ts";
const bridgePath = "./src/runtime/codex-app-server-bridge.ts";

function replaceExact(path: string, before: string, after: string): void {
  const source = readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${mutation}: expected one anchor in ${path}, found ${count}`);
  writeFileSync(path, source.replace(before, after));
}

switch (mutation) {
  case "timer_at_submission":
    replaceExact(
      runtimePath,
      `    bridge.on("task_started", onStarted);`,
      `    bridge.on("task_started", onStarted);\n    startResponseTimer();`,
    );
    break;
  case "ignore_started_event":
    replaceExact(
      runtimePath,
      `      startResponseTimer();\n    };\n\n    // A shared app-server WebSocket`,
      `      void ev;\n    };\n\n    // A shared app-server WebSocket`,
    );
    break;
  case "wrong_task_arms_timer":
    replaceExact(
      runtimePath,
      `    const onStarted = (ev: { taskId: string; turnId: string; steered?: boolean }) => {\n      if (ev.taskId !== opts.taskId) return;`,
      `    const onStarted = (ev: { taskId: string; turnId: string; steered?: boolean }) => {\n      if (false && ev.taskId !== opts.taskId) return;`,
    );
    break;
  case "omit_bridge_started_event":
    replaceExact(
      bridgePath,
      `    this.emit("task_started", { taskId: input.taskId, turnId, steered: false });`,
      `    void turnId;`,
    );
    break;
  case "omit_steer_started_event":
    replaceExact(
      bridgePath,
      `      this.emit("task_started", {\n        taskId: input.taskId,\n        turnId: expectedTurnId,\n        steered: true,\n      });`,
      `      void expectedTurnId;`,
    );
    break;
  default:
    throw new Error(`unknown mutation: ${mutation}`);
}
