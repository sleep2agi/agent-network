import { test, expect } from "@playwright/test";
import { loadState, loginAs, waitFor } from "./helpers";

/**
 * Scenario 6: chat history must persist across a hard browser refresh.
 *
 * Send a fresh message → wait for the agent's failed reply → reload →
 * expect to see *both* the user-typed text and the agent's reply still
 * on screen.
 *
 * The agent's failed reply contains "错误" (Chinese for "error") — same
 * predicate as scenario 5.
 */
test("hard refresh re-loads chat history (user msg + agent reply)", async ({ context, page }) => {
  const state = loadState();
  await loginAs(context, page, state);

  await page.goto(`/node?alias=${encodeURIComponent(state.alias)}`);

  const input = page.locator(`textarea[placeholder="Message ${state.alias}..."]`);
  await expect(input).toBeVisible({ timeout: 15_000 });

  const messageText = `e2e-refresh-${Date.now()}`;
  await input.fill(messageText);
  await input.press("Enter");

  // Wait for the agent reply to land (so we have a complete pair).
  await waitFor(async () => {
    const txt = await page.locator("body").innerText();
    return txt.includes(messageText) && /(错误|error)/i.test(txt) ? true : null;
  }, { timeout: 60_000, interval: 1000, label: "user msg + agent error reply both visible" });

  // Hard refresh (full reload, no SPA route).
  await page.reload({ waitUntil: "load" });

  // Re-assert: textarea visible, both pieces of content still rendered.
  await expect(page.locator(`textarea[placeholder="Message ${state.alias}..."]`)).toBeVisible({ timeout: 15_000 });

  await waitFor(async () => {
    const txt = await page.locator("body").innerText();
    return txt.includes(messageText) && /(错误|error)/i.test(txt) ? true : null;
  }, { timeout: 15_000, interval: 500, label: "history reloaded after refresh" });
});
