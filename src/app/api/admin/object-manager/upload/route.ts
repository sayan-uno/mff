import { NextRequest, NextResponse } from 'next/server';
import { isAdminAuthenticated } from '@/app/actions';
import { ALLOWED_UPLOADS, OBJECT_MANAGER_LIMITS } from '@/lib/object-manager/types';
import {
  describeR2Error,
  getObjectManagerConfig,
  isSafePrefix,
  sanitizeFileName,
  sniffExtension,
  uniqueKey,
  uploadObject,
} from '@/lib/object-manager/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Upload endpoint for the admin Object Manager.
//
// multipart/form-data with `folder` (prefix such as "products/" or "") and
// `file`. A route handler is used instead of a server action so uploads are
// not bound by the server-action body limit. Files are validated by extension,
// size and magic bytes, renamed to a clean unique key and stored in R2 with a
// long cache lifetime (keys are never reused, so caching forever is safe).
// ---------------------------------------------------------------------------

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status });
const MAX = OBJECT_MANAGER_LIMITS.maxUploadBytes;

export async function POST(req: NextRequest) {
  if (!(await isAdminAuthenticated())) return json(401, { success: false, message: 'Unauthorized' });

  const cfg = getObjectManagerConfig();
  if (!cfg.configured) return json(500, { success: false, message: `Object Manager is not configured (missing ${cfg.missing.join(', ')}).` });

  // Reject clearly oversized requests before reading the body.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX + 1024 * 1024) return json(413, { success: false, message: `File is larger than ${Math.round(MAX / 1024 / 1024)} MB.` });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { success: false, message: 'Could not read the upload.' });
  }

  const folder = String(form.get('folder') ?? '');
  if (!isSafePrefix(folder)) return json(400, { success: false, message: 'Invalid folder.' });

  const file = form.get('file');
  if (!(file instanceof Blob)) return json(400, { success: false, message: 'No file received.' });
  const originalName = (file as File).name || 'file';

  const parsed = sanitizeFileName(originalName);
  if (!parsed) {
    return json(415, { success: false, message: `"${originalName}" is not an allowed type. Allowed: png, jpg, webp, gif, avif, mp4, webm.` });
  }
  if (file.size === 0) return json(400, { success: false, message: `"${originalName}" is empty.` });
  if (file.size > MAX) return json(413, { success: false, message: `"${originalName}" is larger than ${Math.round(MAX / 1024 / 1024)} MB.` });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffExtension(bytes);
  if (sniffed !== parsed.ext) {
    return json(415, { success: false, message: `"${originalName}" does not look like a real .${parsed.ext} file.` });
  }

  try {
    const key = await uniqueKey(cfg, folder, parsed.base, parsed.ext);
    const uploaded = await uploadObject(cfg, key, bytes, ALLOWED_UPLOADS[parsed.ext].contentType);
    return json(200, { success: true, file: uploaded });
  } catch (error) {
    console.error('[object-manager] upload failed:', error);
    return json(502, { success: false, message: describeR2Error(error) });
  }
}
