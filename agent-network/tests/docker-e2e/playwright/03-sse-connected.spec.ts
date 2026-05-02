import { test, expect } from "@playwright/test";
import { loadState, hubGet, waitFor } from "./helpers";

/**
 * Scenario 3: agent-node SSE connectivity.
 *
 * The agent-node container was started by run-e2e.sh after the ntok_
 * config was written. It calls `report_status` over the MCP transport
 * and opens an SSE connection to /events/vbot. This test simply
 * polls /api/status and asserts the hub sees vbot as non-offline.
 */
test("agent-node 'vbot' reports online via /api/status", async () => {
  const state = loadState();

  const session = await waitFor(
    async () => {
      const data = await hubGet(state, "/api/status");
      const sessions: any[] = data.sessions || [];
      return sessions.find((s) => s.alias === state.alias && s.status !== "offline") || null;
    },
    { timeout: 45_000, interval: 1000, label: "vbot online in /api/status" },
  );

  expect(session.alias).toBe(state.alias);
  expect(["idle", "working", "online"]).toContain(session.status);
});
