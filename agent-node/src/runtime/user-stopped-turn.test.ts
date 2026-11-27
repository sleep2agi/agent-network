import { expect, test } from "bun:test";
import { OpenCodeProviderError } from "./opencode-provider-error";
import { AcpTurnCancelledError, acpPromptStopReason, UserStoppedTurn } from "./user-stopped-turn";
import { runtimeErrorReplyText } from "./unverified-reply-text";
import { openCodeV2Outcome, openCodeV2TurnVerdict } from "./opencode-copresence/v2-session";
import { codexAppServerReplyOrThrow } from "./codex-app-server/runtime";

const stopped = { ok: true, interrupted: true };
const openCodeAbort = new OpenCodeProviderError({ name: "aborted", message: "Step interrupted" });

test("OpenCode abort waits for the positive stop receipt and becomes a normal reply", async () => {
  const turn = new UserStoppedTurn("task-a");
  let confirm!: (out: typeof stopped) => void;
  const stop = turn.interrupt(() => new Promise(resolve => { confirm = resolve; }));
  const reply = turn.reply(openCodeAbort);
  await Promise.resolve();
  expect(turn.stoppedAt).toBeNull();
  confirm(stopped);
  await stop;
  expect(turn.stoppedAt).toBeNumber();
  expect(await reply).toEqual({ text: "已按要求停止。", failed: false });
});

test("unmarked or rejected stops retain the original OpenCode failure", async () => {
  const turn = new UserStoppedTurn("task-b");
  expect(await turn.reply(openCodeAbort)).toBeNull();
  await turn.interrupt(() => ({ ok: true, interrupted: false }));
  expect(await turn.reply(openCodeAbort)).toBeNull();
  expect(runtimeErrorReplyText("opencode", openCodeAbort)).toContain("模型调用失败");
});

test("Claude AbortError needs a stop for this execution, not a prior execution of the same task", async () => {
  const abort = new DOMException("The operation was aborted", "AbortError");
  const turn = new UserStoppedTurn("task-c");
  await turn.interrupt(() => stopped);
  expect(await turn.reply(abort)).toEqual({ text: "已按要求停止。", failed: false });
  expect(await new UserStoppedTurn(turn.taskId).reply(abort)).toBeNull();
});

test("keeps partial assistant text without mistaking generated error words for a failed reply", async () => {
  const turn = new UserStoppedTurn("task-d");
  await turn.interrupt(() => stopped);
  const verdict = openCodeV2TurnVerdict([
    { type: "assistant", content: [{ type: "text", text: "API error analysis" }], finish: "error", error: { type: "MessageAbortedError", message: "closed" } },
    { type: "idle", outcome: "failed" },
  ]);
  if (verdict.state !== "done") throw new Error("expected a finished turn");
  let caught: unknown;
  try { openCodeV2Outcome(verdict, "msg_1"); } catch (error) { caught = error; }
  expect(await turn.reply(caught))
    .toEqual({ text: "已按要求停止。\n\n停止前已产出：\nAPI error analysis", failed: false });
  expect(await turn.reply(new OpenCodeProviderError({ name: "APIError", message: "bad response" }, "aborted"))).toBeNull();
  expect(await turn.reply(Object.assign(new Error("watchdog aborted"), { name: "TimeoutError" }))).toBeNull();
});

test("structured Codex interruption preserves text only with a confirmed stop", async () => {
  let caught: unknown;
  try {
    codexAppServerReplyOrThrow({ replyText: "codex-app-server 错误: stopped", failed: true, queued: false, interrupted: true, partialReplyText: "partial" });
  } catch (error) { caught = error; }
  const turn = new UserStoppedTurn("codex-task");
  expect(await turn.reply(caught)).toBeNull();
  await turn.interrupt(() => stopped);
  expect(await turn.reply(caught)).toEqual({ text: "已按要求停止。\n\n停止前已产出：\npartial", failed: false });
});

test.each([
  ["Antigravity ACP", { stopReason: "cancelled" }, undefined],
  ["Grok ACP", {}, "cancelled"],
] as const)("%s cancelled outcome needs an own-stop receipt", async (_runtime, response, notification) => {
  expect(acpPromptStopReason(response, notification)).toBe("cancelled");
  const error = new AcpTurnCancelledError("partial ACP text");
  const turn = new UserStoppedTurn("acp-task");
  expect(await turn.reply(error)).toBeNull();
  await turn.interrupt(() => stopped);
  expect(await turn.reply(error)).toEqual({ text: "已按要求停止。\n\n停止前已产出：\npartial ACP text", failed: false });
  expect(acpPromptStopReason({ stopReason: "end_turn" }, "cancelled")).toBe("end_turn");
});

test("an unrelated watchdog or upstream disconnect stays an error even if a stop receipt raced it", async () => {
  const turn = new UserStoppedTurn("transport-task");
  await turn.interrupt(() => stopped);
  expect(await turn.reply(Object.assign(new Error("watchdog aborted request"), { name: "AbortError" }))).toBeNull();
  expect(await turn.reply(Object.assign(new Error("request aborted"), { code: "ECONNRESET" }))).toBeNull();
  expect(await turn.reply(new OpenCodeProviderError({ name: "aborted", message: "upstream connection closed" }))).toBeNull();
});
