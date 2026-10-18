import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENCODE_V2_CATALOG_ENDPOINT_FILE,
  readOpenCodeV2CatalogEndpoint,
  writeOpenCodeV2CatalogEndpoint,
} from "./opencode-v2-catalog-endpoint";

const endpoint = {
  url: "http://127.0.0.1:4096",
  authorization: "Basic fixture",
  directory: "/tmp/oc-catalog-project",
};

test("roundtrip keeps only url, authorization, and directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-endpoint-"));
  try {
    writeOpenCodeV2CatalogEndpoint(dir, endpoint);
    const raw = join(dir, OPENCODE_V2_CATALOG_ENDPOINT_FILE);
    writeFileSync(raw, JSON.stringify({ ...endpoint, version: 1, settings: { apiKey: "sk-FAKE" }, headers: { Authorization: "sk-FAKE" } }), { mode: 0o600 });
    chmodSync(raw, 0o600);
    const read = readOpenCodeV2CatalogEndpoint(dir);
    expect(read).toEqual(endpoint);
    expect(JSON.stringify(read)).not.toContain("sk-FAKE");
    expect(JSON.stringify(read)).not.toContain("settings");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("symlink and loose mode are not a catalog endpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-endpoint-"));
  try {
    writeOpenCodeV2CatalogEndpoint(dir, endpoint);
    const raw = join(dir, OPENCODE_V2_CATALOG_ENDPOINT_FILE);
    chmodSync(raw, 0o644);
    expect(readOpenCodeV2CatalogEndpoint(dir)).toBeNull();
    chmodSync(raw, 0o600);
    const linked = mkdtempSync(join(tmpdir(), "oc-endpoint-link-"));
    symlinkSync(raw, join(linked, OPENCODE_V2_CATALOG_ENDPOINT_FILE));
    expect(readOpenCodeV2CatalogEndpoint(linked)).toBeNull();
    rmSync(linked, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("non-loopback and relative directory are refused before a file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-endpoint-"));
  try {
    expect(() => writeOpenCodeV2CatalogEndpoint(dir, { ...endpoint, url: "http://example.com" })).toThrow(/loopback/);
    expect(() => writeOpenCodeV2CatalogEndpoint(dir, { ...endpoint, directory: "relative" })).toThrow(/absolute/);
    expect(readOpenCodeV2CatalogEndpoint(dir)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
