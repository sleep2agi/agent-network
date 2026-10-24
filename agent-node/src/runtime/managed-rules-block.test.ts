// RFC-043 §7 的"决策无关"部分：受管块的渲染与写入。
// 这些用例故意不依赖"三层怎么裁决"或"什么时候注入"——见模块头注释。
import { describe, expect, test } from "bun:test";
import {
  applyManagedBlock,
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  readManagedBlock,
  renderManagedBlock,
  type RulesLayer,
} from "./managed-rules-block";

const layer = (source: string, content: string, revision = 1, updated_at: string | null = null): RulesLayer =>
  ({ source, content, revision, updated_at });

describe("renderManagedBlock", () => {
  test("no usable layer renders nothing (caller keeps the old block)", () => {
    expect(renderManagedBlock([], 3)).toBeNull();
    expect(renderManagedBlock([layer("Hub", "   \n\t ") ], 3)).toBeNull();
  });

  test("layers keep their order and carry provenance", () => {
    const block = renderManagedBlock([
      layer("Hub / 网络 net_a", "hub rule", 7, "2026-10-24T13:00:00Z"),
      layer("节点（本文件原有内容）", "node rule", 1),
    ], 7)!;
    expect(block).toContain("v7 BEGIN");
    const hubAt = block.indexOf("hub rule");
    const nodeAt = block.indexOf("node rule");
    expect(hubAt).toBeGreaterThan(0);
    expect(nodeAt).toBeGreaterThan(hubAt);
    expect(block).toContain("revision 7");
    expect(block).toContain("更新于 2026-10-24T13:00:00Z");
    expect(block.trimEnd().endsWith(MANAGED_BLOCK_END(7))).toBe(true);
  });

  test("empty layers are skipped rather than rendered as empty sections", () => {
    const block = renderManagedBlock([layer("Hub", "only me", 2), layer("Daemon", "")], 2)!;
    expect(block).toContain("only me");
    expect(block).not.toContain("来源：Daemon");
  });
});

describe("applyManagedBlock", () => {
  const block3 = renderManagedBlock([layer("Hub", "a", 3)], 3)!;

  test("into an empty file: inserted, block starts at byte 0", () => {
    const out = applyManagedBlock("", block3);
    expect(out.action).toBe("inserted");
    expect(out.content.startsWith(MANAGED_BLOCK_BEGIN(3))).toBe(true);
  });

  test("into a file with user content: the user bytes survive exactly", () => {
    const user = "# 我自己的规则\n\n- 不要动我\n";
    const out = applyManagedBlock(user, block3);
    expect(out.action).toBe("inserted");
    expect(out.content.endsWith(user)).toBe(true);
    // 块与用户内容之间恰有一个空行，不吞用户首行。
    expect(out.content).toContain("\n\n# 我自己的规则");
  });

  test("re-applying the identical block is a no-op (no diff, no mtime churn)", () => {
    const first = applyManagedBlock("user\n", block3).content;
    const second = applyManagedBlock(first, block3);
    expect(second.action).toBe("unchanged");
    expect(second.content).toBe(first);
  });

  test("a new revision replaces only the block", () => {
    const first = applyManagedBlock("user\n", block3).content;
    const block4 = renderManagedBlock([layer("Hub", "a", 4)], 4)!;
    const out = applyManagedBlock(first, block4);
    expect(out.action).toBe("replaced");
    expect(out.content).toContain("v4 BEGIN");
    expect(out.content).not.toContain("v3 BEGIN");
    expect(out.content.endsWith("user\n")).toBe(true);
  });

  test("a half-written block is refused, not guessed", () => {
    const onlyBegin = `${MANAGED_BLOCK_BEGIN(3)}\n半截\nuser\n`;
    const onlyEnd = `user\n${MANAGED_BLOCK_END(3)}\n`;
    for (const broken of [onlyBegin, onlyEnd]) {
      const out = applyManagedBlock(broken, block3);
      expect(out.action).toBe("refused");
      expect(out.content).toBe(broken);
    }
  });

  test("BEGIN/END revision mismatch and duplicated blocks are refused", () => {
    const mismatch = `${MANAGED_BLOCK_BEGIN(2)}\nx\n${MANAGED_BLOCK_END(3)}\nuser\n`;
    expect(applyManagedBlock(mismatch, block3).action).toBe("refused");

    const two = `${block3}\n${block3}user\n`;
    const out = applyManagedBlock(two, block3);
    expect(out.action).toBe("refused");
    expect(out.content).toBe(two);
  });

  test("a user line that merely says END is not a marker", () => {
    const user = "# 规则\nEND 这一行是普通文字\n";
    const out = applyManagedBlock(user, block3);
    expect(out.action).toBe("inserted");
    expect(out.content.endsWith(user)).toBe(true);
  });

  test("readManagedBlock reports the applied revision and body", () => {
    const file = applyManagedBlock("user\n", block3).content;
    const read = readManagedBlock(file)!;
    expect(read.revision).toBe(3);
    expect(read.body).toContain("revision 3");
    expect(readManagedBlock("no block here\n")).toBeNull();
  });
});
