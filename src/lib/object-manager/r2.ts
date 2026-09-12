/**
 * Server-side access to the Cloudflare R2 bucket behind the admin Object
 * Manager. Uses R2's S3-compatible API. Only import this from server code
 * (server actions, route handlers, server components): it reads secrets.
 *
 * Required env vars (see the setup notice in the admin page):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
 *   R2_PUBLIC_BASE_URL (the bucket's custom domain, e.g. https://cdn.tofo.in)
 * Optional:
 *   R2_IMAGE_TRANSFORM      option string for "copy link" (default: format=auto)
 *   R2_THUMBNAIL_TRANSFORM  option string for grid previews
 *                           (default: width=320,quality=70,format=auto)
 */

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  ALLOWED_UPLOADS,
  OBJECT_MANAGER_LIMITS,
  extensionOf,
  kindOf,
  type ListResult,
  type ObjectFile,
  type ObjectFolder,
  type ObjectKind,
  type SearchResult,
} from './types';

export { sanitizeFolderName } from './types';

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'] as const;

export interface ObjectManagerConfig {
  configured: boolean;
  missing: string[];
  bucket: string;
  publicBaseUrl: string;
  imageTransform: string;
  thumbnailTransform: string;
}

const env = (name: string) => (process.env[name] ?? '').trim();

export function getObjectManagerConfig(): ObjectManagerConfig {
  const missing = REQUIRED_ENV.filter((name) => env(name) === '');
  return {
    configured: missing.length === 0,
    missing,
    bucket: env('R2_BUCKET'),
    publicBaseUrl: env('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
    imageTransform: env('R2_IMAGE_TRANSFORM') || 'format=auto',
    thumbnailTransform: env('R2_THUMBNAIL_TRANSFORM') || 'width=320,quality=70,format=auto',
  };
}

let client: S3Client | undefined;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env('R2_ACCESS_KEY_ID'), secretAccessKey: env('R2_SECRET_ACCESS_KEY') },
      // R2 does not support the newer default request checksums of the AWS SDK.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Key validation and naming
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Accepts keys of objects that already exist (spaces, capitals…) but rejects path tricks. */
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) return false;
  if (key.startsWith('/') || key.includes('//') || key.includes('\\')) return false;
  if (CONTROL_CHARS.test(key)) return false;
  return !key.split('/').some((segment) => segment === '.' || segment === '..');
}

/** "" (root) or a safe key ending with "/". */
export function isSafePrefix(prefix: string): boolean {
  return prefix === '' || (isSafeKey(prefix) && prefix.endsWith('/'));
}

/** Splits an upload name into a clean base and an allowed extension, or null. */
export function sanitizeFileName(name: string): { base: string; ext: string } | null {
  const rawExt = extensionOf(name);
  if (!(rawExt in ALLOWED_UPLOADS)) return null;
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt;
  const withoutExt = name.slice(name.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const base =
    withoutExt
      .toLowerCase()
      .replace(/[^a-z0-9 ._-]/g, '')
      .replace(/\.+/g, '.')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 80) || 'file';
  return { base, ext };
}

/** Sniffs the real file type from magic bytes; returns an extension key of ALLOWED_UPLOADS or null. */
export function sniffExtension(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 4 && ascii(0, 4) === 'GIF8') return 'gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return brand.startsWith('avi') ? 'avif' : 'mp4';
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm';
  return null;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function buildObjectFile(
  cfg: ObjectManagerConfig,
  key: string,
  size: number,
  lastModified: Date | undefined
): ObjectFile {
  const kind: ObjectKind = kindOf(key);
  const slash = key.lastIndexOf('/');
  const path = encodeKeyPath(key);
  const url = `${cfg.publicBaseUrl}/${path}`;
  return {
    key,
    name: key.slice(slash + 1),
    folder: slash >= 0 ? key.slice(0, slash + 1) : '',
    size,
    lastModified: (lastModified ?? new Date(0)).toISOString(),
    kind,
    url,
    optimizedUrl: kind === 'image' ? `${cfg.publicBaseUrl}/cdn-cgi/image/${cfg.imageTransform}/${path}` : url,
    thumbnailUrl: kind === 'image' ? `${cfg.publicBaseUrl}/cdn-cgi/image/${cfg.thumbnailTransform}/${path}` : null,
  };
}

// ---------------------------------------------------------------------------
// Bucket operations
// ---------------------------------------------------------------------------

/** All sub-folders directly under `prefix` (scans up to 10 pages of 1000 keys). */
export async function listFolders(cfg: ObjectManagerConfig, prefix: string): Promise<ObjectFolder[]> {
  const found = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await getClient().send(
      new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1000, ContinuationToken: token })
    );
    for (const p of res.CommonPrefixes ?? []) if (p.Prefix) found.add(p.Prefix);
    if (!res.IsTruncated || !res.NextContinuationToken) break;
    token = res.NextContinuationToken;
  }
  return Array.from(found)
    .sort()
    .map((p) => ({ prefix: p, name: p.slice(prefix.length).replace(/\/$/, '') }));
}

