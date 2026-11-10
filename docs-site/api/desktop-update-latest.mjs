export const DESKTOP_RELEASES_URL = 'https://api.github.com/repos/sleep2agi/agent-network-app/releases?per_page=50';
export const DESKTOP_UPDATE_FALLBACK_URL = 'https://www.anet.sh/desktop/update/fallback.json';
export const GITHUB_JSON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'anet-desktop-updater',
  'X-GitHub-Api-Version': '2022-11-28',
};

const parseVersion = (tag) => {
  const match = /^desktop-v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!match) return null;
  return {
    text: tag.slice('desktop-v'.length),
    core: match.slice(1, 4).map(Number),
    pre: match[4]?.split('.') ?? null,
  };
};

const compareIdentifiers = (left, right) => {
  const numericLeft = /^\d+$/.test(left);
  const numericRight = /^\d+$/.test(right);
  if (numericLeft && numericRight) return Number(left) - Number(right);
  if (numericLeft !== numericRight) return numericLeft ? -1 : 1;
  return left.localeCompare(right);
};

export const compareDesktopVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.pre === null || right.pre === null) {
    if (left.pre === right.pre) return 0;
    return left.pre === null ? 1 : -1;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    const compared = compareIdentifiers(left.pre[index], right.pre[index]);
    if (compared !== 0) return compared;
  }
  return 0;
};

export const selectDesktopRelease = (releases) => releases
  .filter((release) => !release.draft)
  .map((release) => ({
    release,
    version: parseVersion(release.tag_name),
    manifest: release.assets?.find((asset) => asset.name === 'latest.json'),
  }))
  .filter((candidate) => candidate.version && candidate.manifest)
  .sort((left, right) => compareDesktopVersions(right.version, left.version))[0] ?? null;

// A release can legitimately exist with only one platform built: on 2026-11-08 the
// Windows bundler spent an hour failing on external 5xx while macOS had already been
// signed and published. Demanding both signatures then made a correct macOS release
// invisible and forced the endpoint back to the previous version, so owners saw
// "no update" for a build that existed.
//
// The rule now: the manifest must match its tag, every platform it *does* carry must
// have a signature and map to a real asset of that release, and at least one of the
// two desktop platforms must be present. A platform that is absent simply means this
// release has no build for it; Tauri treats a missing platform key as "no update"
// rather than as an error, so other platforms are not offered a wrong artifact.
const validManifest = (manifest, version, release) => {
  if (manifest?.version !== version) return false;
  const platforms = manifest?.platforms ?? {};
  const present = ['darwin-aarch64', 'windows-x86_64'].filter((name) => name in platforms);
  if (present.length === 0) return false;
  const assets = new Set((release?.assets ?? []).map((asset) => asset.name));
  return present.every((name) => {
    const entry = platforms[name];
    if (typeof entry?.signature !== 'string' || typeof entry?.url !== 'string') return false;
    const file = entry.url.slice(entry.url.lastIndexOf('/') + 1);
    // assets present in the release object are authoritative; a manifest that points at
    // an asset this release does not have is a broken manifest, not a partial release.
    return file.length > 0 && (assets.has(file) || /[?&]/.test(entry.url));
  });
};

// Manifests used to carry `api.github.com/.../releases/assets/<id>` URLs, so this
// function translated them through the release's asset list. Since #1034 the release
// workflow normalizes `latest.json` to public `releases/download/<tag>/<file>` links
// *before* publishing, so there is nothing to translate: without the pass-through
// below every platform lookup threw and the endpoint silently served the stale
// fallback (0.2.287 was published while /desktop/update/latest.json still said
// 0.2.286, `x-anet-update-source: fallback`).
const isPublicDownloadUrl = (url) => typeof url === 'string'
  && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(url);

const useBrowserDownloadUrls = (manifest, release) => {
  const downloads = new Map(release.assets.map((asset) => [asset.url, asset.browser_download_url]));
  const platforms = Object.fromEntries(Object.entries(manifest.platforms).map(([name, entry]) => {
    const direct = downloads.get(entry.url);
    if (direct) return [name, { ...entry, url: direct }];
    if (isPublicDownloadUrl(entry.url)) return [name, entry];
    throw new Error(`no browser download URL for ${name}`);
  }));
  return { ...manifest, platforms };
};

const fetchJson = async (fetchImpl, url, headers = {}) => {
  const response = await fetchImpl(url, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

export const resolveDesktopUpdate = async (fetchImpl = fetch) => {
  try {
    const releases = await fetchJson(fetchImpl, DESKTOP_RELEASES_URL, GITHUB_JSON_HEADERS);
    const selected = selectDesktopRelease(releases);
    if (!selected) throw new Error('no published desktop release has latest.json');
    const manifest = await fetchJson(fetchImpl, selected.manifest.url, {
      Accept: 'application/octet-stream',
      'User-Agent': 'anet-desktop-updater',
    });
    if (!validManifest(manifest, selected.version.text, selected.release)) {
      throw new Error('release manifest does not match its tag, points at a missing asset, or carries no signed platform');
    }
    return {
      manifest: useBrowserDownloadUrls(manifest, selected.release),
      source: selected.release.tag_name,
    };
  } catch (error) {
    const manifest = await fetchJson(fetchImpl, DESKTOP_UPDATE_FALLBACK_URL);
    if (!validManifest(manifest, manifest.version, { assets: Object.values(manifest.platforms ?? {}).map((entry) => ({ name: String(entry?.url ?? '').slice(String(entry?.url ?? '').lastIndexOf('/') + 1) })) })) throw error;
    return { manifest, source: 'fallback' };
  }
};

// The desktop shell can run the app from a different origin (web build, dev
// server, packaged app). Without an explicit allow-origin the browser blocks
// the response and the app can only say "update server unavailable" even
// though the endpoint answers 200 for curl. https://anet.sh also 307s to
// www.anet.sh, so the final response is the one that must carry the header.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};

export default async function handler(request, response) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) response.setHeader(name, value);
  if (request?.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  try {
    const { manifest, source } = await resolveDesktopUpdate();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Manual update checks must never reuse a manifest fetched before a new
    // release was published. A cached old manifest is indistinguishable from
    // "already up to date" to the Tauri updater.
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-Anet-Update-Source', source);
    response.status(200).json(manifest);
  } catch (error) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.status(503).json({ error: 'desktop_update_unavailable' });
  }
}
