import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const cli = readFileSync(join(root, "agent-node/src/cli.ts"), "utf8");
const networkCli = readFileSync(join(root, "agent-network/bin/cli.ts"), "utf8");

describe("owner schedule process wiring", () => {
  test("capability is pinned from config once and never exposed as a model tool", () => {
    expect(cli).toContain("const OWNER_SCHEDULE_CONTROL_ENABLED = fileConfig.flags?.ownerScheduleControl === true;");
    expect(cli).toContain("enabled: OWNER_SCHEDULE_CONTROL_ENABLED");
    expect(cli).toContain("ownerScheduleConsumer?.stop()");
    expect(cli).not.toContain('name: "apply_owner_schedule"');
    expect(cli).not.toContain('name: "edit_external_schedule"');
  });

  test("SSE is only a doorbell and snapshots are editable only under the same gate", () => {
    expect(cli).toContain('if (ev.type === "external_schedule_edit")');
    expect(cli).toContain("void ownerScheduleConsumer?.trigger()");
    expect(cli).toContain("ownerControlEnabled: OWNER_SCHEDULE_CONTROL_ENABLED");
    expect(cli).toContain("ownerNodeId: NODE_ID || undefined");
    expect((cli.match(/ownerControlEnabled: OWNER_SCHEDULE_CONTROL_ENABLED/g) ?? []).length).toBe(2);
  });

  test("new token mint paths bind the immutable node id and opt-in is explicit", () => {
    expect(networkCli).toContain('opts["owner-schedule-control"] === "true"');
    expect(networkCli).toContain("node_id: profile.node_id");
    expect(networkCli).toContain("node_id: raw.node_id");
    expect(networkCli).toContain("node_id: p.node_id");
    expect((networkCli.match(/\/api\/auth\/node-token/g) ?? []).length).toBe(4);
    expect((networkCli.match(/node_id: /g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
