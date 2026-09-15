import { describe, expect, test } from "bun:test";
import { attachLocalLinks, findLocalLinks, rewriteLocalLinks } from "./reply-local-links";

describe("reply-local-links (node-server auto-attach)", () => {
  test("finds absolute and file:// links only", () => {
    const l = findLocalLinks("[a](/w/r.pptx) [b](file:///tmp/x%20y.pdf) [c](https://h/x) [d](/api/files/abcdefgh) [e](./rel)");
    expect(l.map((x) => x.path)).toEqual(["/w/r.pptx", "/tmp/x y.pdf"]);
  });
  test("uploaded links become /api/files/<id> with attachments; failures annotated with reason", async () => {
    const r = await attachLocalLinks("报告 [下载](/w/r.pptx) 和 [旧](/nowhere/o.pdf)", async (p) => {
      if (p.startsWith("/nowhere")) throw new Error("path_not_found");
      return { file_id: "f1f1f1f1f1f1f1f1", name: "r.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 10 };
    });
    expect(r.uploaded).toBe(1); expect(r.failed).toBe(1);
    expect(r.text).toContain("[下载](/api/files/f1f1f1f1f1f1f1f1)");
    expect(r.text).toContain("旧(文件未上传:path_not_found;路径 /nowhere/o.pdf)");
    expect(r.attachments).toEqual([{ type: "file", file_id: "f1f1f1f1f1f1f1f1", name: "r.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 10 }]);
  });
  test("no local links → untouched and no upload call", async () => {
    let n = 0;
    const r = await attachLocalLinks("纯文字 [站](https://a/b)", async () => { n++; return { file_id: "x", name: "" }; });
    expect(r.text).toBe("纯文字 [站](https://a/b)"); expect(n).toBe(0);
    expect(rewriteLocalLinks("abc", []).attachments).toEqual([]);
  });
});
