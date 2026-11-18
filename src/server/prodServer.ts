import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { createApiMiddleware } from './apiPlugin';
import { applySocialMetaUrls, resolvePublicOrigin } from './socialMeta';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);
}

async function resolveStaticFile(distRoot: string, rawPathname: string): Promise<string | null> {
  const relPath = rawPathname === '/' ? 'index.html' : rawPathname.replace(/^\/+/, '');
  const candidate = path.resolve(distRoot, relPath);
  if (!isWithinRoot(candidate, distRoot)) {
    return null;
  }

  try {
    const st = await fs.stat(candidate);
    if (st.isFile()) {
      const real = await fs.realpath(candidate);
      return isWithinRoot(real, distRoot) ? real : null;
    }
  } catch {
    // fall through to SPA fallback check
  }

  // SPA navigation fallback only for extensionless routes
  if (!path.posix.basename(relPath).includes('.')) {
    const indexPath = path.join(distRoot, 'index.html');
    try {
      const real = await fs.realpath(indexPath);
      return isWithinRoot(real, distRoot) ? real : null;
    } catch {
      return null;
    }
  }

  return null;
}

async function startProdServer(): Promise<void> {
  const distDir = path.resolve(process.cwd(), 'dist');
  const distRoot = await fs.realpath(distDir);
  const apiMiddleware = createApiMiddleware();

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.url?.startsWith('/api/')) {
        await apiMiddleware(req, res, () => {
          res.statusCode = 404;
          res.end('Not found');
        });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Method Not Allowed');
        return;
      }

      let rawPathname: string;
      try {
        const parsed = new URL(req.url ?? '/', 'http://localhost');
        rawPathname = decodeURIComponent(parsed.pathname);
      } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Bad Request');
        return;
      }

      const filePath = await resolveStaticFile(distRoot, rawPathname);
      if (!filePath) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found');
        return;
      }

      let data = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.html') {
        const origin = resolvePublicOrigin(req.headers);
        data = Buffer.from(applySocialMetaUrls(data.toString('utf8'), origin), 'utf8');
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
      res.setHeader('Content-Length', String(data.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Cache-Control',
        rawPathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : ext === '.html'
            ? 'no-cache'
            : 'public, max-age=3600'
      );

      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(data);
    })().catch((err) => {
      console.error('[osrs-prod-server]', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error');
      } else {
        res.end();
      }
    });
  });

  const host = process.env.HOST || '0.0.0.0';
  const parsedPort = Number(process.env.PORT || 5173);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 5173;

  server.listen(port, host, () => {
    console.log(`OSRS Chathead Generator server listening on http://${host}:${port}`);
  });
}

void startProdServer();
