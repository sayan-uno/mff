'use server';

/**
 * Admin login flow (server actions):
 *
 *   startAdminLogin(password)      password → Telegram code (must be delivered)
 *   verifyAdminLoginCode(code)     code → signed 12h session cookie
 *   resendAdminLoginCode()         new code, at most 3 sends per login
 *   loginWithAdminBackupCode(code) one-time backup code instead of Telegram
 *   cancelAdminLogin()             abandon the pending login
 *
 * Every step is rate limited (see store.ts) and every security-relevant event
 * is reported to the admin's Telegram. Login is refused when Telegram cannot
 * confirm delivery of the code or of the success alert (fail closed).
 */

import { cookies, headers } from 'next/headers';
import { getClientIp } from '@/lib/client-ip';
import { unstable_noStore as noStore } from 'next/cache';
import {
  ADMIN_CHALLENGE_COOKIE,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_HOURS,
  adminCookieOptions,
  createAdminSessionToken,
  isAdminSigningConfigured,
} from '@/lib/admin-auth/session';
import {
  LOGIN_RULES,
  bootstrapSecurityRecord,
  consumeBackupCode,
  createChallenge,
  deleteChallenge,
  getChallenge,
  getLockState,
  getSessionVersion,
  hashPassword,
  recordLoginAttempt,
  rotateChallengeCode,
  verifyAdminPassword,
  verifyChallengeCode,
  type ChallengeDoc,
  type LockState,
} from '@/lib/admin-auth/store';
import { isTelegramConfigured, sendTelegramAlert } from '@/lib/telegram';

export type LoginStepResult =
  | { status: 'code_sent'; expiresInSec: number; sendsLeft: number }
  | { status: 'ok'; backupCodes?: string[] }
  | { status: 'error'; message: string; restart?: boolean };

const error = (message: string, restart = false): LoginStepResult => ({ status: 'error', message, restart });

async function clientInfo() {
  const h = await headers();
  const ip = getClientIp(h);
  const userAgent = (h.get('user-agent') ?? 'unknown').slice(0, 200);
  return { ip, userAgent };
}

function nowText() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

function lockMessage(lock: Extract<LockState, { locked: true }>) {
  const minutes = Math.max(1, Math.ceil((lock.until.getTime() - Date.now()) / 60000));
  return lock.scope === 'global'
    ? `Admin login is locked for everyone after too many failed attempts. Try again in ${minutes} min.`
    : `Too many failed attempts from your network. Try again in ${minutes} min.`;
}

async function preflight(): Promise<LoginStepResult | null> {
  if (!isAdminSigningConfigured()) return error('Server is missing SESSION_SECRET (at least 32 characters). Login is disabled.');
  if (!isTelegramConfigured()) return error('Telegram is not configured on the server, so login codes cannot be delivered.');
  return null;
}

export async function startAdminLogin(input: { password: string }): Promise<LoginStepResult> {
  noStore();
  const blocked = await preflight();
  if (blocked) return blocked;
  const { ip, userAgent } = await clientInfo();

  const lock = await getLockState(ip);
  if (lock.locked) return error(lockMessage(lock));

  const password = typeof input?.password === 'string' ? input.password : '';
  const check = password ? await verifyAdminPassword(password) : { ok: false, bootstrap: false };
  const attempt = await recordLoginAttempt({ ip, userAgent, kind: 'password', success: check.ok });

  if (!check.ok) {
    if (attempt.lockedNow === 'global') {
      await sendTelegramAlert(`🚫 ADMIN LOGIN LOCKED for 1 hour: ${attempt.failuresGlobal} failed attempts in 15 minutes.\nLast from IP ${ip}\n${nowText()}`);
    } else if (attempt.lockedNow === 'ip') {
      await sendTelegramAlert(`⚠️ Admin login blocked for 15 min for IP ${ip} after ${attempt.failuresFromIp} wrong passwords.\nBrowser: ${userAgent}\n${nowText()}`);
    } else if (attempt.failuresFromIp === 3) {
      await sendTelegramAlert(`⚠️ 3 wrong admin password attempts from IP ${ip}.\nBrowser: ${userAgent}\n${nowText()}`);
    }
    return error('Incorrect password.');
  }

  // Bootstrap: the env password was used; hash it now so the record can be
  // created on completion without keeping the plain password anywhere.
  const bootstrapHash = check.bootstrap ? await hashPassword(password) : undefined;
  const { id, code } = await createChallenge({ ip, userAgent, bootstrapHash });

  const sent = await sendTelegramAlert(
    `🔐 Admin login code: ${code}\n\nValid for 5 minutes.\nTime: ${nowText()}\nIP: ${ip}\nBrowser: ${userAgent}\n\nIf this was not you, someone knows your admin password. Change it in Admin Security right away.`
  );
  if (!sent.ok) {
    await deleteChallenge(id);
    return error(`Could not deliver the login code via Telegram (${sent.reason}). Nothing was logged in; try again.`);
  }

  (await cookies()).set(ADMIN_CHALLENGE_COOKIE, id, adminCookieOptions(new Date(Date.now() + LOGIN_RULES.codeTtlMs)));
  return { status: 'code_sent', expiresInSec: Math.floor(LOGIN_RULES.codeTtlMs / 1000), sendsLeft: LOGIN_RULES.maxCodeSends - 1 };
}

