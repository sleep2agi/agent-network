import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function isPrivateEmptyRegularFile(metadata) {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.uid === expectedUid
    && metadata.nlink === 1
    && (metadata.mode & 0o777) === 0o600
    && metadata.size === 0;
}

// The optional temporaryDirectory exists only so the negative test can prove
// that rename(2) fails closed across filesystems. The CLI never accepts it.
export function createPrivateReport(report, { temporaryDirectory } = {}) {
  if (typeof report !== "string" || report.length === 0 || report.includes("\0")) {
    throw new TypeError("invalid report path");
  }

  const reportDirectory = dirname(report);
  const stagingDirectory = temporaryDirectory ?? reportDirectory;
  mkdirSync(reportDirectory, { recursive: true });

  const temporary = join(
    stagingDirectory,
    `.test225-report.${process.pid}.${randomBytes(12).toString("hex")}`,
  );
  let temporaryExists = false;
  try {
    const descriptor = openSync(
      temporary,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryExists = true;
    try {
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }

    // Node's renameSync maps directly to rename(2): unlike `mv`, it never
    // falls back to copy+unlink when source and destination are on different
    // filesystems.
    renameSync(temporary, report);
    temporaryExists = false;

    if (!isPrivateEmptyRegularFile(lstatSync(report))) {
      throw new Error("private report postcondition failed");
    }
  } catch (error) {
    if (temporaryExists) {
      rmSync(temporary, { force: true });
    }
    throw error;
  }
}

const invokedAsScript = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) {
  try {
    if (process.argv.length !== 3) throw new TypeError("expected one report path");
    createPrivateReport(process.argv[2]);
  } catch {
    process.exitCode = 1;
  }
}
