import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("#379 create and migrate both use platform-aware secret guidance", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = readFileSync(join(here, "..", "bin", "cli.ts"), "utf8");
  expect(cli).toContain('from "../src/secret-shell-guidance"');
  expect(cli.match(/secretPersistenceHeading\(process\.platform\)/g)?.length).toBe(2);
  expect(cli.match(/formatSecretLoadCommand\(process\.platform/g)?.length).toBe(2);
  // #516 — the value-printing form must not come back at either site.
  expect(cli).not.toContain("formatSecretAssignment(process.platform");
  expect(cli).not.toContain("also append to ~/.bashrc / ~/.zshrc");
  expect(cli).not.toContain("Append these to ~/.bashrc / ~/.zshrc");
});
