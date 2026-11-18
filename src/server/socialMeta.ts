import type * as http from 'node:http';

const HOSTNAME_OR_IPV4_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i;
const IPV6_HOST_RE = /^\[[0-9a-f:]+\](?::\d{1,5})?$/i;

function firstHeaderToken(value: string | string[] | undefined): string {
  if (!value) return '';
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? '').split(',')[0].trim();
}

function isValidHostHeader(rawHost: string): boolean {
  if (!rawHost) return false;
  if (!HOSTNAME_OR_IPV4_RE.test(rawHost) && !IPV6_HOST_RE.test(rawHost)) {
    return false;
  }
  const portMatch = /^\[[^\]]+\]:(\d+)$|^[^:\]]+:(\d+)$/.exec(rawHost);
  if (portMatch) {
    const port = Number(portMatch[1] ?? portMatch[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return false;
    }
  }
  return true;
}

/**
 * Parse and normalize an HTTP/HTTPS origin, stripping paths/queries/credentials.
 */
export function normalizePublicOrigin(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    if (!parsed.origin || parsed.origin === 'null') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical public origin from PUBLIC_URL or request/proxy headers.
 */
export function resolvePublicOrigin(
  headers: http.IncomingHttpHeaders,
  env?: { publicUrl?: string; trustProxy?: boolean }
): string | null {
  const configuredPublicUrl =
    env && 'publicUrl' in env ? env.publicUrl : process.env.PUBLIC_URL;
  const envOrigin = normalizePublicOrigin(configuredPublicUrl);
  if (envOrigin) {
    return envOrigin;
  }

  const trustProxy = env?.trustProxy ?? process.env.TRUST_PROXY === '1';
  const forwardedHost = trustProxy ? firstHeaderToken(headers['x-forwarded-host']) : '';
  const directHost = Array.isArray(headers.host)
    ? (headers.host[0] ?? '').trim()
    : (headers.host ?? '').trim();
  const rawHost = forwardedHost || directHost;

  if (!isValidHostHeader(rawHost)) {
    return null;
  }

  let proto = 'http';
  if (trustProxy) {
    const forwardedProto = firstHeaderToken(headers['x-forwarded-proto']).toLowerCase();
    if (forwardedProto === 'https' || forwardedProto === 'http') {
      proto = forwardedProto;
    }
  }

  return normalizePublicOrigin(`${proto}://${rawHost}`);
}

/**
 * Rewrite relative Open Graph / Twitter Card image URLs and inject canonical/og:url tags.
 */
export function applySocialMetaUrls(html: string, origin: string | null): string {
  const safeOrigin = normalizePublicOrigin(origin ?? undefined);
  if (!safeOrigin) {
    return html;
  }

  let out = html.replace(
    /(<meta\s+(?:property="og:image"|name="twitter:image")\s+content=")\/og-image\.png("\s*\/?>)/gi,
    `$1${safeOrigin}/og-image.png$2`
  );

  if (!/<meta\s+property=["']og:url["']/i.test(out)) {
    const canonicalAndOgUrl =
      `    <link rel="canonical" href="${safeOrigin}/" />\n` +
      `    <meta property="og:url" content="${safeOrigin}/" />\n`;
    out = out.replace(/<\/head>/i, `${canonicalAndOgUrl}  </head>`);
  }

  return out;
}
