// Run with `node --test` (Node 22+) so Linux CI can use fileURLToPath's
// Windows mode. Bun 1.3.14 only honors the host OS for this API.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findLocalFileLinks } from "./reply-file-links.ts";
import { resolveAcpUploadMcpEntry } from "./acp-upload-mcp-entry.ts";

const options = { skip: !!process.versions.bun && process.platform !== "win32" };

test("Windows drive letter, spaces and Unicode survive local file conversion", options, () => {
  const text = String.raw`[URI](file:///C:/Test%20Reports/%E5%9B%BE.png) [DOS](D:\work\log.json) [slash](D:/work/log.json) [relative](D:log.json) [Hub](/api/files/abc) [UNC](file://host/share/log.json)`;
  assert.deepEqual(findLocalFileLinks(text, true).map((link) => link.path), [
    String.raw`C:\Test Reports\图.png`, String.raw`D:\work\log.json`, "D:/work/log.json",
  ]);
});

test("malformed URLs do not prevent a later Windows evidence link", options, () => {
  const text = "[bad](file:///C:/bad%zz.png) [NUL](file:///C:/bad%00.png) [separator](file:///C:/a%2fb.png) [good](file:///C:/ok.png)";
  assert.deepEqual(findLocalFileLinks(text, true).map((link) => link.path), [String.raw`C:\ok.png`]);
});

test("packaged ACP server resolves its Windows entry even under Program Files", options, () => {
  const script = String.raw`C:\Program Files\ANet\upload-file-mcp-stdio.js`;
  const execPath = String.raw`C:\Program Files\nodejs\node.exe`;
  assert.deepEqual(resolveAcpUploadMcpEntry("file:///C:/Program%20Files/ANet/cli.js", {
    windows: true, exists: (path) => path === script, execPath,
  }), { uploadMcpCommand: execPath, uploadMcpArgs: [script] });
});
