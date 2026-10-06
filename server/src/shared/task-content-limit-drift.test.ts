import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_TASK_PREVIEW_MAX, TASK_CONTENT_MAX, sessionTaskPreview } from "./task-content-limit.js";

// Board #668 — the node reports the whole task so the hub can match it
// against tasks.content. Both sides must agree on the cap.
const HUB_PATH = join(import.meta.dir, "task-content-limit.ts");
const NODE_PATH = join(import.meta.dir, "..", "..", "..", "agent-node", "src", "shared", "task-content-limit.ts");

describe("#668 — hub/node task-content-limit drift guard", () => {
  test("byte-identical source files", () => {
    expect(readFileSync(NODE_PATH, "utf-8")).toBe(readFileSync(HUB_PATH, "utf-8"));
  });

  test("constants equal at runtime", async () => {
    const node = await import(NODE_PATH);
    expect(node.TASK_CONTENT_MAX).toBe(TASK_CONTENT_MAX);
    expect(node.SESSION_TASK_PREVIEW_MAX).toBe(SESSION_TASK_PREVIEW_MAX);
  });

  test("preview is the first 200 chars", () => {
    expect(SESSION_TASK_PREVIEW_MAX).toBe(200);
    const long = "字".repeat(TASK_CONTENT_MAX);
    expect(sessionTaskPreview(long)).toBe(long.slice(0, 200));
    expect(sessionTaskPreview("short")).toBe("short");
  });
});
