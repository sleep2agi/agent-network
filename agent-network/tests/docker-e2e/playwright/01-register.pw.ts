import { test, expect } from "@playwright/test";
import { loadState } from "./helpers";

/**
 * Scenario 1: register an admin via the dashboard UI.
 *
 * run-e2e.sh has already registered admin/anethub via curl (so we have
 * the utok_ + ntok_ for downstream tests). This test exercises the UI
 * register flow with a *different* username so we don't collide with the
 * primary admin row.
 *
 * Acceptance: form submits, redirect lands on `/`, and the nodes page
 * is reachable (i.e. the user is authenticated).
 */
test("ui register flow lands user on the dashboard", async ({ page }) => {
  // Load state to confirm hub is reachable (sanity).
  const state = loadState();
  expect(state.utok).toMatch(/^utok_/);

  const u = `e2euser_${Date.now()}`;
  const p = "e2epass123";

  await page.goto("/login");
  await expect(page.locator("h1")).toHaveText("Agent Network");

  // Switch to register tab.
  await page.getByRole("button", { name: "Register" }).click();

  await page.locator("#username").fill(u);
  await page.locator("#password").fill(p);

  // Submit + wait for the redirect away from /login.
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 }),
    page.getByRole("button", { name: "Create account" }).click(),
  ]);

  // Land on root → should now be authed; navigate to /nodes and confirm.
  await page.goto("/nodes");
  // Heading or empty state — either way, NOT redirected back to /login.
  await expect(page).not.toHaveURL(/\/login/);
  // The nodes page renders the AppShell sidebar which contains a known link.
  // We just assert the title bar of the app is present.
  await expect(page.locator("body")).toContainText(/Nodes|Agent Network|Online|Total/i);
});
