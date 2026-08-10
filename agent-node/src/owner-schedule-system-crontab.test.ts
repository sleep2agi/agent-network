import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { applyOwnerScheduleIntent, finalizeOwnerScheduleIntent, systemCrontabAdapter } from "./owner-schedule-control.js";

afterAll(() => { spawnSync("crontab", ["-r"]); });

describe("owner schedule real crontab adapter", () => {
  test("round-trips an exact managed marker through the container crontab", () => {
    const root = mkdtempSync(join(tmpdir(), "anet-real-crontab-"));
    chmodSync(root, 0o700);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}\n", { mode: 0o600 });
    const tail = " /usr/bin/grok-news --latest";
    const hash = createHash("sha256").update(tail).digest("hex");
    const before = [
      `# ANET-MANAGED-SCHEDULE node_id=n_real_cron id=news-pull revision=3 command_sha256=${hash}`,
      `0 */6 * * *${tail}`,
      "# ANET-MANAGED-SCHEDULE-END node_id=n_real_cron id=news-pull",
      "",
    ].join("\n");
    const adapter = systemCrontabAdapter();
    try {
      adapter.install(before);
      const result = applyOwnerScheduleIntent({
        configPath,
        expectedNodeId: "n_real_cron",
        intent: {
          intent_id: "sei_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          node_id: "n_real_cron",
          schedule_id: "news-pull",
          base_revision: 3,
          patch: { cron: "15 */12 * * *", enabled: false },
        },
      });
      const actual = adapter.read();
      expect(actual).toContain("revision=4");
      expect(actual).toContain(`# ANET-DISABLED 15 */12 * * *${tail}`);
      expect(actual).not.toContain("command=");
      finalizeOwnerScheduleIntent(configPath, result.status === "applied" ? "sei_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" : "");
    } finally {
      spawnSync("crontab", ["-r"]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
