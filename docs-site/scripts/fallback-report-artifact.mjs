import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Read the sole expected JSON member without extracting archive paths to disk.
export async function readGenerationArtifact(artifact) {
  if (artifact.expired !== false || !Number.isSafeInteger(artifact.id) || artifact.id <= 0
    || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0
    || artifact.size_in_bytes > 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || ''))
    throw new Error('Invalid or unavailable generation artifact');
  const response = await fetch(`https://api.github.com/repos/sleep2agi/agent-network/actions/artifacts/${artifact.id}/zip`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'anet-fallback-report',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Generation artifact download failed: ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > artifact.size_in_bytes || size > 1024 * 1024) throw new Error('Generation archive exceeds bound');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (size !== artifact.size_in_bytes || digest !== artifact.digest) throw new Error('Generation archive digest/size mismatch');
  const directory = await mkdtemp(join(tmpdir(), 'anet-generation-artifact-'));
  try {
    const path = join(directory, 'artifact.zip');
    await writeFile(path, bytes);
    const options = { timeout: 10000, maxBuffer: 65536 };
    const listing = await exec('unzip', ['-Z1', path], options);
    if (listing.stdout.trim() !== 'fallback-generation.json') throw new Error('Unexpected generation archive members');
    const content = await exec('unzip', ['-p', path, 'fallback-generation.json'], options);
    return { record: JSON.parse(content.stdout), archiveDigest: digest };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
