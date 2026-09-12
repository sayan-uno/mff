/**
 * Shared types and limits for the admin "Object Manager" (Cloudflare R2 media
 * library). Safe to import from both server and client code: no secrets here.
 */

export type ObjectKind = 'image' | 'video' | 'other';

export interface ObjectFile {
  /** Full object key, e.g. "products/diamond-100.png". */
  key: string;
  /** File name without the folder part. */
  name: string;
  /** Folder prefix the file lives in ("" for the bucket root, else "a/b/"). */
  folder: string;
  size: number;
  /** ISO timestamp. */
  lastModified: string;
  kind: ObjectKind;
  /** Plain public URL: the file exactly as uploaded. */
  url: string;
  /** Cloudflare-transformed URL (format=auto …). Same as `url` for non-images. */
  optimizedUrl: string;
  /** Small transformed preview for the grid; null for non-images. */
  thumbnailUrl: string | null;
}

export interface ObjectFolder {
  /** Folder prefix ending with "/", e.g. "products/". */
  prefix: string;
  name: string;
}

export interface ListResult {
  prefix: string;
  folders: ObjectFolder[];
  files: ObjectFile[];
  /** Continuation token for the next page of files, or null when done. */
  nextCursor: string | null;
}

export interface SearchResult {
  prefix: string;
  query: string;
  files: ObjectFile[];
  /** True when the scan stopped at the safety cap before reaching the end. */
  truncated: boolean;
}

export type ActionResult<T> = { success: true; data: T } | { success: false; message: string };

export const OBJECT_MANAGER_LIMITS = {
  /** Max upload size per file (also enforced client-side for a fast error). */
  maxUploadBytes: 25 * 1024 * 1024,
  listPageSize: 100,
  /** How many keys a search may scan before stopping. */
  searchScanCap: 5000,
  searchResultCap: 300,
  /** Max keys per delete request. */
  deleteCap: 200,
  /** Parallel uploads from the browser. */
  uploadConcurrency: 3,
} as const;

/** Lower-case extensions that may be uploaded, with the Content-Type we store. */
export const ALLOWED_UPLOADS: Record<string, { contentType: string; kind: ObjectKind }> = {
  png: { contentType: 'image/png', kind: 'image' },
  jpg: { contentType: 'image/jpeg', kind: 'image' },
  jpeg: { contentType: 'image/jpeg', kind: 'image' },
  webp: { contentType: 'image/webp', kind: 'image' },
  gif: { contentType: 'image/gif', kind: 'image' },
  avif: { contentType: 'image/avif', kind: 'image' },
  mp4: { contentType: 'video/mp4', kind: 'video' },
  webm: { contentType: 'video/webm', kind: 'video' },
};

export const ALLOWED_UPLOAD_ACCEPT = Object.keys(ALLOWED_UPLOADS)
  .map((ext) => `.${ext}`)
  .join(',');

/** File extension (lower-case, without dot) of a key or file name; "" if none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg', 'bmp', 'ico']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);

export function kindOf(name: string): ObjectKind {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'other';
}

/** Cleans a folder name typed by the admin: lowercase letters, digits, dashes, max 64 chars. */
export function sanitizeFolderName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64);
}
