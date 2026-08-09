import { test, expect } from "@playwright/test";
import { loadState, HUB_URL } from "./helpers";

/**
 * Scenario 2: API-driven node-token creation.
 *
 * GAP DOCUMENTED: the `anet` CLI's `node create` command runs an
 * interactive two-step picker (network select + alias prompt) that
 * cannot be driven from inside a non-tty docker container. So instead
 * we exercise the underlying REST API the CLI calls — `POST
 * /api/auth/node-token` — which is exactly what real users get
 * delegated to (and what the dashboard "create node" UI uses too).
 *
 * Acceptance: the hub mints a fresh ntok_ when given a valid utok_ +
 * network_id + node_name, and the resulting token is usable for SSE.
 */
test("POST /api/auth/node-token mints a valid ntok_", async () => {
  const state = loadState();
  const nodeName = `apinode_${Date.now()}`;

  const res = await fetch(`${HUB_URL}/api/auth/node-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${state.utok}`,
    },
    body: JSON.stringify({
      network_id: state.network_id,
      node_name: nodeName,
    }),
  });
  expect(res.ok, `expected 200, got ${res.status}`).toBe(true);
  const data = await res.json();
  expect(data.ok).toBe(true);
  expect(data.token).toMatch(/^ntok_/);

  // Verify the token resolves on /api/auth/me — the hub recognizes it.
  const meRes = await fetch(`${HUB_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${data.token}` },
  });
  expect(meRes.ok).toBe(true);
  const me = await meRes.json();
  expect(me.ok).toBe(true);
  expect(me.current_network).toBe(state.network_id);
});
