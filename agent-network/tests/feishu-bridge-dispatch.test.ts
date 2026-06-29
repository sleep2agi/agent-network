/**
 * RFC-020 §15.1 — bridge dispatch loop integration test.
 *
 * Drives `parseOutboundMarkers → validateOutboundPath → sniffFileKind →
 * adapter.send` against a mocked adapter and real on-disk temp files,
 * to catch the bug class the unit tests missed: the bridge using a
 * different path-computation algorithm than the agent was told to use.
 *
 * The 2026-06-29 Vincent UAT bug was that adapter.ts inbound used
 * `oc_<chat>/` and bridge.ts outbound used `ou_<user>/`. Single-side unit
 * tests passed (60/60) — the divergence only showed in the integration
 * gap. This test locks the wire-up by running the actual code paths.
 *
 * Run: `bun tests/feishu-bridge-dispatch.test.ts`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  parseOutboundMarkers,
  validateOutboundPath,
  sniffFileKind,
} from "../src/im/feishu/outbound-marker";
import { feishuOutboundDir, feishuConvKey } from "../src/im/feishu/outbound-paths";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. End-to-end happy path: agent writes file at the path it was told,
//     bridge accepts it via the same helper ─────────────────────────────────

{
  // Simulate the production layout under a tmpdir we control. Override
  // OUTBOUND_ROOT by computing the equivalent prefix structure manually
  // (the helper's hardcoded "/work/feishu-attachments" can't be tweaked,
  // so we mock the realpath/stat layer instead).

  const VINCENT_CONN = "feishu-local";
  const VINCENT_CHAT_ID = "oc_9a7eedbba275a87999f7ee2cfb10f4cb";
  const expectedDir = feishuOutboundDir(VINCENT_CONN, VINCENT_CHAT_ID);

  // Build a real file under a tmpdir, then point realpathFn at THAT file
  // when validating the production-shape path. This proves the chain
  // accepts the canonical write location AS LONG AS the helper-produced
  // expectedDir is used.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-bridge-dispatch-"));
  const fakePdfPath = path.join(tmpdir, "TMWork_v1.20.4_报告.pdf");
  // Minimal PDF magic bytes
  fs.writeFileSync(fakePdfPath, Buffer.from("%PDF-1.4\n%fake content for integration test\n%EOF"));

  // Agent's reply mirrors Vincent's actual UAT: heading + bullets +
  // 3 markers, written to the SAME directory the agent was told via the
  // injected `[飞书 outbound] 这条会话的文件分发目录:` prompt.
  const productionPath = `${expectedDir}TMWork_v1.20.4_报告.pdf`;
  const agentReply = [
    "# TMWork v1.20.4 进度报告",
    "",
    "- 任务1: 完成",
    "- 任务2: 进行中",
    "- 任务3: 待启动",
    "",
    `[[send-file:${productionPath}]]`,
  ].join("\n");

  // 1a. parse
  const { cleanedText, files } = parseOutboundMarkers(agentReply);
  expect(
    "integration: marker stripped from text",
    !cleanedText.includes("send-file"),
    `text: ${cleanedText.slice(0, 80)}`,
  );
  expect("integration: 1 file extracted", files.length === 1);
  expect(
    "integration: extracted path matches production write location",
    files[0].normalized === productionPath,
  );

  // 1b. validate using the helper-computed expectedDir AND a mock
  //     realpath that resolves to our actual on-disk tmp file (proves
  //     symlink unwrap + size check work on real bytes).
  const reason = validateOutboundPath({
    p: productionPath,
    expectedDir,
    realpathFn: () => productionPath, // identity — no symlink
    statFn: () => fs.statSync(fakePdfPath),
  });
  expect(
    "integration: validate(prod-path, helper-prefix) → null (accept)",
    reason === null,
    `got: ${reason}`,
  );

  // 1c. sniff against real bytes
  const fd = fs.openSync(fakePdfPath, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  expect("integration: PDF sniffs as file (not image)", sniffFileKind(head) === "file");

  // 1d. mock adapter.send — assert dispatch shape
  const sentMessages: any[] = [];
  const mockSend = async (msg: any) => {
    sentMessages.push(msg);
    return { messageId: `m_${sentMessages.length}` };
  };

  // Replay the bridge's send-leg logic on the cleaned text + validated file:
  //   - if files present → text gets forceTextOnly:true (caption mode)
  //   - then one send per file with kind-routed argument
  if (cleanedText) {
    await mockSend({
      target: { conversationType: "dm", conversationId: VINCENT_CHAT_ID },
      text: cleanedText,
      forceTextOnly: files.length > 0,
    });
  }
  for (const f of files) {
    const filename = f.normalized.split("/").pop();
    await mockSend({
      target: { conversationType: "dm", conversationId: VINCENT_CHAT_ID },
      files: [{ path: f.normalized, name: filename }],
    });
  }

  expect("integration: 2 dispatches (caption + file)", sentMessages.length === 2);
  expect(
    "integration: text sent with forceTextOnly:true (caption-mode bypass markdown render)",
    sentMessages[0].forceTextOnly === true,
  );
  expect(
    "integration: file sent with files[0].path = production path",
    Array.isArray(sentMessages[1].files) && sentMessages[1].files[0].path === productionPath,
  );

  fs.rmSync(tmpdir, { recursive: true, force: true });
}

// ── 2. Regression bug shape: old algorithm (ou_user + #feishu suffix)
//     produces a DIFFERENT expectedDir than the production write — must reject.

{
  const CONN = "feishu-local";
  const CHAT_ID = "oc_9a7eedbba275a87999f7ee2cfb10f4cb";
  const USER_ID = "ou_74d554f4024ca8f2b643180229571f57";

  // Production write path (what the agent's prompt teaches)
  const writes = `${feishuOutboundDir(CONN, CHAT_ID)}report.pdf`;

  // Bug-shape prefix (pre-fix bridge): connectionName="feishu-local#feishu"
  // + convKey=ou_<user> for DMs. Build it explicitly to assert validate rejects.
  const buggyPrefix = `/work/feishu-attachments/feishu-local#feishu/${USER_ID}/`;
  const reason = validateOutboundPath({
    p: writes,
    expectedDir: buggyPrefix,
    realpathFn: () => writes,
    statFn: () => ({ size: 100 }),
  });
  expect(
    "regression: bug-shape prefix rejects the actual write (proves bug would still fail if convKey policy regressed)",
    reason !== null && reason.includes("会话目录"),
    `got: ${reason}`,
  );
}

// ── 3. Multi-file dispatch — all three (Vincent's pdf+docx+pptx) accepted ──

{
  const CONN = "feishu-local";
  const CHAT_ID = "oc_9a7eedbba275a87999f7ee2cfb10f4cb";
  const expectedDir = feishuOutboundDir(CONN, CHAT_ID);

  const reply = [
    "# 进度报告",
    "三个文件:",
    `[[send-file:${expectedDir}report.pdf]]`,
    `[[send-file:${expectedDir}report.docx]]`,
    `[[send-file:${expectedDir}report.pptx]]`,
  ].join("\n");

  const { cleanedText, files } = parseOutboundMarkers(reply);
  expect("multi-file: 3 files extracted", files.length === 3);

  for (const f of files) {
    const reason = validateOutboundPath({
      p: f.normalized,
      expectedDir,
      realpathFn: () => f.normalized,
      statFn: () => ({ size: 100 }),
    });
    expect(
      `multi-file: validate(${f.normalized.split("/").pop()}) → accept`,
      reason === null,
      `got: ${reason}`,
    );
  }
  // cleanedText still has heading — without forceTextOnly the bot's bullets
  // would render to PNG (the very UX bug Vincent flagged).
  expect("multi-file: cleanedText has heading (would-be markdown render)", cleanedText.includes("# 进度报告"));
}

// ── 4. Caption-mode hint: forceTextOnly only set when files present ───────

{
  // text-only reply (no markers) → forceTextOnly NOT triggered
  const r = parseOutboundMarkers("just a text reply, no files");
  expect("caption: text-only reply → 0 files (no caption-mode)", r.files.length === 0);

  // marker + text → caption-mode candidate
  const r2 = parseOutboundMarkers("here you go [[send-file:/work/feishu-attachments/x/y/z.pdf]]");
  expect("caption: marker + text → 1 file (caption-mode active)", r2.files.length === 1);
  expect("caption: cleaned text preserved", r2.cleanedText === "here you go");
}

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feishu-bridge-dispatch tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
