import { pathToFileURL } from "node:url";

const modulePath = process.env.DB_ADAPTER_MODULE || "/work/server/src/db-adapter.ts";
try {
  const mod = await import(pathToFileURL(modulePath).href);
  mod.createAdapter();
  console.log("UNEXPECTED_NO_THROW");
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
