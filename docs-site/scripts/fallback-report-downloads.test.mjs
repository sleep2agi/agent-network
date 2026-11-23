import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyDownloads } from './fallback-report-downloads.mjs';

test('real minisign verification rejects corrupted evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fallback-test-'));
  const originalFetch = globalThis.fetch;
  const originalBin = process.env.MINISIGN_BIN;
  try {
    delete process.env.MINISIGN_BIN;
    const secret = join(directory, 'secret');
    const pub = join(directory, 'public');
    const packagePath = join(directory, 'package');
    const signaturePath = join(directory, 'signature');
    const bytes = Buffer.from('fixture package bytes\n');
    await writeFile(packagePath, bytes);
    execFileSync('minisign', ['-G', '-W', '-p', pub, '-s', secret]);
    execFileSync('minisign', ['-Sm', packagePath, '-s', secret, '-x', signaturePath]);
    const signature = (await readFile(signaturePath)).toString('base64');
    const publicKey = (await readFile(pub)).toString('base64');
    const url = 'https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v0.2.614/package';
    const input = { publicKey, candidate: { version: '0.2.614', platforms: { test: { url, signature } } },
      release: { assets: [{ id: 1, browser_download_url: url, size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }] } };
    globalThis.fetch = async () => new Response(bytes);
    await t.test('valid bytes and signature pass', async () => {
      const result = await verifyDownloads(input);
      assert.equal(result.verified, true);
      assert.equal(result.observations.length, 1);
    });
    await t.test('same-length changed bytes fail digest check', async () => {
      const changed = Buffer.from(bytes); changed[0] ^= 1;
      globalThis.fetch = async () => new Response(changed);
      const result = await verifyDownloads(input);
      assert.equal(result.verified, false);
      assert.match(result.observations[0].error, /digest mismatch/);
      globalThis.fetch = async () => new Response(bytes);
    });
    await t.test('corrupt cryptographic signature fails despite matching digest', async () => {
      const changed = structuredClone(input);
      const lines = Buffer.from(signature, 'base64').toString().split('\n');
      const packet = Buffer.from(lines[1], 'base64'); packet[20] ^= 1;
      lines[1] = packet.toString('base64');
      changed.candidate.platforms.test.signature = Buffer.from(lines.join('\n')).toString('base64');
      const result = await verifyDownloads(changed);
      assert.equal(result.verified, false);
      assert.ok(result.observations[0].error);
    });
    await t.test('missing verifier cannot produce verified evidence', async () => {
      process.env.MINISIGN_BIN = join(directory, 'missing');
      const result = await verifyDownloads(input);
      assert.equal(result.verified, false);
      assert.match(result.observations[0].error, /ENOENT/);
      delete process.env.MINISIGN_BIN;
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBin === undefined) delete process.env.MINISIGN_BIN;
    else process.env.MINISIGN_BIN = originalBin;
    await rm(directory, { recursive: true, force: true });
  }
});
