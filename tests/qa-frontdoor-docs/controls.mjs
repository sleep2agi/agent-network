// Execute the original suite, including its real production build, in each fresh container.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const source = process.env.SOURCE_COMMIT;
assert.match(source ?? "", /^[0-9a-f]{40}$/);
assert.equal(source, process.env.EXPECTED_SOURCE_COMMIT);
const fixtureCase = process.env.FIXTURE_CASE ?? "baseline";
console.log(`TEST-ONLY source=${source} case=${fixtureCase}`);
const scriptPath = "tests/qa-frontdoor-docs/run.mjs";
const archivePath = "docs/archive/upgrade-v2.md";
const note = "本文中的旧版本号只描述当时迁移背景";
const originalScript = readFileSync(scriptPath);
const originalArchive = readFileSync(archivePath);
const runOriginal = () => {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stdout.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.signal, null, "original suite terminated by a signal");
  return result;
};

try {
  if (fixtureCase === "baseline") {
    assert.equal(runOriginal().status, 0, "original frontdoor suite baseline failed");
    console.log("PASS: complete original baseline and actual VitePress render");
  } else if (fixtureCase === "old-path") {
    const script = readFileSync("tests/qa-frontdoor-docs/run.mjs", "utf8");
    assert.equal(script.split('read("docs/archive/upgrade-v2.md")').length, 2);
    writeFileSync("tests/qa-frontdoor-docs/run.mjs", script.replace('read("docs/archive/upgrade-v2.md")', 'read("docs/upgrade-v2.md")'));
    const result = runOriginal();
    assert.notEqual(result.status, 0, "FALSE_GREEN: original missing path was accepted");
    assert.match(result.stderr, /code: 'ENOENT'/);
    assert.match(result.stderr, /path: 'docs\/upgrade-v2\.md'/);
    console.log("WITNESSED_RED: restored exact old path produces original ENOENT");
  } else if (fixtureCase === "missing-note") {
    const archive = readFileSync("docs/archive/upgrade-v2.md", "utf8");
    assert.equal(archive.split(note).length, 2);
    writeFileSync("docs/archive/upgrade-v2.md", archive.replace("本文中的旧版本号只描述当时迁移背景", ""));
    const result = runOriginal();
    assert.equal(result.status, 1, "FALSE_GREEN: missing historical disclaimer was accepted");
    assert.match(result.stderr, /FAIL \(1\)/);
    assert.match(result.stderr, /historical upgrade note still presents a stale current version/);
    console.log("WITNESSED_RED: original historical-disclaimer assertion rejects missing note");
  } else {
    throw new Error(`unknown fixture case: ${fixtureCase}`);
  }
} finally {
  writeFileSync(scriptPath, originalScript);
  writeFileSync(archivePath, originalArchive);
  assert.deepEqual(readFileSync(scriptPath), originalScript);
  assert.deepEqual(readFileSync(archivePath), originalArchive);
  console.log("RESTORED: original script and archive bytes");
}
