import { describe, expect, test } from "bun:test";
import { decideDashboardListener, isDashboardProcessCommand, parseDashboardLaunchRecord } from "./dashboard-managed-process";

const record = {
  schema: 1 as const,
  port: 3109,
  listener_pid: 4242,
  listener_birth: "birth-1",
  source: "npx" as const,
  source_key: "npx:0.6.0",
  recorded_at: "2026-08-10T00:00:00.000Z",
};

const base = {
  port: 3109,
  listenerPids: [4242],
  record,
  listenerBirth: "birth-1",
  listenerCommand: "node /tmp/.npm/_npx/x/node_modules/@sleep2agi/agent-network-dashboard/node_modules/next/dist/bin/next start",
  desiredSource: "npx" as const,
  desiredSourceKey: "npx:0.6.0",
  healthy: true,
};

describe("managed Dashboard listener decisions", () => {
  test("empty port starts; same healthy managed release remains untouched", () => {
    expect(decideDashboardListener({ ...base, listenerPids: [] })).toEqual({ action: "start" });
    expect(decideDashboardListener(base)).toEqual({ action: "already_running", pid: 4242 });
  });

  test("only an exact managed stale npx listener may be terminated", () => {
    expect(decideDashboardListener({ ...base, desiredSourceKey: "npx:0.6.1" })).toEqual({
      action: "terminate_owned_stale", pid: 4242, reason: "version_changed",
    });
    expect(decideDashboardListener({ ...base, healthy: false })).toEqual({
      action: "terminate_owned_stale", pid: 4242, reason: "unhealthy",
    });
  });

  test("unmanaged, ambiguous, reused, foreign, and global listeners fail closed", () => {
    for (const candidate of [
      { ...base, record: null },
      { ...base, listenerPids: [4242, 4243] },
      { ...base, listenerBirth: "reused-pid" },
      { ...base, listenerCommand: "node /srv/unrelated/next-server" },
      { ...base, record: { ...record, source: "global" as const, source_key: "global:/usr/bin/dashboard" } },
    ]) expect(decideDashboardListener(candidate).action).toBe("refuse");
  });
});

test("record parser and command identity reject malformed state", () => {
  expect(parseDashboardLaunchRecord(record)).toEqual(record);
  expect(parseDashboardLaunchRecord({ ...record, listener_pid: "4242" })).toBeNull();
  expect(isDashboardProcessCommand("node /x/@sleep2agi/agent-network-dashboard/bin/start.js")).toBeTrue();
  expect(isDashboardProcessCommand("node /x/agent-network-dashboard/server.js")).toBeTrue();
  expect(isDashboardProcessCommand("node /x/agent-network-dashboard-evil/server.js")).toBeFalse();
  expect(isDashboardProcessCommand("next-server")).toBeTrue();
  expect(isDashboardProcessCommand("node /srv/unrelated/server.js")).toBeFalse();
});
