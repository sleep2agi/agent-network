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

// 🔴 A fallback.json can be structurally perfect and still ship links nobody can
//    download. The release's own latest.json addresses assets by **numeric id**
//    (…/releases/download/desktop-vX/569210828); the sync recipe has to map those
//    ids back to filenames, and twice now a sync nearly shipped the id form —
//    this checker passed both times, because it only ever looked at route shape
//    and signatures. It could not see the defect it was standing next to.
//
//    Judge the URL itself: every platform URL must end in a real asset filename
//    that carries this exact version. No network needed, so it cannot flake in
//    CI — and a HEAD request would only prove the file exists *today*, while the
//    shape rule also catches "correct file, wrong version", which is the other
//    way this file goes stale.
const assetName = (url) => url.split('/').pop() ?? '';
for (const [platform, entry] of Object.entries(fallback.platforms ?? {})) {
  const url = entry?.url ?? '';
  const name = assetName(url);
  assert.ok(
    /^https:\/\/github\.com\//.test(url),
    `${platform}: url must be a public github.com download link, got ${url || '(empty)'}`,
  );
  assert.ok(
    !/^\d+$/.test(name),
    `${platform}: url ends in an asset id (${name}) — map release asset ids back to filenames; this link 404s for users`,
  );
  assert.ok(
    /\.(tar\.gz|dmg|exe|msi)$/.test(name),
    `${platform}: url must end in a downloadable asset filename, got ${name || '(empty)'}`,
  );
  assert.ok(
    name.includes(fallback.version),
    `${platform}: asset ${name} does not carry version ${fallback.version}`,
  );
  assert.ok(
    url.includes(`/download/desktop-v${fallback.version}/`),
    `${platform}: url must point at the desktop-v${fallback.version} release, got ${url}`,
  );
}

await import('./desktop-update-dynamic.test.mjs');
console.log(`desktop updater dynamic route with ${fallback.version} fallback ok`);
