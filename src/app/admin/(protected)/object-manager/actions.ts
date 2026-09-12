'use server';

/**
 * Server actions for the admin Object Manager (Cloudflare R2 media library).
 * Every action checks the admin session first and never exposes R2 secrets;
 * the browser only ever receives public URLs and object metadata.
 */

import { unstable_noStore as noStore } from 'next/cache';
import { isAdminAuthenticated } from '@/app/actions';
import {
  OBJECT_MANAGER_LIMITS,
  sanitizeFolderName,
  type ActionResult,
  type ListResult,
  type ObjectFolder,
  type SearchResult,
} from '@/lib/object-manager/types';
import {
  createFolder as r2CreateFolder,
  deleteObjects as r2DeleteObjects,
  describeR2Error,
  folderHasContent,
  getObjectManagerConfig,
  isSafeKey,
  isSafePrefix,
  listLevel,
  searchObjects as r2SearchObjects,
  type ObjectManagerConfig,
} from '@/lib/object-manager/r2';

type Guard = { ok: true; cfg: ObjectManagerConfig } | { ok: false; message: string };

async function guard(): Promise<Guard> {
  noStore();
  if (!(await isAdminAuthenticated())) return { ok: false, message: 'Unauthorized' };
  const cfg = getObjectManagerConfig();
  if (!cfg.configured) {
    return { ok: false, message: `Object Manager is not configured (missing ${cfg.missing.join(', ')}).` };
  }
  return { ok: true, cfg };
}

const fail = <T,>(message: string): ActionResult<T> => ({ success: false, message });

export async function listObjects(input: { prefix: string; cursor?: string | null }): Promise<ActionResult<ListResult>> {
  const g = await guard();
  if (!g.ok) return fail(g.message);
  const prefix = typeof input?.prefix === 'string' ? input.prefix : '';
  if (!isSafePrefix(prefix)) return fail('Invalid folder.');
  const cursor = typeof input?.cursor === 'string' && input.cursor.length > 0 && input.cursor.length < 4096 ? input.cursor : null;
  try {
    return { success: true, data: await listLevel(g.cfg, prefix, cursor) };
  } catch (error) {
    console.error('[object-manager] list failed:', error);
    return fail(describeR2Error(error));
  }
}

export async function searchObjects(input: { prefix: string; query: string }): Promise<ActionResult<SearchResult>> {
  const g = await guard();
  if (!g.ok) return fail(g.message);
  const prefix = typeof input?.prefix === 'string' ? input.prefix : '';
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (!isSafePrefix(prefix)) return fail('Invalid folder.');
  if (query.length === 0 || query.length > 100) return fail('Enter 1 to 100 characters to search.');
  try {
    return { success: true, data: await r2SearchObjects(g.cfg, prefix, query) };
  } catch (error) {
    console.error('[object-manager] search failed:', error);
    return fail(describeR2Error(error));
  }
}

export async function createFolder(input: { prefix: string; name: string }): Promise<ActionResult<ObjectFolder>> {
  const g = await guard();
  if (!g.ok) return fail(g.message);
  const prefix = typeof input?.prefix === 'string' ? input.prefix : '';
  if (!isSafePrefix(prefix)) return fail('Invalid folder.');
  const name = sanitizeFolderName(typeof input?.name === 'string' ? input.name : '');
  if (!name) return fail('Folder name must contain letters or numbers.');
  if (prefix.split('/').filter(Boolean).length >= 5) return fail('Folders can be nested at most 5 levels deep.');
  try {
    return { success: true, data: await r2CreateFolder(g.cfg, prefix, name) };
  } catch (error) {
    console.error('[object-manager] create folder failed:', error);
    return fail(describeR2Error(error));
  }
}

/** Deletes an empty folder (its placeholder object). Refuses when files are inside. */
export async function deleteFolder(prefix: string): Promise<ActionResult<{ prefix: string }>> {
  const g = await guard();
  if (!g.ok) return fail(g.message);
  if (typeof prefix !== 'string' || prefix === '' || !isSafePrefix(prefix)) return fail('Invalid folder.');
  try {
    if (await folderHasContent(g.cfg, prefix)) return fail('Folder is not empty. Delete the files inside it first.');
    const result = await r2DeleteObjects(g.cfg, [prefix]);
    if (result.failed.length) return fail('Could not delete the folder.');
    return { success: true, data: { prefix } };
  } catch (error) {
    console.error('[object-manager] delete folder failed:', error);
    return fail(describeR2Error(error));
  }
}

export async function deleteObjects(keys: string[]): Promise<ActionResult<{ deleted: string[]; failed: string[] }>> {
  const g = await guard();
  if (!g.ok) return fail(g.message);
  if (!Array.isArray(keys) || keys.length === 0) return fail('Nothing selected.');
  if (keys.length > OBJECT_MANAGER_LIMITS.deleteCap) return fail(`You can delete at most ${OBJECT_MANAGER_LIMITS.deleteCap} files at once.`);
  const unique = Array.from(new Set(keys));
  if (unique.some((key) => !isSafeKey(key) || key.endsWith('/'))) return fail('Invalid file key.');
  try {
    return { success: true, data: await r2DeleteObjects(g.cfg, unique) };
  } catch (error) {
    console.error('[object-manager] delete failed:', error);
    return fail(describeR2Error(error));
  }
}
