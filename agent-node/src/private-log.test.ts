import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialRedactor } from "./credential-redaction";
import { appendPrivateLogLine, preparePrivateLogDirectory } from "./private-log";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "private-log-"));
  roots.push(root);
  return root;
}

describe("Grok preview private ordinary logs", () => {
  test("scrubs and repairs legacy logs before appending through a 0600 file", () => {
    const root = fixture();
    const directory = join(root, "logs");
    const marker = "PRIVATE_LOG_CANARY_7f52";
    mkdirSync(directory, { mode: 0o755 });
    const legacy = join(directory, "2026-07-12.log");
    writeFileSync(legacy, `legacy PARTNER_TOKEN=${marker}\n`, { mode: 0o644 });
    chmodSync(legacy, 0o644);
    const redactor = createCredentialRedactor({ knownValues: [marker] });

    expect(preparePrivateLogDirectory(directory, redactor)).toBe(directory);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(legacy).mode & 0o777).toBe(0o600);
    expect(readFileSync(legacy, "utf8")).not.toContain(marker);
    expect(readFileSync(legacy, "utf8")).toContain("[REDACTED_CREDENTIAL]");

    appendPrivateLogLine(directory, "2026-07-13.log", `reply SERVICE_SECRET=${marker}\n`, redactor);
    const current = join(directory, "2026-07-13.log");
    expect(statSync(current).mode & 0o777).toBe(0o600);
    expect(readFileSync(current, "utf8")).not.toContain(marker);
    expect(readFileSync(current, "utf8")).toContain("[REDACTED_CREDENTIAL]");
  });

  test("rejects a symlinked directory or final log file", () => {
    const root = fixture();
    const target = join(root, "target");
    const link = join(root, "logs-link");
    mkdirSync(target);
    symlinkSync(target, link);
    const redactor = createCredentialRedactor();
    expect(() => preparePrivateLogDirectory(link, redactor)).toThrow("owner-controlled");

    const directory = join(root, "logs");
    mkdirSync(directory);
    const outside = join(root, "outside.log");
    writeFileSync(outside, "outside\n", { mode: 0o600 });
    symlinkSync(outside, join(directory, "2026-07-13.log"));
    expect(() => preparePrivateLogDirectory(directory, redactor)).toThrow();
    expect(lstatSync(join(directory, "2026-07-13.log")).isSymbolicLink()).toBe(true);

    const appendDirectory = join(root, "append-logs");
    preparePrivateLogDirectory(appendDirectory, redactor);
    symlinkSync(outside, join(appendDirectory, "2026-07-13.log"));
    expect(() => appendPrivateLogLine(
      appendDirectory,
      "2026-07-13.log",
      "must not follow\n",
      redactor,
    )).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });

  test("rejects a multiply-linked log instead of rewriting another pathname", () => {
    const root = fixture();
    const directory = join(root, "logs");
    mkdirSync(directory);
    const path = join(directory, "2026-07-13.log");
    writeFileSync(path, "line\n", { mode: 0o600 });
    linkSync(path, join(root, "alias.log"));
    expect(() => preparePrivateLogDirectory(directory, createCredentialRedactor())).toThrow(
      "single owner-controlled file",
    );
  });

  test("does not follow a log-directory symlink introduced after preparation", () => {
    const root = fixture();
    const directory = join(root, "logs");
    const original = join(root, "logs-original");
    const redirect = join(root, "redirect");
    const redactor = createCredentialRedactor();
    preparePrivateLogDirectory(directory, redactor);
    renameSync(directory, original);
    mkdirSync(redirect, { mode: 0o700 });
    symlinkSync(redirect, directory);

    expect(() => appendPrivateLogLine(
      directory,
      "2026-07-13.log",
      "must not redirect\n",
      redactor,
    )).toThrow();
    expect(() => statSync(join(redirect, "2026-07-13.log"))).toThrow();
  });
});
