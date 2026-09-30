// RFC-039 §9: does this copy of db-adapter.ts accept a COMMHUB_TEST_PG_URL?
// Pure resolution only — never constructs an adapter or opens a socket.
import { pathToFileURL } from "node:url";

const [modulePath, url] = process.argv.slice(2);
const mod = await import(pathToFileURL(modulePath).href);
try {
  const target = mod.resolveDatabaseTarget({ HOME: "/nonexistent", NODE_ENV: "test", COMMHUB_TEST_PG_URL: url });
  console.log(`ACCEPTED ${target.kind}`);
} catch (error) {
  console.log(`REFUSED ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
}
