import { test, expect } from "@playwright/test";
import { loadState, loginAs, hubGet, waitFor } from "./helpers";

/**
 * Scenario 5: the agent-node has a fake MiniMax key + a bogus base URL,
 * so any task it picks up will fail at the LLM call. The agent-node
 * reports `send_reply` with status=failed, which the dashboard renders
 * as a green-bordered "result" bubble underneath the user's message,
 * AND flips the status pill on the user bubble to red "failed".
 *
 * Two ❌ paths exist:
 *   1. Dashboard prefixes "❌" when its OWN /api/hub/send call fails
 *      (e.g. agent offline, network error). That's NOT what we test.
 *   2. The agent's reply text — passed straight through. With our fake
 *      key + bogus base, the agent emits "http 错误: ..." (or "Anthropic
 *      API 错误 …"). The Dashboard renders it verbatim.
 *
 * Acceptance:
 *   1. Within 60s the chat panel shows a result bubble containing the
 *      agent's failure text ("http 错误" or "API 错误").
 *   2. The user bubble's status pill flips to "failed".
 *   3. Hub /api/tasks shows status=failed for the same task_id.
 */
test("agent reply lands as a failed bubble + /api/tasks shows failed", async ({ context, page }) => {
  const state = loadState();
  await loginAs(context, page, state);

  await page.goto(`/node?alias=${encodeURIComponent(state.alias)}`);

  const input = page.locator(`textarea[placeholder="Message ${state.alias}..."]`);
  await expect(input).toBeVisible({ timeout: 15_000 });

  const messageText = `e2e-fail-${Date.now()}`;
  await input.fill(messageText);
  await input.press("Enter");

  // Step 1: agent reply text should land in the chat. The agent emits
  // either "http 错误: ..." or "Anthropic API 错误 ..." depending on
  // whether the bogus base parses as JSON. Either way, the text "错误"
  // (Chinese for "error") appears in the result bubble.
  await waitFor(async () => {
    const txt = await page.locator("body").innerText();
    return txt.includes(messageText) && /(错误|error)/i.test(txt) ? true : null;
  }, { timeout: 60_000, interval: 1000, label: "result bubble with error text" });

  // Step 2: status pill on the user's bubble should now read "failed".
  await waitFor(async () => {
    const txt = await page.locator("body").innerText();
    return txt.includes("failed") ? true : null;
  }, { timeout: 15_000, interval: 500, label: "status pill 'failed' visible" });

  // Step 3: hub /api/tasks should show this task as failed.
  const failedTask = await waitFor(async () => {
    const data = await hubGet(state, `/api/tasks?to_name=${encodeURIComponent(state.alias)}&limit=30`);
    const t: any[] = data.tasks || [];
    return t.find((row) => row.content?.includes(messageText) && row.status === "failed") || null;
  }, { timeout: 30_000, interval: 1000, label: "failed task in /api/tasks" });

  expect(failedTask.status).toBe("failed");
});
