/**
 * Everything about externally hosted media (images / videos) that admins paste
 * into the dashboard: product images, slider images, event banners,
 * notification images and custom-ad videos.
 *
 * Remote images are handled in two independent layers:
 *
 * 1. Hosts listed in `IMAGE_HOST_PATTERNS` (plus `NEXT_PUBLIC_IMAGE_HOSTS`) feed
 *    `images.remotePatterns` in next.config.ts. Only these hosts may be fetched
 *    by the server-side optimizer (`/_next/image`), which resizes and converts
 *    them to WebP. That endpoint is public, so every host here is a host we are
 *    willing to proxy/resize for anybody. Keep it to reputable CDNs and storage
 *    providers and never use a bare `**` — that turns the optimizer into an
 *    open image proxy (SSRF / resource-abuse vector).
 *
 * 2. Every other host still works. `<SmartImage>` renders those images
 *    `unoptimized`, so the browser downloads them directly from the source,
 *    exactly like a plain <img>. The server never touches those URLs.
 *
 * To let the optimizer handle your own domain (e.g. a Cloudflare R2 custom
 * domain) set the build-time env var, comma separated:
 *   NEXT_PUBLIC_IMAGE_HOSTS="cdn.example.com, *.images.example.com"
 *
 * Pattern syntax matches Next.js `remotePatterns.hostname`: a literal hostname,
 * or `*` / `**` as a wildcard for the leading part (`*.r2.dev` also matches
 * `a.b.r2.dev`). The module is imported by next.config.ts, so it must stay free
 * of framework / browser-only imports.
 */

/** Hosts the server-side image optimizer is allowed to fetch from (https only). */
export const IMAGE_HOST_PATTERNS: readonly string[] = [
  // Already used by this project
  'placehold.co',
  'drive.google.com',
  '*.postimg.cc',
  'rzp.io',
  'res.cloudinary.com',

  // Cloudflare
  '*.r2.dev', // R2 public bucket URLs (pub-<id>.r2.dev)
  '*.r2.cloudflarestorage.com', // R2 S3-compatible endpoint (pre-signed URLs)
  'imagedelivery.net', // Cloudflare Images

  // Image CDNs
  'ik.imagekit.io',
  '*.imgix.net',
  '*.b-cdn.net', // Bunny CDN

  // Object storage / general CDNs
  '*.amazonaws.com', // S3
  '*.cloudfront.net',
  'storage.googleapis.com',
  'firebasestorage.googleapis.com',
  '*.googleusercontent.com',
  '*.supabase.co',
  '*.public.blob.vercel-storage.com',
  '*.ufs.sh', // UploadThing
  'utfs.io',
  '*.backblazeb2.com',
  '*.digitaloceanspaces.com',

  // Popular free image hosts
  'i.ibb.co',
  'i.imgur.com',
  'images.unsplash.com',
  '*.githubusercontent.com',
];

/** Extensions that are rendered with a <video> tag instead of an image. */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogv', '.mov', '.m4v'];

const MAX_URL_LENGTH = 2048;

/** Error message shared by the admin forms that accept a media URL. */
export const MEDIA_URL_ERROR =
  'Must be a valid http(s) link, e.g. https://example.com/image.png';

const HOST_PATTERN_RE = /^[a-z0-9.*-]+$/;

/**
 * Parses NEXT_PUBLIC_IMAGE_HOSTS. Tolerates full URLs ("https://cdn.x.com/")
 * and whitespace; ignores entries that are not valid host patterns.
 * Read as a literal `process.env.NEXT_PUBLIC_…` expression so Next.js can
 * inline it into the browser bundle as well.
 */
function extraHostPatternsFromEnv(): string[] {
  const raw = process.env.NEXT_PUBLIC_IMAGE_HOSTS ?? '';
  const patterns: string[] = [];
  for (const entry of raw.split(/[,\s]+/)) {
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '') // strip protocol
      .replace(/[/?#].*$/, '') // strip path / query
      .replace(/:\d+$/, ''); // strip port
    if (!host) continue;
    if (/^\*+$/.test(host)) {
      console.warn(
        `[media-urls] Ignoring "${entry}" in NEXT_PUBLIC_IMAGE_HOSTS: a bare wildcard would turn /_next/image into an open proxy.`
      );
      continue;
    }
    if (!HOST_PATTERN_RE.test(host)) {
      console.warn(`[media-urls] Ignoring invalid host pattern "${entry}" in NEXT_PUBLIC_IMAGE_HOSTS.`);
      continue;
    }
    patterns.push(host);
  }
  return patterns;
}

let cachedHostPatterns: string[] | undefined;

/** Built-in patterns plus the ones from the environment, de-duplicated. */
export function getImageHostPatterns(): string[] {
  if (!cachedHostPatterns) {
    cachedHostPatterns = Array.from(new Set([...IMAGE_HOST_PATTERNS, ...extraHostPatternsFromEnv()]));
  }
  return cachedHostPatterns;
}

/** Value for `images.remotePatterns` in next.config.ts. */
export function getImageRemotePatterns(): Array<{ protocol: 'https'; hostname: string }> {
  return getImageHostPatterns().map((hostname) => ({ protocol: 'https', hostname }));
}

const patternRegexCache = new Map<string, RegExp>();

/**
 * Compiles a hostname pattern to a RegExp with exactly the semantics Next.js
 * uses server-side (picomatch): a `*` run may span several labels; a leading
 * `*` must additionally be non-empty and must not start with a dot. Literal
 * characters are escaped.
 */
function hostPatternToRegExp(pattern: string): RegExp {
  let regex = patternRegexCache.get(pattern);
  if (!regex) {
    const literals = pattern.split(/\*+/);
    let source = '';
    literals.forEach((literal, index) => {
      if (index > 0) {
        const isLeadingWildcard = index === 1 && literals[0] === '';
        source += isLeadingWildcard ? '(?!\\.)(?=.)[^/]*?' : '[^/]*?';
      }
      source += literal.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    });
    regex = new RegExp(`^(?:${source})$`);
    patternRegexCache.set(pattern, regex);
  }
  return regex;
}

/** True when `hostname` matches one of the given hostname patterns. */
export function matchesHostPattern(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return patterns.some((pattern) => hostPatternToRegExp(pattern).test(host));
}

/**
 * Should this `src` go through the Next.js image optimizer?
 *
 * - Local paths (`/img/...`) and inline data/blob URLs: yes (Next.js handles
 *   these itself; data/blob are automatically served unoptimized).
 * - `https://` URLs on an allow-listed host: yes.
 * - Anything else (unknown host, `http://`, malformed): no — render it
 *   `unoptimized` so the browser loads it directly.
 */
export function isOptimizableImageSrc(src: string): boolean {
  if (typeof src !== 'string' || src.length === 0) return false;
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;
  if (src.startsWith('/')) return !src.startsWith('//');

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return matchesHostPattern(url.hostname, getImageHostPatterns());
}

/** Pathname of an absolute or site-relative URL, ignoring query string and hash. */
function pathnameOf(src: string): string {
  try {
    return new URL(src, 'http://local.invalid').pathname;
  } catch {
    return src.split(/[?#]/, 1)[0];
  }
}

/** True for URLs that should be rendered with a <video> element. */
export function isVideoUrl(src: string): boolean {
  if (typeof src !== 'string' || src.length === 0) return false;
  const path = pathnameOf(src).toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * Server-side validation for admin-supplied media links: must be an absolute
 * http(s) URL with a hostname, no embedded credentials and a sane length.
 * Any host is accepted on purpose — the allow-list above only decides whether
 * the optimizer is used, not whether an image may be shown.
 */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}
