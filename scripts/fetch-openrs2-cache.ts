import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import { buildStarterCache } from '../src/shared/cache/StarterCacheBuilder';

const CACHE_DIR = path.resolve(process.cwd(), 'cache');

export interface OpenRs2CacheEntry {
  id: number;
  scope: string;
  game: string;
  environment?: string;
  timestamp: string | null;
  builds: Array<{ major: number; minor?: number }>;
  valid_indexes?: number;
  indexes?: number;
}

export function pickBestOpenRs2Cache(
  caches: OpenRs2CacheEntry[],
  requestedId?: string
): OpenRs2CacheEntry | undefined {
  if (requestedId) {
    return caches.find((c) => String(c.id) === requestedId);
  }

  const candidates = caches.filter(
    (c) =>
      c.game === 'oldschool' &&
      c.scope === 'runescape' &&
      c.builds.length > 0 &&
      (c.valid_indexes === undefined || c.valid_indexes >= 20)
  );

  const pool =
    candidates.length > 0
      ? candidates
      : caches.filter((c) => c.game === 'oldschool' && c.builds.length > 0);

  pool.sort((a, b) => {
    const tA = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tB = b.timestamp ? Date.parse(b.timestamp) : 0;
    if (tA !== tB) return tB - tA;
    const bA = a.builds[0]?.major ?? 0;
    const bB = b.builds[0]?.major ?? 0;
    return bB - bA;
  });

  return pool[0];
}

async function writeStarterCache(force: boolean): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const targetMarker = path.join(CACHE_DIR, 'main_file_cache.dat2');
  if (!force) {
    try {
      await fs.access(targetMarker);
      console.log(`Cache already present at ${CACHE_DIR}`);
      return;
    } catch {
      // proceed
    }
  }

  const built = buildStarterCache();
  for (const [name, data] of built.dat2Files.entries()) {
    await fs.writeFile(path.join(CACHE_DIR, name), data);
  }
  console.log(`Starter .dat2/.idx* cache written to ${CACHE_DIR}`);
}

async function fetchOpenRs2Cache(requestedId?: string): Promise<void> {
  console.log('Querying OpenRS2 cache archive list...');
  const listRes = await fetch('https://archive.openrs2.org/caches.json');
  if (!listRes.ok) {
    throw new Error(`OpenRS2 list request failed: ${listRes.status}`);
  }
  const caches = (await listRes.json()) as OpenRs2CacheEntry[];
  const chosen = pickBestOpenRs2Cache(caches, requestedId);

  if (!chosen) {
    throw new Error('Could not find matching Old School RuneScape cache on OpenRS2.');
  }

  const zipUrl = `https://archive.openrs2.org/caches/${encodeURIComponent(chosen.scope || 'runescape')}/${chosen.id}/disk.zip`;
  console.log(
    `Downloading OpenRS2 OSRS cache #${chosen.id} (rev ${chosen.builds[0]?.major ?? '?'}, timestamp ${chosen.timestamp ?? 'unknown'}) from ${zipUrl}...`
  );

  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) {
    throw new Error(`Failed to download disk.zip: ${zipRes.status}`);
  }
  const zipBuf = new Uint8Array(await zipRes.arrayBuffer());
  console.log(`Extracting ${(zipBuf.byteLength / (1024 * 1024)).toFixed(1)} MB archive...`);

  const files = unzipSync(zipBuf);
  await fs.mkdir(CACHE_DIR, { recursive: true });
  let count = 0;
  for (const [entryPath, content] of Object.entries(files)) {
    if (content.length === 0) continue;
    const base = path.basename(entryPath);
    if (base.startsWith('main_file_cache.') || base === 'xteas.json') {
      await fs.writeFile(path.join(CACHE_DIR, base), content);
      count++;
    }
  }
  console.log(`Extracted ${count} cache files into ${CACHE_DIR}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const openrs2Idx = args.indexOf('--openrs2');
  const force = args.includes('--force');

  if (openrs2Idx !== -1) {
    const idArg = args[openrs2Idx + 1];
    await fetchOpenRs2Cache(idArg && !idArg.startsWith('--') ? idArg : undefined);
  } else {
    await writeStarterCache(force);
  }
}

if (process.argv[1]?.includes('fetch-openrs2-cache')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
