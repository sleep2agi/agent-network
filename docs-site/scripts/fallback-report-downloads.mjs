import { createHash } from 'node:crypto';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// The caller supplies a public key from the exact release source, never PR code.
// No credentials are sent when downloading assets. Missing minisign fails closed.
export async function verifyDownloads({ candidate, release, publicKey }) {
  const directory = await mkdtemp(join(tmpdir(), 'anet-fallback-verify-'));
  const observations = [];
  try {
    await writeFile(join(directory, 'release.pub'), Buffer.from(publicKey, 'base64'));
    const entries = Object.values(candidate.platforms || {});
    const urls = [...new Set(entries.map(entry => entry.url))];
    if (urls.length === 0 || urls.length > 20) throw new Error('Invalid package count');
    for (const [index, url] of urls.entries()) {
      const observation = { url, verified: false };
      observations.push(observation);
      try {
        const assets = release.assets.filter(asset => asset.browser_download_url === url);
        if (typeof url !== 'string' || !url.startsWith(`https://github.com/sleep2agi/agent-network-app/releases/download/desktop-v${candidate.version}/`)
          || assets.length !== 1) throw new Error('Unbound package URL');
        const asset = assets[0];
        observation.assetId = asset.id;
        if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3
          || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('Missing bounded asset metadata');
        const signatures = entries.filter(entry => entry.url === url).map(entry => entry.signature);
        if (signatures.some(signature => typeof signature !== 'string' || signature.length > 65536
          || signature !== signatures[0])) throw new Error('Invalid or inconsistent signatures');
        const path = join(directory, `package-${index}`);
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`Package download failed: ${response.status}`);
        const handle = await open(path, 'wx');
        const hash = createHash('sha256');
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > asset.size) throw new Error('Asset exceeds expected size');
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
        } finally { await handle.close(); }
        observation.size = size;
        observation.digest = `sha256:${hash.digest('hex')}`;
        if (size !== asset.size || observation.digest !== asset.digest)
          throw new Error('Package size or digest mismatch');
        await writeFile(`${path}.minisig`, Buffer.from(signatures[0], 'base64'));
        const result = await exec(process.env.MINISIGN_BIN || 'minisign',
          ['-Vm', path, '-p', join(directory, 'release.pub'), '-x', `${path}.minisig`],
          { timeout: 30000, maxBuffer: 65536 });
        observation.verificationOutput = result.stdout;
        observation.verified = true;
      } catch (error) { observation.error = error.message; }
    }
    return { verified: observations.every(observation => observation.verified), observations };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
