// 🔴 2026-08-19（#1095）：产品把 `startResponseTimer` 改名成 `armResponseIdleTimer`，
//   而且 onStarted 之后的上下文也从 `// A shared app-server WebSocket` 变成了 `const onActivity`。
//   本文件的变异锚点还停在旧名字上 ⇒ replaceExact 命中 0 次 ⇒ 套件红在
//   `expected one anchor ... found 0`。**守卫是对的、红得也准确**，是锚点过期。
//   实测：全仓只剩本文件和另一个套件的 mutate.ts 还在用旧名，产品里 startResponseTimer 出现 0 次。
import { readFileSync, writeFileSync } from "node:fs";

const mutation = process.argv[2];
const runtimePath = "./src/runtime/codex-app-server/runtime.ts";
const bridgePath = "./src/runtime/codex-app-server-bridge.ts";
const cliPath = "./src/cli.ts";

function replaceExact(path: string, before: string, after: string): void {
  const source = readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${mutation}: expected one anchor in ${path}, found ${count}`);
  writeFileSync(path, source.replace(before, after));
}

switch (mutation) {
  case "no_client_index":
    replaceExact(
      bridgePath,
      `    this.pendingByClientUserMessageId.set(clientUserMessageId, pending);`,
      `    void clientUserMessageId;`,
    );
    break;
  case "ignore_user_client_rebind":
    replaceExact(
      bridgePath,
      `      if (byClientId) {`,
      `      if (false && byClientId) {`,
    );
    break;
  case "ignore_history_client_rebind":
    replaceExact(
      bridgePath,
      `        if (clientMatchedTurn?.id) {`,
      `        if (false && clientMatchedTurn?.id) {`,
    );
    break;
  case "keep_stale_response_mapping":
    replaceExact(
      bridgePath,
      `      this.pendingTurns.delete(previousTurnId);`,
      `      void previousTurnId;`,
    );
    break;
  case "trust_phantom_terminal":
    replaceExact(
      bridgePath,
      `      (!pending.identityConfirmed && (pending.competingTurnObserved || terminalNeedsIdentity))`,
      `      false`,
    );
    break;
  case "overwrite_actual_with_response":
    replaceExact(
      bridgePath,
      `    if (!pending.turnId && responseTurnId) {`,
      `    if (responseTurnId) {`,
    );
    break;
  case "timer_at_submission":
    replaceExact(runtimePath, `    bridge.on("task_started", onStarted);`, `    bridge.on("task_started", onStarted);\n    armResponseIdleTimer();`);
    break;
  case "ignore_started_event":
    replaceExact(runtimePath, `      armResponseIdleTimer();\n    };\n    const onActivity`, `      void ev;\n    };\n    const onActivity`);
    break;
  case "identity_defer_unbounded":
    replaceExact(runtimePath, `      armResponseIdleTimer();\n    };\n    const onActivity`, `      void ev;\n    };\n    const onActivity`);
    replaceExact(runtimePath, `        if (r.started) armResponseIdleTimer();`, `        if (false && r.started) armResponseIdleTimer();`);
    break;
  case "wrong_task_arms_timer":
    replaceExact(runtimePath, `    const onStarted = (ev: { taskId: string; turnId: string; steered?: boolean }) => {\n      if (ev.taskId !== opts.taskId) return;`, `    const onStarted = (ev: { taskId: string; turnId: string; steered?: boolean }) => {\n      if (false && ev.taskId !== opts.taskId) return;`);
    break;
  case "omit_bridge_started_event":
    replaceExact(
      bridgePath,
      `    this.emit("task_started", {\n      taskId: pending.taskId,\n      turnId: pending.turnId,\n      steered: false,\n    });`,
      `    void pending;`,
    );
    break;
  case "omit_steer_started_event":
    replaceExact(bridgePath, `      this.emit("task_started", {\n        taskId: input.taskId,\n        turnId: expectedTurnId,\n        steered: true,\n      });`, `      void expectedTurnId;`);
    break;
  case "omit_queue_deadline":
    replaceExact(runtimePath, `    queueTimer = setTimeout(() => {`, `    if (false) queueTimer = setTimeout(() => {`);
    break;
  case "omit_left_fifo_response_fallback":
    replaceExact(
      runtimePath,
      `        log(\`[codex-app-server] queue deadline reached after task left FIFO; arming response timeout for \${opts.taskId}\`);\n        armResponseIdleTimer();\n        return;`,
      `        log(\`[codex-app-server] queue deadline reached after task left FIFO; response timeout omitted by mutation\`);\n        return;`,
    );
    break;
  case "queue_timeout_does_not_cancel":
    replaceExact(runtimePath, `      if (!bridge.cancelQueuedTask(opts.taskId)) {`, `      if (true || !bridge.cancelQueuedTask(opts.taskId)) {`);
    break;
  case "ignore_post_deadline_requeue":
    replaceExact(runtimePath, `    bridge.on("drain_deferred", onRequeued);`, `    void onRequeued;`);
    break;
  case "ignore_post_deadline_steer_requeue":
    replaceExact(runtimePath, `    bridge.on("steer_deferred", onRequeued);`, `    void onRequeued;`);
    break;
  case "cancel_queue_noop":
    replaceExact(bridgePath, `  cancelQueuedTask(taskId: string): boolean {\n    const index = this.taskQueue.findIndex((task) => task.taskId === taskId);`, `  cancelQueuedTask(taskId: string): boolean {\n    return false;\n    const index = this.taskQueue.findIndex((task) => task.taskId === taskId);`);
    break;
  case "failure_returned_as_success":
    replaceExact(cliPath, `  return codexAppServerReplyOrThrow(outcome);`, `  return outcome.replyText || "（无回复）";`);
    break;
  default:
    throw new Error(`unknown mutation: ${mutation}`);
}
