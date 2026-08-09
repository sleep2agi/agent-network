import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

test("processInbox logs skipped messages at INFO before acknowledging", () => {
  const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  expect(source).toContain('import { formatInboxSkipLog } from "./inbox-skip-log";');
  expect(source).toContain("log(formatInboxSkipLog({");
  expect(source).not.toContain("debug(`skip message from ${from}: ${skip}`)");

  const logIndex = source.indexOf("log(formatInboxSkipLog({");
  const ackIndex = source.indexOf("ackMessage(msg.id)", logIndex);
  expect(logIndex).toBeGreaterThan(-1);
  expect(ackIndex).toBeGreaterThan(logIndex);
});
