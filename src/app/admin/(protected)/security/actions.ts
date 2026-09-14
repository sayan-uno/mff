'use server';

/**
 * Admin Security page actions: change password, regenerate backup codes,
 * log out every session, test the Telegram connection. All require a valid
 * admin session; password-changing actions also require the current password
 * and a delivered Telegram alert (fail closed).
 */

import { cookies, headers } from 'next/headers';
import { unstable_noStore as noStore } from 'next/cache';
import { isAdminAuthenticated } from '@/app/actions';
import { ADMIN_SESSION_COOKIE, adminCookieOptions, createAdminSessionToken } from '@/lib/admin-auth/session';
import {
  LOGIN_RULES,
  bumpSessionVersion,
  changeAdminPasswordHash,
  getSecurityOverview,
  hashPassword,
  regenerateBackupCodes,
  verifyAdminPassword,
} from '@/lib/admin-auth/store';
import { sendTelegramAlert } from '@/lib/telegram';

type Result = { success: true; message: string } | { success: false; message: string };

async function requestInfo() {
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return { ip, when };
}

export async function changeAdminPassword(input: { currentPassword: string; newPassword: string }): Promise<Result> {
  noStore();
  if (!(await isAdminAuthenticated())) return { success: false, message: 'Unauthorized' };
  const overview = await getSecurityOverview();
  if (!overview.initialized) return { success: false, message: 'Log in once with the Telegram code first; the security record is created then.' };

  const current = typeof input?.currentPassword === 'string' ? input.currentPassword : '';
  const next = typeof input?.newPassword === 'string' ? input.newPassword : '';
  if (next.length < LOGIN_RULES.minPasswordLength) return { success: false, message: `New password must be at least ${LOGIN_RULES.minPasswordLength} characters.` };
  if (next.length > 200) return { success: false, message: 'New password is too long.' };
  if (next === current) return { success: false, message: 'New password must be different from the current one.' };

  const check = await verifyAdminPassword(current);
  if (!check.ok) return { success: false, message: 'Current password is incorrect.' };

  const { ip, when } = await requestInfo();
  const alert = await sendTelegramAlert(`🔑 Admin password changed.\nTime: ${when}\nIP: ${ip}\n\nAll other admin sessions were logged out. If this was not you, use a backup code to log in and change it back.`);
  if (!alert.ok) return { success: false, message: `Refused: the Telegram confirmation could not be delivered (${alert.reason}).` };

  const version = await changeAdminPasswordHash(await hashPassword(next));
  // Keep this device logged in under the new version; every other session is now invalid.
  const { token, expires } = await createAdminSessionToken(version);
  (await cookies()).set(ADMIN_SESSION_COOKIE, token, adminCookieOptions(expires));
  return { success: true, message: 'Password changed. Other devices have been logged out.' };
}

export async function regenerateAdminBackupCodes(input: { currentPassword: string }): Promise<{ success: true; codes: string[] } | { success: false; message: string }> {
  noStore();
  if (!(await isAdminAuthenticated())) return { success: false, message: 'Unauthorized' };
  const overview = await getSecurityOverview();
  if (!overview.initialized) return { success: false, message: 'Log in once with the Telegram code first.' };

  const check = await verifyAdminPassword(typeof input?.currentPassword === 'string' ? input.currentPassword : '');
  if (!check.ok) return { success: false, message: 'Current password is incorrect.' };

  const { ip, when } = await requestInfo();
  const alert = await sendTelegramAlert(`🧾 Admin backup codes regenerated. The old codes no longer work.\nTime: ${when}\nIP: ${ip}`);
  if (!alert.ok) return { success: false, message: `Refused: the Telegram confirmation could not be delivered (${alert.reason}).` };

  return { success: true, codes: await regenerateBackupCodes() };
}

export async function logoutAllAdminSessions(): Promise<Result> {
  noStore();
  if (!(await isAdminAuthenticated())) return { success: false, message: 'Unauthorized' };
  const { ip, when } = await requestInfo();
  await bumpSessionVersion();
  (await cookies()).delete(ADMIN_SESSION_COOKIE);
  await sendTelegramAlert(`🚪 All admin sessions logged out.\nTime: ${when}\nIP: ${ip}`);
  return { success: true, message: 'Every admin session is now logged out, including this one.' };
}

export async function sendTelegramTestAlert(): Promise<Result> {
  noStore();
  if (!(await isAdminAuthenticated())) return { success: false, message: 'Unauthorized' };
  const { ip, when } = await requestInfo();
  const alert = await sendTelegramAlert(`🔔 Test alert from the admin panel.\nTime: ${when}\nIP: ${ip}`);
  return alert.ok ? { success: true, message: 'Test alert delivered to your Telegram.' } : { success: false, message: `Not delivered: ${alert.reason}` };
}
