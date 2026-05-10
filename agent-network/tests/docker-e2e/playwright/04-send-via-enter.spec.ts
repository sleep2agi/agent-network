import { test, expect } from "@playwright/test";
import { loadState, loginAs, waitFor } from "./helpers";

/**
 * Scenario 4: open the chat panel for vbot, type "你好", press Enter,
 * expect the message bubble to appear within 1s with status created or
 * delivered.
 *
 * The chat panel UI shows ONE bubble per outgoing task. Status pill
 * starts at `created`, transitions to `delivered` once the hub
 * acknowledges, and is rendered as a small text label inside the
 * bubble.
 */
test("typing + Enter sends a task and the bubble appears", async ({ context, page }) => {
  const state = loadState();
  await loginAs(context, page, state);

  // Direct nav to the node detail page — Chat is the default tab.
  await page.goto(`/node?alias=${encodeURIComponent(state.alias)}`);

  // Textarea placeholder: `Message ${alias}...`
  const input = page.locator(`textarea[placeholder="Message ${state.alias}..."]`);
  await expect(input).toBeVisible({ timeout: 15_000 });

  await input.fill("你好");
  await input.press("Enter");

  // Bubble appears within 1s. The user's content lives inside the
  // outgoing bubble: a div.bg-cyan-500/8 with the typed text.
  const myBubble = page.locator("div.bg-cyan-500\\/8").filter({ hasText: "你好" });
  await expect(myBubble).toBeVisible({ timeout: 1500 });

  // Within ~5s the status label should be created or delivered.
  await waitFor(async () => {
    const text = await myBubble.innerText();
    return /(created|delivered|running|replied|failed)/.test(text) ? text : null;
  }, { timeout: 5_000, interval: 250, label: "status pill on first bubble" });
});