export async function resendAdminLoginCode(): Promise<LoginStepResult> {
  noStore();
  const blocked = await preflight();
  if (blocked) return blocked;
  const { ip, userAgent } = await clientInfo();
  const lock = await getLockState(ip);
  if (lock.locked) return error(lockMessage(lock), true);

  const id = (await cookies()).get(ADMIN_CHALLENGE_COOKIE)?.value ?? '';
  const rotated = await rotateChallengeCode(id);
  if ('error' in rotated) {
    if (rotated.error === 'exhausted') return error('No more codes can be sent for this login. Wait for the current code or start again.');
    (await cookies()).delete(ADMIN_CHALLENGE_COOKIE);
    return error('Your login session expired. Start again.', true);
  }
  const sent = await sendTelegramAlert(`🔐 Admin login code (resent): ${rotated.code}\n\nValid for 5 minutes.\nTime: ${nowText()}\nIP: ${ip}\nBrowser: ${userAgent}`);
  if (!sent.ok) return error(`Could not deliver the code via Telegram (${sent.reason}).`);
  (await cookies()).set(ADMIN_CHALLENGE_COOKIE, id, adminCookieOptions(new Date(Date.now() + LOGIN_RULES.codeTtlMs)));
  return { status: 'code_sent', expiresInSec: Math.floor(LOGIN_RULES.codeTtlMs / 1000), sendsLeft: rotated.sendsLeft };
}

export async function verifyAdminLoginCode(input: { code: string }): Promise<LoginStepResult> {
  noStore();
  const blocked = await preflight();
  if (blocked) return blocked;
  const { ip, userAgent } = await clientInfo();
  const lock = await getLockState(ip);
  if (lock.locked) return error(lockMessage(lock), true);

  const id = (await cookies()).get(ADMIN_CHALLENGE_COOKIE)?.value ?? '';
  if (!id) return error('Your login session expired. Start again.', true);
  const code = String(input?.code ?? '').replace(/\D/g, '');
  if (code.length !== LOGIN_RULES.codeLength) return error(`Enter the ${LOGIN_RULES.codeLength}-digit code.`);

  const result = await verifyChallengeCode(id, code);
  await recordLoginAttempt({ ip, userAgent, kind: 'code', success: result.outcome === 'ok' });
  if (result.outcome === 'ok') return finishLogin({ ip, userAgent, challenge: result.challenge, via: 'telegram' });
  if (result.outcome === 'wrong') return error('Incorrect code.');
  (await cookies()).delete(ADMIN_CHALLENGE_COOKIE);
  return error(result.outcome === 'expired' ? 'The code expired. Start again.' : 'Too many wrong codes. Start again.', true);
}

export async function loginWithAdminBackupCode(input: { code: string }): Promise<LoginStepResult> {
  noStore();
  const blocked = await preflight();
  if (blocked) return blocked;
  const { ip, userAgent } = await clientInfo();
  const lock = await getLockState(ip);
  if (lock.locked) return error(lockMessage(lock), true);

  const id = (await cookies()).get(ADMIN_CHALLENGE_COOKIE)?.value ?? '';
  const challenge = await getChallenge(id);
  if (!challenge) {
    (await cookies()).delete(ADMIN_CHALLENGE_COOKIE);
    return error('Your login session expired. Start again.', true);
  }
  if (challenge.bootstrapHash) return error('No backup codes exist yet. Complete your first login with the Telegram code; the codes are created then.');

  const accepted = await consumeBackupCode(String(input?.code ?? ''));
  const attempt = await recordLoginAttempt({ ip, userAgent, kind: 'backup', success: accepted });
  if (!accepted) {
    if (attempt.lockedNow) await sendTelegramAlert(`🚫 Admin login blocked after repeated wrong backup codes from IP ${ip}.\n${nowText()}`);
    return error('Invalid or already used backup code.');
  }
  await deleteChallenge(id);
  return finishLogin({ ip, userAgent, challenge, via: 'backup' });
}

export async function cancelAdminLogin(): Promise<void> {
  noStore();
  const id = (await cookies()).get(ADMIN_CHALLENGE_COOKIE)?.value;
  if (id) await deleteChallenge(id);
  (await cookies()).delete(ADMIN_CHALLENGE_COOKIE);
}

async function finishLogin(input: { ip: string; userAgent: string; challenge: ChallengeDoc; via: 'telegram' | 'backup' }): Promise<LoginStepResult> {
  let backupCodes: string[] | undefined;
  if (input.challenge.bootstrapHash) {
    const created = await bootstrapSecurityRecord(input.challenge.bootstrapHash);
    if (created.created) backupCodes = created.backupCodes;
  }

  const text =
    input.via === 'backup'
      ? `🚨 BACKUP CODE USED for admin login.\nTime: ${nowText()}\nIP: ${input.ip}\nBrowser: ${input.userAgent}\n\nIf this was not you, change the admin password and regenerate backup codes immediately.`
      : `✅ Admin login successful.\nTime: ${nowText()}\nIP: ${input.ip}\nBrowser: ${input.userAgent}\nSession valid ${ADMIN_SESSION_HOURS} hours.`;
  const alert = await sendTelegramAlert(text);
  if (!alert.ok) return error(`Login refused: the Telegram confirmation could not be delivered (${alert.reason}).`, true);

  const version = await getSessionVersion(true);
  const { token, expires } = await createAdminSessionToken(version);
  (await cookies()).set(ADMIN_SESSION_COOKIE, token, adminCookieOptions(expires));
  (await cookies()).delete(ADMIN_CHALLENGE_COOKIE);
  return { status: 'ok', backupCodes };
}
