import { test, expect } from "@playwright/test";
import { loadState, loginAs, waitFor } from "./helpers";

/**
 * Scenario 7: send 3 messages back-to-back via Enter and verify they
 * all appear in order.
 *
 * The dashboard appends each outgoing bubble as a div.bg-cyan-500/8;
 * the test just looks for our 3 unique markers and checks DOM order
 * via Locator.nth().
 */
test("3 rapid messages all appear in order", async ({ context, page }) => {
  const state = loadState();
  await loginAs(context, page, state);

  await page.goto(`/node?alias=${encodeURIComponent(state.alias)}`);

  const input = page.locator(`textarea[placeholder="Message ${state.alias}..."]`);
  await expect(input).toBeVisible({ timeout: 15_000 });

  const stamp = Date.now();
  const msgs = [
    `e2e-multi-A-${stamp}`,
    `e2e-multi-B-${stamp}`,
    `e2e-multi-C-${stamp}`,
  ];

  for (const m of msgs) {
    // Wait until input is empty (cleared by previous send) before typing again.
    await waitFor(async () => ((await input.inputValue()) === "") ? true : null, { timeout: 5_000, label: "input cleared" });
    await input.fill(m);
    await input.press("Enter");
  }

  // All 3 markers visible within 5s.
  await waitFor(async () => {
    const txt = await page.locator("body").innerText();
    return msgs.every((m) => txt.includes(m)) ? true : null;
  }, { timeout: 5_000, interval: 250, label: "all 3 messages present" });

  // Order check: index of A < index of B < index of C in body text.
  const body = await page.locator("body").innerText();
  const positions = msgs.map((m) => body.indexOf(m));
  expect(positions[0]).toBeLessThan(positions[1]);
  expect(positions[1]).toBeLessThan(positions[2]);
});
