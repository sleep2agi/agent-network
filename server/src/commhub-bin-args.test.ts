import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// commhub-server must refuse what it does not understand instead of starting a
// Hub on the defaults (the live ~/.commhub/commhub.db). Every child gets a
// throwaway HOME and a throwaway PORT, so even a regression binds nothing real.
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "commhub.ts");
const PKG_VERSION = JSON.parse(readFileSync(join(dirname(BIN), "..", "package.json"), "utf8")).version as string;
const home = mkdtempSync(join(tmpdir(), "anet-bin-args-"));
const PORT = String(26000 + Math.floor(Math.random() * 3000));

afterAll(() => rmSync(home, { recursive: true, force: true }));

function run(args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 15_000) {
  const proc = Bun.spawnSync(["bun", BIN, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, PORT, HOST: "127.0.0.1", ...extraEnv },
    stdout: "pipe", stderr: "pipe", timeout: timeoutMs,
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

async function listening(port: string): Promise<boolean> {
  try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
}

describe("commhub-server argument handling", () => {
  for (const [args, message] of [
    [["bogus"], "unknown command bogus"],
    [["--port=29999"], "unknown option --port=29999"],
    [["--bogus-flag"], "unknown option --bogus-flag"],
    [["--port"], "--port needs a value"],
    [["--db", "--dev-open"], "--db needs a value"],
  ] as const) {
    test(`${args.join(" ")} → exit 2, no database, nothing listening`, async () => {
      const r = run([...args]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.stderr).toContain("commhub-server --help");
      expect(existsSync(join(home, ".commhub"))).toBe(false);
      expect(await listening(PORT)).toBe(false);
    });
  }

  test("migrate-to-pg with missing or unknown arguments exits 2 and starts nothing", async () => {
    const missing = run(["migrate-to-pg", "--from", "/x.db"]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain("commhub-server migrate-to-pg --from <sqlite file> --to <postgres url>");
    const unknown = run(["migrate-to-pg", "--from", "/x.db", "--to", "postgres://u@127.0.0.1/anet_x_test", "--bogus"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown argument --bogus");
    expect(existsSync(join(home, ".commhub"))).toBe(false);
    expect(await listening(PORT)).toBe(false);
  });

  test("--help and --version exit 0 without starting", async () => {
    const help = run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--port, -p <port>");
    const version = run(["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toBe(PKG_VERSION);
    expect(existsSync(join(home, ".commhub"))).toBe(false);
  });

  test("the known forms still start a Hub", async () => {
    const db = join(home, "known.db");
    const port = String(Number(PORT) + 1);
    const child = Bun.spawn(["bun", BIN, "--port", port, "--host", "127.0.0.1", "--db", db, "--dev-open"], {
      env: { PATH: process.env.PATH ?? "", HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) { up = await listening(port); if (!up) await Bun.sleep(100); }
      expect(up).toBe(true);
      expect(existsSync(db)).toBe(true);
      expect(existsSync(join(home, ".commhub", "commhub.db"))).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);
});
