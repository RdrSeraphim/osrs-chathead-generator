import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileMapProvider } from '../shared/cache/types';

export class NodeFileMapProvider implements FileMapProvider {
  constructor(public readonly rootDir: string) {}

  async getFile(name: string): Promise<Uint8Array | undefined> {
    const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(this.rootDir, clean);
    if (!full.startsWith(path.resolve(this.rootDir))) {
      return undefined;
    }
    try {
      const buf = await fs.readFile(full);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return undefined;
    }
  }

  async listFiles(): Promise<string[]> {
    const results: string[] = [];
    const topEntries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const ent of topEntries) {
      if (ent.isFile()) {
        results.push(ent.name);
      }
    }

    // Fast path if standard disk cache or flatcache is right at root
    const hasRootCache = results.some(
      (f) =>
        f === 'main_file_cache.dat2' ||
        f === 'main_file_cache.dat' ||
        /^\d+\.flatcache$/.test(f)
    );
    if (hasRootCache) {
      return results;
    }

    // Check 1 level deep and relevant cache subdirectories (0, 1, 2, 7, models, cache)
    const walkDirs = topEntries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const sub of walkDirs) {
      const subPath = path.join(this.rootDir, sub);
      try {
        const children = await fs.readdir(subPath, { withFileTypes: true });
        for (const ch of children) {
          if (ch.isFile()) {
            results.push(`${sub}/${ch.name}`);
          } else if (ch.isDirectory() && /^(0|1|2|7|models?|cache)$/i.test(sub)) {
            const deep = await fs.readdir(path.join(subPath, ch.name), { withFileTypes: true });
            for (const d of deep) {
              if (d.isFile()) {
                results.push(`${sub}/${ch.name}/${d.name}`);
              }
            }
          }
        }
      } catch {
        // ignore unreadable subdirectory
      }
    }

    return results;
  }
}
