import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_RUNTIME_NAMES } from "./normalize-runtime";

describe("fleet boot runtime allowlist", () => {
  test("OK_RUNTIMES includes every canonical runtime, including cursor-agent", () => {
    const script = readFileSync(join(import.meta.dir, "../../deploy/fleet/anet-nodes-boot.sh"), "utf8");
    const line = script.split("\n").find((row) => row.startsWith("OK_RUNTIMES="));
    expect(line).toBeDefined();
    const listed = line!.slice("OK_RUNTIMES=".length).replaceAll('"', "").split(/\s+/);
    expect(listed).toEqual([...SUPPORTED_RUNTIME_NAMES]);
  });
});
