import { readFileSync } from "node:fs";

const [transcriptPath, configPath] = process.argv.slice(2);
if (!transcriptPath || !configPath) {
  throw new Error("usage: assert-pty-selection.ts <typescript> <config.json>");
}

// Inquirer redraws in place. Preserve chronological text while removing only
// terminal escape sequences, then bind the last highlighted row immediately
// before each confirmation to both the confirmation label and persisted value.
const raw = readFileSync(transcriptPath, "utf8");
const clean = raw.replace(
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
  "",
);

function lastHighlightedBefore(marker: string): string {
  const markerAt = clean.indexOf(marker);
  if (markerAt < 0) throw new Error(`PTY_CONFIRMATION_MISSING marker=${marker}`);
  const before = clean.slice(0, markerAt);
  const rows = [...before.matchAll(/❯ ([^\r\n]+)/gu)];
  const selected = rows.at(-1)?.[1]?.trim();
  if (!selected) throw new Error(`PTY_HIGHLIGHT_MISSING marker=${marker}`);
  return selected;
}

function confirmedValue(marker: string): string {
  const markerAt = clean.indexOf(marker);
  if (markerAt < 0) throw new Error(`PTY_CONFIRMATION_MISSING marker=${marker}`);
  return clean.slice(markerAt + marker.length).split(/[\r\n]/, 1)[0].trim();
}

const vendorMarker = "✔ 选择供应商 (vendor):";
const modelMarker = "✔ 选择 Codex / GPT (海外，需 codex login) 模型:";
const expectedVendor = "Codex / GPT (海外，需 codex login)";
const expectedModel = "gpt-5.6-sol";
const highlightedVendor = lastHighlightedBefore(vendorMarker);
const confirmedVendor = confirmedValue(vendorMarker);
const highlightedModel = lastHighlightedBefore(modelMarker);
const confirmedModel = confirmedValue(modelMarker);
const config = JSON.parse(readFileSync(configPath, "utf8"));

if (highlightedVendor !== expectedVendor || confirmedVendor !== expectedVendor
    || config.runtime !== "codex-sdk") {
  throw new Error(`PTY_VENDOR_DISPLAY_VALUE_MISMATCH highlighted=${JSON.stringify(highlightedVendor)} confirmed=${JSON.stringify(confirmedVendor)} runtime=${JSON.stringify(config.runtime)}`);
}
if (highlightedModel !== expectedModel || confirmedModel !== expectedModel
    || config.model !== expectedModel) {
  throw new Error(`PTY_MODEL_DISPLAY_VALUE_MISMATCH highlighted=${JSON.stringify(highlightedModel)} confirmed=${JSON.stringify(confirmedModel)} model=${JSON.stringify(config.model)}`);
}

console.log(`PTY_DISPLAY_VALUE_PASS vendor=${confirmedVendor} runtime=${config.runtime} model=${config.model}`);
