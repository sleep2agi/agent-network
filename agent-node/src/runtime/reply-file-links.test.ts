import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachLocalFileLinks, checkLocalFile, findLocalFileLinks, mimeFor, rewriteReplyLinks } from "./reply-file-links";

describe("reply-file-links: finding local links", () => {
  test("absolute paths and file:// count; http, /api/files, relative do not", () => {
    const t = "看 [报告](/data/w/r.pdf) 和 [图](file:///tmp/a%20b.png);不算的:[站](https://x.y/z.pdf) [已传](/api/files/abc12345) [rel](./x.pdf) [proto](//cdn/x)";
    const l = findLocalFileLinks(t);
    expect(l.map((x) => x.path)).toEqual(["/data/w/r.pdf", "/tmp/a b.png"]);
    expect(l[0].label).toBe("报告");
  });
  test("caps at 6 links", () => {
    const t = Array.from({ length: 9 }, (_, i) => `[f${i}](/w/f${i}.pdf)`).join(" ");
    expect(findLocalFileLinks(t).length).toBe(6);
  });
});

describe("reply-file-links: local file policy", () => {
  const root = mkdtempSync(join(tmpdir(), "anet-rfl-"));
  const other = mkdtempSync(join(tmpdir(), "anet-rfl-other-"));
  writeFileSync(join(root, "r.pdf"), "%PDF-1.4 x");
  writeFileSync(join(root, "empty.txt"), "");
  writeFileSync(join(other, "secret.txt"), "s");
  mkdirSync(join(root, "d"));
  symlinkSync(join(other, "secret.txt"), join(root, "escape.txt"));
  test("inside root, regular, non-empty, small → ok with mime", () => {
    const c = checkLocalFile(join(root, "r.pdf"), [root]);
    expect(c.ok).toBe(true);
    if (c.ok) { expect(c.mime).toBe("application/pdf"); expect(c.name).toBe("r.pdf"); expect(c.size).toBe(10); }
  });
  test("outside root / symlink escape / directory / empty / missing / too big are refused with a reason", () => {
    expect(checkLocalFile(join(other, "secret.txt"), [root])).toMatchObject({ ok: false, reason: "不在节点的工作目录或家目录内" });
    expect(checkLocalFile(join(root, "escape.txt"), [root])).toMatchObject({ ok: false, reason: "不在节点的工作目录或家目录内" });
    expect(checkLocalFile(join(root, "d"), [root])).toMatchObject({ ok: false, reason: "不是普通文件" });
    expect(checkLocalFile(join(root, "empty.txt"), [root])).toMatchObject({ ok: false, reason: "空文件" });
    expect(checkLocalFile(join(root, "nope.pdf"), [root])).toMatchObject({ ok: false, reason: "文件不存在" });
    expect(checkLocalFile(join(root, "r.pdf"), [root], 4)).toMatchObject({ ok: false });
  });
  test("mime table falls back to octet-stream", () => {
    expect(mimeFor("a.PNG")).toBe("image/png"); expect(mimeFor("a.bin")).toBe("application/octet-stream");
  });
});

describe("reply-file-links: rewrite + end-to-end", () => {
  const root = mkdtempSync(join(tmpdir(), "anet-rfl-e2e-"));
  writeFileSync(join(root, "report.pdf"), "%PDF ok");
  test("uploaded links become /api/files/<id> with attachments; failed ones keep the label and say why", async () => {
    const text = `报告好了:[下载报告](${root}/report.pdf),还有 [旧的](/nowhere/old.pdf)。`;
    const r = await attachLocalFileLinks(text, { roots: [root], upload: async (f) => ({ file_id: "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1", name: f.name, mime: f.mime, size: f.size }) });
    expect(r.uploaded).toBe(1); expect(r.failed).toBe(1);
    expect(r.text).toContain("[下载报告](/api/files/f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1)");
    expect(r.text).toContain("旧的(文件未上传:文件不存在;路径 /nowhere/old.pdf)");
    expect(r.attachments).toEqual([{ type: "file", file_id: "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1", name: "report.pdf", mime: "application/pdf", size: 7 }]);
  });
  test("upload throwing is reported inline, not thrown", async () => {
    const r = await attachLocalFileLinks(`[x](${root}/report.pdf)`, { roots: [root], upload: async () => { throw new Error("HTTP 413"); } });
    expect(r.failed).toBe(1); expect(r.text).toContain("上传失败(HTTP 413)");
  });
  test("no local links → untouched, no upload calls", async () => {
    let calls = 0;
    const r = await attachLocalFileLinks("纯文字 [站](https://a.b/c)", { roots: [root], upload: async () => { calls++; return { file_id: "x", name: "", mime: "", size: 0 }; } });
    expect(r.text).toBe("纯文字 [站](https://a.b/c)"); expect(calls).toBe(0); expect(r.attachments).toEqual([]);
  });
  test("rewriteReplyLinks leaves unrelated text alone", () => {
    expect(rewriteReplyLinks("abc", []).text).toBe("abc");
  });
});
