import { readFileSync, writeFileSync } from "node:fs";

const mutation = process.argv[2];
const managerPath = "./src/runtime/codex-app-server/session-manager.ts";
const cliPath = "./src/cli.ts";

function replaceExact(path: string, before: string, after: string) {
  const source = readFileSync(path, "utf8");
  const matches = source.split(before).length - 1;
  if (matches !== 1) throw new Error(`${mutation}: expected one anchor in ${path}, got ${matches}`);
  writeFileSync(path, source.replace(before, after));
}

switch (mutation) {
  case "bypass_singleflight":
    replaceExact(
      managerPath,
      "const opening = createSingleFlight<T>();",
      "const opening = { run: (factory: () => Promise<T>) => factory(), pending: () => null as Promise<T> | null };",
    );
    break;
  case "bypass_cli_wiring":
    replaceExact(
      cliPath,
      "codexAppServerSessionManager.getOrOpen(async () =>",
      "codexAppServerSessionManager_BYPASSED(async () =>",
    );
    break;
  case "publish_dead_session":
    replaceExact(managerPath, "if (!opened.isRunning) {", "if (false) {");
    break;
  case "stale_exit_clears_new":
    replaceExact(managerPath, "if (!session || current === session) current = null;", "current = null;");
    break;
  default:
    throw new Error(`unknown mutation: ${mutation}`);
}
