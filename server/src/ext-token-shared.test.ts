import { describe, expect, test } from "bun:test";
import {
  buildStoragePath,
  pathForExistingBlob,
  validateIndexEntry,
} from "./uploads.js";

const fileId = "0123456789abcdef0123456789abcdef";
const dateBucket = "2026-08-09";
const uploadsRoot = "/srv/uploads";

const malicious = [
  "../x",
  "/abs/x",
  ".png/../../y",
  ".p ng",
  ".p\0ng",
  ".\\..\\x",
  "." + "a".repeat(17),
  ".tar.gz",
];

const legal = ["", ".png", ".PNG", ".mp4", "." + "a".repeat(16)];

describe("#527 shared extension-token invariant", () => {
  test("new-upload path rejects every malformed token and accepts the shared legal set", () => {
    for (const ext of malicious) {
      expect(() => buildStoragePath(fileId, ext, { uploadsRoot })).toThrow(/ext .* is invalid/);
    }
    for (const ext of legal) {
      expect(buildStoragePath(fileId, ext, { uploadsRoot }).ext).toBe(ext);
    }
  });

  test("existing-blob path rejects every malformed token and accepts the shared legal set", () => {
    for (const ext of malicious) {
      expect(() => pathForExistingBlob(dateBucket, fileId, ext, { uploadsRoot })).toThrow(/ext .* is invalid/);
    }
    for (const ext of legal) {
      expect(pathForExistingBlob(dateBucket, fileId, ext, { uploadsRoot }).ext).toBe(ext);
    }
  });

  test("stored-index gate rejects every malformed token and accepts the shared legal set", () => {
    for (const ext of malicious) {
      expect(validateIndexEntry({ file_id: fileId, date_bucket: dateBucket, ext, size: 0 })).toBe(false);
    }
    for (const ext of legal) {
      expect(validateIndexEntry({ file_id: fileId, date_bucket: dateBucket, ext, size: 0 })).toBe(true);
    }
  });

  test("all three boundaries fail closed on non-string runtime values", () => {
    for (const ext of [undefined, null, 7, {}, []]) {
      expect(() => buildStoragePath(fileId, ext as never, { uploadsRoot })).toThrow(/ext .* is invalid/);
      expect(() => pathForExistingBlob(dateBucket, fileId, ext as never, { uploadsRoot })).toThrow(/ext .* is invalid/);
      expect(validateIndexEntry({ file_id: fileId, date_bucket: dateBucket, ext, size: 0 })).toBe(false);
    }
  });
});