/** One page of files directly under `prefix` (folder placeholders excluded). */
export async function listFiles(
  cfg: ObjectManagerConfig,
  prefix: string,
  cursor?: string | null
): Promise<{ files: ObjectFile[]; nextCursor: string | null }> {
  const res = await getClient().send(
    new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: OBJECT_MANAGER_LIMITS.listPageSize,
      ContinuationToken: cursor || undefined,
    })
  );
  const files = (res.Contents ?? [])
    .filter((o) => o.Key && !o.Key.endsWith('/'))
    .map((o) => buildObjectFile(cfg, o.Key!, o.Size ?? 0, o.LastModified));
  return { files, nextCursor: res.IsTruncated ? res.NextContinuationToken ?? null : null };
}

export async function listLevel(cfg: ObjectManagerConfig, prefix: string, cursor?: string | null): Promise<ListResult> {
  const [folders, page] = await Promise.all([
    cursor ? Promise.resolve<ObjectFolder[]>([]) : listFolders(cfg, prefix),
    listFiles(cfg, prefix, cursor),
  ]);
  return { prefix, folders, files: page.files, nextCursor: page.nextCursor };
}

/** Case-insensitive name search under `prefix`, including sub-folders. */
export async function searchObjects(cfg: ObjectManagerConfig, prefix: string, query: string): Promise<SearchResult> {
  const needle = query.trim().toLowerCase();
  const files: ObjectFile[] = [];
  let scanned = 0;
  let token: string | undefined;
  let truncated = false;
  while (true) {
    const res = await getClient().send(
      new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token })
    );
    for (const o of res.Contents ?? []) {
      scanned++;
      if (!o.Key || o.Key.endsWith('/')) continue;
      if (o.Key.slice(prefix.length).toLowerCase().includes(needle)) {
        files.push(buildObjectFile(cfg, o.Key, o.Size ?? 0, o.LastModified));
        if (files.length >= OBJECT_MANAGER_LIMITS.searchResultCap) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated || !res.IsTruncated || !res.NextContinuationToken) break;
    if (scanned >= OBJECT_MANAGER_LIMITS.searchScanCap) {
      truncated = true;
      break;
    }
    token = res.NextContinuationToken;
  }
  return { prefix, query, files, truncated };
}

export async function objectExists(cfg: ObjectManagerConfig, key: string): Promise<boolean> {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const name = (error as { name?: string })?.name;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return false;
    throw error;
  }
}

/** True when anything other than the folder placeholder itself exists under `prefix`. */
export async function folderHasContent(cfg: ObjectManagerConfig, prefix: string): Promise<boolean> {
  const res = await getClient().send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, MaxKeys: 2 }));
  return (res.Contents ?? []).some((o) => o.Key && o.Key !== prefix);
}

/** Creates an empty "folder/" placeholder so the folder shows even while empty. */
export async function createFolder(cfg: ObjectManagerConfig, prefix: string, name: string): Promise<ObjectFolder> {
  const folderPrefix = `${prefix}${name}/`;
  await getClient().send(
    new PutObjectCommand({ Bucket: cfg.bucket, Key: folderPrefix, Body: new Uint8Array(0), ContentLength: 0 })
  );
  return { prefix: folderPrefix, name };
}

/** First free key for `base.ext` under `prefix`: name.png, name-2.png, name-3.png … */
export async function uniqueKey(cfg: ObjectManagerConfig, prefix: string, base: string, ext: string): Promise<string> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const candidate = `${prefix}${base}${attempt === 1 ? '' : `-${attempt}`}.${ext}`;
    if (!(await objectExists(cfg, candidate))) return candidate;
  }
  return `${prefix}${base}-${Date.now().toString(36)}.${ext}`;
}

export async function uploadObject(
  cfg: ObjectManagerConfig,
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<ObjectFile> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
      // Files are never overwritten (uniqueKey), so they can be cached forever.
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  return buildObjectFile(cfg, key, body.byteLength, new Date());
}

export async function deleteObjects(
  cfg: ObjectManagerConfig,
  keys: string[]
): Promise<{ deleted: string[]; failed: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  const queue = [...keys];
  const worker = async () => {
    while (queue.length) {
      const key = queue.shift()!;
      try {
        await getClient().send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
        deleted.push(key);
      } catch (error) {
        console.error('[object-manager] delete failed for', key, error);
        failed.push(key);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, keys.length) }, worker));
  return { deleted, failed };
}

/** Turns SDK / network errors into a message an admin can act on. */
export function describeR2Error(error: unknown): string {
  const name = (error as { name?: string })?.name ?? '';
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (name === 'AccessDenied' || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || status === 403) {
    return 'R2 refused the request: check R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY and that the token has Object Read & Write on this bucket.';
  }
  if (name === 'NoSuchBucket' || status === 404) return `Bucket "${env('R2_BUCKET')}" was not found: check R2_BUCKET and R2_ACCOUNT_ID.`;
  if (/ENOTFOUND|ECONN|fetch failed|TimeoutError/i.test(`${name} ${String(error)}`)) {
    return 'Could not reach Cloudflare R2: check R2_ACCOUNT_ID and the server network.';
  }
  const message = (error as { message?: string })?.message;
  return message ? `R2 error: ${message}` : 'Unexpected R2 error.';
}
