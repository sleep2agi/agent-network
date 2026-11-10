import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

// Do not inherit host credentials. The caller mounts only this offline backup,
// the published tarball and the running Hub's Bun executable, all read-only.
assert.equal(Bun.version, '1.4.0');
assert.equal(process.env.DATABASE_URL, undefined);
const expected = process.env.HUB_PREFLIGHT_INTEGRITY ?? 'YT1x3vnqaVdMaETIoN/5OebLZEcWiqPB0QOKk6LO6n48x8RHVDKr4M5f6EMtHdwn0M5EPlaotZ/fzRvWLBn3Tw==';
const version = process.env.HUB_PREFLIGHT_VERSION ?? '0.9.0-preview.126';
const tarball = '/input/hub.tgz';
assert.equal(createHash('sha512').update(readFileSync(tarball)).digest('base64'), expected);
mkdirSync('/tmp/package-input');
assert.equal(Bun.spawnSync(['tar', '-xzf', tarball, '-C', '/tmp/package-input']).exitCode, 0);
const pkg = JSON.parse(readFileSync('/tmp/package-input/package/package.json', 'utf8'));
assert.equal(pkg.name, '@sleep2agi/commhub-server');
assert.equal(pkg.version, version);
// db.ts's read-cache imports node-health-store, which requires this lockfile
// dependency. Supply its exact tarball offline; never let Bun auto-install it.
assert.equal(createHash('sha512').update(readFileSync('/input/zod.tgz')).digest('base64'),
  'v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==');
mkdirSync('/tmp/package-input/package/node_modules/zod', { recursive: true });
assert.equal(Bun.spawnSync(['tar', '-xzf', '/input/zod.tgz', '--strip-components=1', '-C', '/tmp/package-input/package/node_modules/zod']).exitCode, 0);

copyFileSync('/input/before.db', '/tmp/migration.db');
const tables = ['sessions', 'tasks', 'nodes', 'networks', 'requirements', 'api_tokens', 'user_inbox'];
const before = new Database('/tmp/migration.db', { readonly: true });
assert.deepEqual(before.query('PRAGMA integrity_check').values(), [['ok']]);
const counts = Object.fromEntries(tables.map(t => [t, before.query(`SELECT COUNT(*) n FROM ${t}`).get().n]));
const providerTables = ['daemon_provider_snapshots', 'daemon_provider_writes', 'daemon_provider_applications', 'daemon_provider_logins', 'hub_provider_configs', 'hub_provider_bindings'];
const providerCounts = Object.fromEntries(providerTables.map(t => [t,
  before.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)
    ? before.query(`SELECT COUNT(*) n FROM ${t}`).get().n : 0]));
before.close();
process.env.NODE_ENV = 'test';
process.env.COMMHUB_DB = '/tmp/migration.db';
// Import only schema/migrations. No HTTP entrypoint, scheduler or node dispatch.
const { db } = await import('/tmp/package-input/package/src/db.ts');
for (const t of tables) assert.equal(db.get(`SELECT COUNT(*) n FROM ${t}`).n, counts[t], `${t}: row count`);
for (const t of providerTables) {
  assert.equal(db.get(`SELECT COUNT(*) n FROM ${t}`).n, providerCounts[t], `${t}: preserved rows`);
}
assert.ok(db.all('PRAGMA table_info(node_create_requests)').some(c => c.name === 'clone_json'), 'clone column exists');
db.close();
const after = new Database('/tmp/migration.db', { readonly: true });
assert.deepEqual(after.query('PRAGMA integrity_check').values(), [['ok']]);
after.close();
console.log(JSON.stringify({ result: 'PASS', version: pkg.version, bun: Bun.version, preservedCounts: counts, providerCounts, loginRowsPreserved: true, cloneColumn: true, scope: 'offline schema migration only; no live service or authentication test' }));
