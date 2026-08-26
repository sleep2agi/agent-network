import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(
  await readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
);
const fallback = JSON.parse(
  await readFile(new URL('../docs/public/desktop/update/fallback.json', import.meta.url), 'utf8'),
);

const route = config.rewrites?.find(
  (entry) => entry.source === '/desktop/update/latest.json',
);

assert.equal(route?.destination, '/api/desktop-update-latest');
// Windows MSI accepts a numeric-only prerelease identifier (for example
// 0.2.33-1), but rejects identifiers such as 0.2.33-beta.1.
assert.match(fallback.version, /^\d+\.\d+\.\d+(?:-\d+)?$/);
assert.ok(fallback.platforms?.['darwin-aarch64']?.signature);
assert.ok(fallback.platforms?.['windows-x86_64']?.signature);

await import('./desktop-update-dynamic.test.mjs');
console.log(`desktop updater dynamic route with ${fallback.version} fallback ok`);
