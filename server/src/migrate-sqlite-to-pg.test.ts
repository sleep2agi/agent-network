import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrateRefused, migrateSqliteToPg } from "./migrate-sqlite-to-pg";

// Only the refusals that happen before any connection is attempted; the full
// copy runs against a real PostgreSQL in test2123 (migrate-stage.sh).
const home = mkdtempSync(join(tmpdir(), "anet-migrate-home-"));
const commhub = join(home, ".commhub");
mkdirSync(commhub);
writeFileSync(join(commhub, "commhub.db"), "");
const elsewhere = join(home, "copies");
mkdirSync(elsewhere);
symlinkSync(join(commhub, "commhub.db"), join(elsewhere, "link.db"));
const PG = "postgres://user:s3cret@127.0.0.1:1/anet_never_test";

afterAll(() => rmSync(home, { recursive: true, force: true }));

async function refusal(opts: Parameters<typeof migrateSqliteToPg>[0]): Promise<string> {
  try {
    await migrateSqliteToPg({ ...opts, home, log: () => {} });
  } catch (e) {
    expect(e).toBeInstanceOf(MigrateRefused);
    return String((e as Error).message);
  }
  throw new Error("expected a refusal");
}

describe("RFC-039 S5 migrate-to-pg refusals", () => {
  test("target must be a postgres URL", async () => {
    expect(await refusal({ from: join(elsewhere, "x.db"), to: "mysql://h/db" })).toContain("--to must be a postgres");
  });

  test("missing source", async () => {
    expect(await refusal({ from: join(elsewhere, "missing.db"), to: PG })).toContain("does not exist");
  });

  test("the live Hub directory ~/.commhub is refused, also through a symlink", async () => {
    for (const from of [join(commhub, "commhub.db"), join(elsewhere, "link.db")]) {
      const message = await refusal({ from, to: PG });
      expect(message).toContain("live Hub's directory");
      expect(message).toContain("--i-know-this-is-a-copy");
      expect(message).not.toContain("s3cret");
    }
  });
});
