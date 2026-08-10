import { db } from "../../server/src/db.js";
import { parseExternalSchedulesManifest } from "../../agent-node/src/external-schedules.js";

const gate = process.argv[2];

if (gate === "owner-anchor") {
  const columns = db.all<{ name: string }>("PRAGMA table_info(nodes)").map((row) => row.name);
  if (!columns.includes("owner_user_id")) throw new Error("RED owner_user_id is absent from nodes");
  process.exit(0);
}

if (gate === "intent-journal") {
  const row = db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_schedule_edits'",
  );
  if (!row) throw new Error("RED external_schedule_edits journal is absent");
  process.exit(0);
}

if (gate === "editable-revision") {
  const snapshot = parseExternalSchedulesManifest(JSON.stringify({
    external_schedules: [{
      id: "news-pull",
      name: "News pull",
      kind: "cron",
      frequency: "0 */6 * * *",
      last_run_at: null,
      last_status: "unknown",
      last_error: null,
      next_run_at: null,
      log_path: null,
      enabled: true,
      editable: true,
      revision: 7,
    }],
  }));
  const row = snapshot.schedules[0] as Record<string, unknown>;
  if (row.editable !== true || row.revision !== 7) {
    throw new Error("RED editable/revision are not present in the external schedule contract");
  }
  process.exit(0);
}

throw new Error(`unknown gate: ${gate}`);

