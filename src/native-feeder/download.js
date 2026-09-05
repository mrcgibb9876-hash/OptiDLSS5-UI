// Shared download helper for the native Feeder installer. Cached: a second install of the same
// piece is a filesystem copy, not a re-download, same as the original script's own cache folder.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const GITHUB_HEADERS = { 'User-Agent': 'OptiScaler-Manager', Accept: 'application/vnd.github+json' };

async function downloadToCache(url, cacheDir, fileName, { headers } = {}) {
  const dest = path.join(cacheDir, fileName);
  if (fs.existsSync(dest)) return dest;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 64) throw new Error(`download produced no usable data: ${url}`);

  await fsp.mkdir(cacheDir, { recursive: true });
  const tmp = dest + '.part';
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, dest);
  return dest;
}

// Resolves a GitHub release's download asset by name pattern -- the same "fetch, sort by
// published_at, pick the first asset whose name matches" shape src/feeder.js already uses for the
// installer script's own release, just pointed at a real file asset instead of a .ps1.
async function resolveGithubAsset(releasesApiUrl, assetPattern) {
  const res = await fetch(`${releasesApiUrl}/latest`, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(15000) });
  let releases;
  if (res.ok) {
    releases = [await res.json()];
  } else {
    const listRes = await fetch(`${releasesApiUrl}?per_page=10`, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!listRes.ok) throw new Error(`could not list releases: HTTP ${listRes.status}`);
    releases = await listRes.json();
  }

  const sorted = releases
    .filter((r) => r && !r.draft && Array.isArray(r.assets))
    .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

  for (const rel of sorted) {
    const asset = rel.assets.find((a) => assetPattern.test(a.name));
    if (asset) return { url: asset.browser_download_url, name: asset.name, tag: rel.tag_name };
  }
  throw new Error('no matching release asset found');
}

module.exports = { downloadToCache, resolveGithubAsset, GITHUB_HEADERS };
