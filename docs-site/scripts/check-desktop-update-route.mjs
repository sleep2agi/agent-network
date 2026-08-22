import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(
  await readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
);

const route = config.rewrites?.find(
  (entry) => entry.source === '/desktop/update/latest.json',
);

assert.ok(route, 'desktop updater route must exist');
assert.equal(
  route.destination,
  'https://github.com/sleep2agi/agent-network-app/releases/latest/download/latest.json',
  'desktop updater route must target the signed stable release manifest',
);

console.log('desktop updater route: ok');
