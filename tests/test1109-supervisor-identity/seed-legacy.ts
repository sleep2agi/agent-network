// Fixture only: retain the historical nullable sessions.network_id shape.
// Fresh production schema stays NOT NULL; no product migration is changed.
import { createAdapter } from "../../server/src/db-adapter.js";
if (!await Bun.file("/.dockerenv").exists()) throw Error("container only");
if (process.env.NODE_ENV !== "test" || !process.env.COMMHUB_DB?.startsWith("/tmp/supervisor1109.")) throw Error("private fixture only");
const text = await Bun.file("/work/server/src/db.ts").text();
const ddl = text.match(/CREATE TABLE IF NOT EXISTS sessions \([\s\S]*?\n  \);/)?.[0];
if (!ddl) throw Error("sessions schema anchor missing");
const legacy = ddl.replace(/network_id(\s+)TEXT NOT NULL DEFAULT 'default'/, "network_id$1TEXT DEFAULT 'default'");
if (legacy === ddl) throw Error("sessions nullability anchor missing");
const adapter = createAdapter();
try { adapter.exec(legacy); } finally { adapter.close(); }
