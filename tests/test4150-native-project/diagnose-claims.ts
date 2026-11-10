// Disposable-container diagnosis only. Never logs arbitrary native stderr/errors.
import { readFileSync, writeFileSync } from "node:fs";
const path = "agent-node/src/runtime/session-source-evidence.ts";
const needle = 'catch { return null; }\n      finally { sourceExecutions.delete(key); }';
const text = readFileSync(path, "utf8");
if (!text.includes(needle)) throw Error("diagnostic_overlay_drift");
writeFileSync(path, text.replace(needle,
  'catch (e) { console.error("CONTROLLED_DELIVERY_REFUSAL", e instanceof Error && /^source_[a-z_]+$/.test(e.message) ? e.message : "redacted"); return null; }\n      finally { sourceExecutions.delete(key); }'));
const child = Bun.spawn([process.execPath, "test", "server/src/session-source-evidence.test.ts"], { stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
