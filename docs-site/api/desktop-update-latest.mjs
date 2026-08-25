const RELEASES_URL = 'https://api.github.com/repos/sleep2agi/agent-network-app/releases?per_page=50';
const FALLBACK_URL = 'https://www.anet.sh/desktop/update/fallback.json';

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

const validManifest = (manifest, version) => manifest?.version === version
  && typeof manifest.platforms?.['darwin-aarch64']?.signature === 'string'
  && typeof manifest.platforms?.['windows-x86_64']?.signature === 'string';

const useBrowserDownloadUrls = (manifest, release) => {
  const downloads = new Map(release.assets.map((asset) => [asset.url, asset.browser_download_url]));
  const platforms = Object.fromEntries(Object.entries(manifest.platforms).map(([name, entry]) => {
    const direct = downloads.get(entry.url);
    if (!direct) throw new Error(`no browser download URL for ${name}`);
    return [name, { ...entry, url: direct }];
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
    const releases = await fetchJson(fetchImpl, RELEASES_URL, {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'anet-desktop-updater',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    const selected = selectDesktopRelease(releases);
    if (!selected) throw new Error('no published desktop release has latest.json');
    const manifest = await fetchJson(fetchImpl, selected.manifest.url, {
      Accept: 'application/octet-stream',
      'User-Agent': 'anet-desktop-updater',
    });
    if (!validManifest(manifest, selected.version.text)) {
      throw new Error('release manifest does not match its tag or lacks signatures');
    }
    return {
      manifest: useBrowserDownloadUrls(manifest, selected.release),
      source: selected.release.tag_name,
    };
  } catch (error) {
    const manifest = await fetchJson(fetchImpl, FALLBACK_URL);
    if (!validManifest(manifest, manifest.version)) throw error;
    return { manifest, source: 'fallback' };
  }
};

export default async function handler(_request, response) {
  try {
    const { manifest, source } = await resolveDesktopUpdate();
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=300');
    response.setHeader('X-Anet-Update-Source', source);
    response.status(200).json(manifest);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    response.status(503).json({ error: 'desktop_update_unavailable' });
  }
}
