import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(
  await readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
);
const manifest = JSON.parse(
  await readFile(new URL('../docs/public/desktop/update/latest.json', import.meta.url), 'utf8'),
);

const route = config.rewrites?.find(
  (entry) => entry.source === '/desktop/update/latest.json',
);

assert.equal(route, undefined, 'desktop updater manifest must be served directly, without a rewrite');
// Windows MSI accepts a numeric-only prerelease identifier (for example
// 0.2.33-1), but rejects identifiers such as 0.2.33-beta.1.
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-\d+)?$/);
assert.ok(manifest.platforms?.['darwin-aarch64']?.signature);
assert.ok(manifest.platforms?.['windows-x86_64']?.signature);

console.log(`desktop updater static manifest: ${manifest.version} ok`);
