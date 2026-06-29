/**
 * RFC-020 §15 — agent→bridge outbound file protocol parser tests.
 *
 * Covers parseOutboundMarkers (cleaned text + file list extraction),
 * normalizeMarkerPath (quote-strip, `..` collapse, `//` collapse),
 * validateOutboundPath (per-conversation whitelist, exists + size),
 * sniffFileKind (PNG/JPG/GIF/BMP/WebP → image, otherwise → file).
 *
 * Run: `bun tests/feishu-outbound-marker.test.ts`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  parseOutboundMarkers,
  normalizeMarkerPath,
  validateOutboundPath,
  sniffFileKind,
  OUTBOUND_ROOT,
  ALL_FILES_FAILED_FALLBACK,
} from "../src/im/feishu/outbound-marker";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. parseOutboundMarkers — no markers ───────────────────────────────────

{
  const r = parseOutboundMarkers("just a plain reply");
  expect("plain text: cleanedText preserved", r.cleanedText === "just a plain reply");
  expect("plain text: no files", r.files.length === 0);
}

{
  const r = parseOutboundMarkers("");
  expect("empty input: empty result", r.cleanedText === "" && r.files.length === 0);
}

{
  const r = parseOutboundMarkers(null);
  expect("null input: empty result", r.cleanedText === "" && r.files.length === 0);
}

// ── 2. Single marker at end of text ────────────────────────────────────────

{
  const r = parseOutboundMarkers(
    "报告做好了，要点如下：A / B / C。\n[[send-file:/work/feishu-attachments/feishu-local/oc_xxx/report.pdf]]",
  );
  expect(
    "single marker: cleanedText strips marker",
    r.cleanedText === "报告做好了，要点如下：A / B / C。",
    `got: ${JSON.stringify(r.cleanedText)}`,
  );
  expect("single marker: 1 file", r.files.length === 1);
  expect(
    "single marker: path normalized",
    r.files[0].normalized === "/work/feishu-attachments/feishu-local/oc_xxx/report.pdf",
  );
}

// ── 3. Multiple markers on separate lines ──────────────────────────────────

{
  const reply = [
    "三个文件都准备好了:",
    "[[send-file:/work/feishu-attachments/feishu-local/oc_x/a.pdf]]",
    "[[send-file:/work/feishu-attachments/feishu-local/oc_x/b.png]]",
    "[[send-file:/work/feishu-attachments/feishu-local/oc_x/c.txt]]",
  ].join("\n");
  const r = parseOutboundMarkers(reply);
  expect(
    "multi-marker: 3 files",
    r.files.length === 3,
    `got ${r.files.length}: ${JSON.stringify(r.files)}`,
  );
  expect(
    "multi-marker: source order preserved",
    r.files[0].normalized.endsWith("a.pdf") &&
      r.files[1].normalized.endsWith("b.png") &&
      r.files[2].normalized.endsWith("c.txt"),
  );
  expect(
    "multi-marker: cleanedText = leading prose",
    r.cleanedText === "三个文件都准备好了:",
    `got: ${JSON.stringify(r.cleanedText)}`,
  );
}

// ── 4. Markers interleaved with prose ──────────────────────────────────────

{
  const reply = [
    "先看这个 PDF:",
    "[[send-file:/work/feishu-attachments/feishu-local/oc_x/a.pdf]]",
    "",
    "对比这张图:",
    "[[send-file:/work/feishu-attachments/feishu-local/oc_x/b.png]]",
    "",
    "总结一下：核心结论是 X 和 Y。",
  ].join("\n");
  const r = parseOutboundMarkers(reply);
  expect("interleaved: 2 files", r.files.length === 2);
  expect("interleaved: leading prose preserved", r.cleanedText.includes("先看这个 PDF"));
  expect("interleaved: middle prose preserved", r.cleanedText.includes("对比这张图"));
  expect("interleaved: trailing prose preserved", r.cleanedText.includes("总结一下"));
  expect("interleaved: no markers leak", !r.cleanedText.includes("send-file"));
  // Should not have triple blank lines
  expect(
    "interleaved: blank-line runs collapsed",
    !/\n{3,}/.test(r.cleanedText),
    `text: ${JSON.stringify(r.cleanedText)}`,
  );
}

// ── 5. Marker-only reply (no surrounding text) ─────────────────────────────

{
  const r = parseOutboundMarkers(
    "[[send-file:/work/feishu-attachments/feishu-local/oc_x/a.pdf]]",
  );
  expect("marker-only: empty cleanedText", r.cleanedText === "", `got: ${JSON.stringify(r.cleanedText)}`);
  expect("marker-only: 1 file", r.files.length === 1);
}

// ── 6. Malformed markers ───────────────────────────────────────────────────

// Missing closing ]] — not extracted, marker text remains visible
{
  const r = parseOutboundMarkers(
    "broken: [[send-file:/work/feishu-attachments/x/a.pdf",
  );
  expect("unclosed marker: 0 files", r.files.length === 0);
  expect("unclosed marker: text untouched", r.cleanedText.includes("[[send-file"));
}

// Empty path between markers — dropped silently
{
  const r = parseOutboundMarkers("text [[send-file:]] more text");
  // Empty inside [...] doesn't match because of `[^\]\n]+` (one or more
  // non-`]` characters required).
  expect("empty marker: 0 files", r.files.length === 0);
  expect("empty marker: passes through text", r.cleanedText.includes("[[send-file:]]"));
}

// Relative path inside marker — dropped from files but stripped from text
{
  const r = parseOutboundMarkers("foo [[send-file:relative/path.pdf]] bar");
  expect("relative-path marker: 0 files", r.files.length === 0);
  expect("relative-path marker: marker stripped", !r.cleanedText.includes("send-file"));
  expect("relative-path marker: surrounding text preserved", r.cleanedText.includes("foo") && r.cleanedText.includes("bar"));
}

// ── 7. normalizeMarkerPath unit ────────────────────────────────────────────

expect("normalize: bare absolute", normalizeMarkerPath("/work/x") === "/work/x");
expect("normalize: collapse //", normalizeMarkerPath("//work//.anet//x") === "/work/.anet/x");
expect("normalize: `..` collapse", normalizeMarkerPath("/work/a/../b/c") === "/work/b/c");
expect("normalize: `.` drop", normalizeMarkerPath("/work/./b") === "/work/b");
expect("normalize: trailing /", normalizeMarkerPath("/work/x/") === "/work/x/");
expect("normalize: trim spaces", normalizeMarkerPath("  /work/x  ") === "/work/x");
expect('normalize: strip double-quote', normalizeMarkerPath('"/work/x"') === "/work/x");
expect("normalize: strip single-quote", normalizeMarkerPath("'/work/x'") === "/work/x");
expect("normalize: relative → empty", normalizeMarkerPath("relative/x") === "");
expect("normalize: empty → empty", normalizeMarkerPath("") === "");
expect("normalize: only `~` → empty (not abs)", normalizeMarkerPath("~/x") === "");

// ── 8. validateOutboundPath — happy path ───────────────────────────────────

{
  // Build a tmp file matching the structure /tmp/.../feishu-attachments/feishu-local/oc_x/file.pdf
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-outbound-"));
  const fakeRoot = path.join(tmpdir, "feishu-attachments", "feishu-local", "oc_test");
  fs.mkdirSync(fakeRoot, { recursive: true });
  const file = path.join(fakeRoot, "report.pdf");
  fs.writeFileSync(file, Buffer.from("PDF-1.4\n%fake content"));

  // We can't redirect OUTBOUND_ROOT cleanly, so emulate by patching the
  // expected prefix through the path-and-stat injection: build the
  // candidate path identical to what would land in production by
  // hand-rolling a fake `/work/feishu-attachments/feishu-local/oc_test/...`
  // and providing mock stat + realpath functions.
  const candidate = "/work/feishu-attachments/feishu-local/oc_test/report.pdf";
  // Preferred shape: caller passes precomputed expectedDir
  const reason = validateOutboundPath({
    p: candidate,
    expectedDir: "/work/feishu-attachments/feishu-local/oc_test/",
    realpathFn: () => candidate,
    statFn: () => ({ size: 100 }),
  });
  expect("validate happy path (expectedDir) → null", reason === null, `got: ${reason}`);

  // Legacy shape: caller passes connectionName + convKey, helper computes prefix
  const reasonLegacy = validateOutboundPath({
    p: candidate,
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => candidate,
    statFn: () => ({ size: 100 }),
  });
  expect("validate happy path (legacy) → null", reasonLegacy === null, `got: ${reasonLegacy}`);

  fs.rmSync(tmpdir, { recursive: true, force: true });
}

// ── 9. validateOutboundPath — wrong directory ──────────────────────────────

{
  // Path under a DIFFERENT conv → reject (cross-conv leak)
  const r = validateOutboundPath({
    p: "/work/feishu-attachments/feishu-local/oc_OTHER/leak.pdf",
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => "/work/feishu-attachments/feishu-local/oc_OTHER/leak.pdf",
    statFn: () => ({ size: 100 }),
  });
  expect("validate cross-conv → reject", r !== null && r.includes("会话目录"), `got: ${r}`);
}

{
  // Path outside the outbound root → reject
  const r = validateOutboundPath({
    p: "/etc/passwd",
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => "/etc/passwd",
    statFn: () => ({ size: 100 }),
  });
  expect("validate /etc/passwd → reject", r !== null, `got: ${r}`);
}

{
  // Path under a different connection → reject
  const r = validateOutboundPath({
    p: "/work/feishu-attachments/OTHER-NODE/oc_test/x.pdf",
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => "/work/feishu-attachments/OTHER-NODE/oc_test/x.pdf",
    statFn: () => ({ size: 100 }),
  });
  expect("validate cross-connection → reject", r !== null, `got: ${r}`);
}

// ── 10. validateOutboundPath — symlink escape ──────────────────────────────

{
  // Lexical path inside allowed root, but realpath redirects outside.
  const r = validateOutboundPath({
    p: "/work/feishu-attachments/feishu-local/oc_test/bait.pdf",
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => "/etc/shadow", // symlink escape
    statFn: () => ({ size: 100 }),
  });
  expect("validate symlink-escape → reject", r !== null && r.includes("越权"), `got: ${r}`);
}

// ── 11. validateOutboundPath — size ────────────────────────────────────────

{
  // Empty file
  const candidate = "/work/feishu-attachments/feishu-local/oc_test/empty.pdf";
  const r = validateOutboundPath({
    p: candidate,
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => candidate,
    statFn: () => ({ size: 0 }),
  });
  expect("validate empty file → reject", r !== null && r.includes("空"), `got: ${r}`);
}

{
  // 50MB > 30MB cap
  const candidate = "/work/feishu-attachments/feishu-local/oc_test/huge.bin";
  const r = validateOutboundPath({
    p: candidate,
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => candidate,
    statFn: () => ({ size: 50 * 1024 * 1024 }),
  });
  expect("validate 50MB → reject", r !== null && r.includes("过大"), `got: ${r}`);
}

// ── 12. validateOutboundPath — realpath ENOENT ─────────────────────────────

{
  // Realpath throws (file doesn't exist) → reject
  const r = validateOutboundPath({
    p: "/work/feishu-attachments/feishu-local/oc_test/missing.pdf",
    convKey: "oc_test",
    connectionName: "feishu-local",
    realpathFn: () => {
      throw new Error("ENOENT");
    },
    statFn: () => ({ size: 100 }),
  });
  expect("validate missing file → reject", r !== null && r.includes("不存在"), `got: ${r}`);
}

// ── 13. sniffFileKind ──────────────────────────────────────────────────────

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_HEAD = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const BMP_HEAD = Buffer.from([0x42, 0x4d, 0x46, 0x00]);
const WEBP_HEAD = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF_HEAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
const TXT_HEAD = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f]); // "hello wo"

expect("sniff PNG → image", sniffFileKind(PNG_HEAD) === "image");
expect("sniff JPG → image", sniffFileKind(JPG_HEAD) === "image");
expect("sniff GIF → image", sniffFileKind(GIF_HEAD) === "image");
expect("sniff BMP → image", sniffFileKind(BMP_HEAD) === "image");
expect("sniff WebP → image", sniffFileKind(WEBP_HEAD) === "image");
expect("sniff PDF → file", sniffFileKind(PDF_HEAD) === "file");
expect("sniff TXT → file", sniffFileKind(TXT_HEAD) === "file");
expect("sniff empty → file", sniffFileKind(Buffer.alloc(0)) === "file");
expect("sniff 3-byte truncated → file", sniffFileKind(Buffer.from([0x89, 0x50, 0x4e])) === "file");

// ── 14. OUTBOUND_ROOT + ALL_FILES_FAILED_FALLBACK shape ────────────────────

expect("OUTBOUND_ROOT is /work/feishu-attachments", OUTBOUND_ROOT === "/work/feishu-attachments");
expect("fallback message in Chinese", ALL_FILES_FAILED_FALLBACK.includes("发送失败"));
expect(
  "fallback message does NOT leak protocol details (no 'send-file', no path)",
  !ALL_FILES_FAILED_FALLBACK.includes("send-file") &&
    !ALL_FILES_FAILED_FALLBACK.includes("/work"),
);

// ── 15. Markers with quoted paths ──────────────────────────────────────────

{
  const r = parseOutboundMarkers(
    '前面有点东西 [[send-file:"/work/feishu-attachments/feishu-local/oc_x/quoted.pdf"]]',
  );
  expect("quoted path marker: 1 file", r.files.length === 1);
  expect(
    "quoted path: quotes stripped",
    r.files[0].normalized === "/work/feishu-attachments/feishu-local/oc_x/quoted.pdf",
  );
}

// ── 16. Adjacent prose preserved verbatim ──────────────────────────────────

{
  const reply =
    "Hi there! [[send-file:/work/feishu-attachments/feishu-local/oc_x/a.pdf]] cheers.";
  const r = parseOutboundMarkers(reply);
  expect("inline marker: cleanedText preserved", r.cleanedText === "Hi there!  cheers.");
  expect("inline marker: 1 file", r.files.length === 1);
}

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-outbound-marker tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
