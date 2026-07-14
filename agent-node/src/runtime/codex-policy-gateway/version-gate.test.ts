import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_BINARY_IDENTITY_MISMATCH,
} from "./codex-binary";
import { PINNED_CODEX_VERSION_LINE } from "./pinned";
import {
  BASELINE_MISMATCH_CODE,
  assertCodexBaseline,
} from "./version-gate";

describe("assertCodexBaseline canonical identity fence", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("revalidates identity after the version execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "version-gate-identity-RAW_PATH-"));
    dirs.push(dir);
    const binary = join(dir, "codex-changing");
    writeFileSync(
      binary,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  mv "$0" "$0.original"
  printf '#!/bin/sh\\nexit 9\\n' > "$0"
  chmod 755 "$0"
  printf '%s\\n' '${PINNED_CODEX_VERSION_LINE}'
  printf '%s\\n' 'RAW_VERSION_STDERR' >&2
  exit 0
fi
exit 4
`,
      { mode: 0o755 },
    );
    chmodSync(binary, 0o755);

    let observed: Error | null = null;
    try {
      await assertCodexBaseline(binary, { env: { PATH: process.env.PATH } });
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      CODEX_BINARY_IDENTITY_MISMATCH,
    );
    expect(observed?.message).toBe(CODEX_BINARY_IDENTITY_MISMATCH);
    expect(observed?.message).not.toContain(dir);
    expect(observed?.message).not.toContain("RAW_VERSION_STDERR");
  });

  test("revalidates identity after the schema execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-gate-identity-RAW_PATH-"));
    dirs.push(dir);
    const binary = join(dir, "codex-changing-during-schema");
    writeFileSync(
      binary,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '${PINNED_CODEX_VERSION_LINE}'
  exit 0
fi
if [ "$1" = "app-server" ]; then
  out="$4"
  mkdir -p "$out"
  printf '{}\\n' > "$out/generated.json"
  mv "$0" "$0.original"
  printf '#!/bin/sh\\nexit 9\\n' > "$0"
  chmod 755 "$0"
  printf '%s\\n' 'RAW_SCHEMA_STDERR' >&2
  exit 0
fi
exit 4
`,
      { mode: 0o755 },
    );
    chmodSync(binary, 0o755);

    let observed: Error | null = null;
    try {
      await assertCodexBaseline(binary, { env: { PATH: process.env.PATH } });
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      CODEX_BINARY_IDENTITY_MISMATCH,
    );
    expect(observed?.message).toBe(CODEX_BINARY_IDENTITY_MISMATCH);
    expect(observed?.message).not.toContain(dir);
    expect(observed?.message).not.toContain("RAW_SCHEMA_STDERR");
  });

  test("wrong version and raw command output collapse to the stable baseline error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "version-gate-raw-RAW_PATH-"));
    dirs.push(dir);
    const binary = join(dir, "codex-wrong-version");
    writeFileSync(
      binary,
      "#!/bin/sh\nprintf '%s\\n' 'RAW_WRONG_VERSION'\nprintf '%s\\n' 'RAW_STDERR' >&2\n",
      { mode: 0o755 },
    );
    chmodSync(binary, 0o755);

    let observed: Error | null = null;
    try {
      await assertCodexBaseline(binary, { env: { PATH: process.env.PATH } });
    } catch (error) {
      observed = error as Error;
    }
    expect((observed as (Error & { code?: string }) | null)?.code).toBe(
      BASELINE_MISMATCH_CODE,
    );
    expect(observed?.message).toBe(
      "codex baseline mismatch — refusing to boot the gateway (fail closed)",
    );
    expect(observed?.message).not.toContain(dir);
    expect(observed?.message).not.toContain("RAW_");
  });
});
