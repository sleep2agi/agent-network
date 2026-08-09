import { existsSync, writeFileSync } from "node:fs";

const [dbPath, scheduleId, scheduledFor, readyPath, gatePath] = Bun.argv.slice(2);
if (![dbPath, scheduleId, scheduledFor, readyPath, gatePath].every(Boolean)) process.exit(10);
process.env.COMMHUB_DB = dbPath;

const { db } = await import("../../server/src/db.js");
const { dispatchScheduledOccurrence } = await import("../../server/src/scheduled-tasks.js");
const row = db.get("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId);
if (!row) process.exit(11);

writeFileSync(readyPath, "ready\n", { mode: 0o600 });
const deadline = Date.now() + 10_000;
while (!existsSync(gatePath) && Date.now() < deadline) await Bun.sleep(5);
if (!existsSync(gatePath)) process.exit(12);

try {
  dispatchScheduledOccurrence(row as any, scheduledFor, true);
  process.exit(0);
} catch (error: any) {
  if (/UNIQUE|duplicate key/i.test(String(error?.message || error))) process.exit(3);
  console.error(error);
  process.exit(4);
}
