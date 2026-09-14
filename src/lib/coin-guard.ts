/**
 * Guard for coin gifting (server-only).
 *
 * The gift password is the only thing standing between an attacker and a
 * user's coins, so guesses are limited: after `maxFailures` wrong passwords
 * the account's gifting is locked for `lockMs` and the admin is alerted on
 * Telegram. Counters live on the user document:
 *   giftFailedAttempts?: number, giftLockUntil?: Date
 */

import { connectToDatabase } from '@/lib/mongodb';
import type { User } from '@/lib/definitions';
import { sendTelegramAlert } from '@/lib/telegram';

export const GIFT_RULES = {
  maxFailures: 5,
  lockMs: 30 * 60 * 1000,
  minAmount: 1,
  maxAmount: 1_000_000,
} as const;

export async function getGiftLock(gamingId: string): Promise<{ locked: false } | { locked: true; until: Date }> {
  const db = await connectToDatabase();
  const user = await db.collection<User>('users').findOne({ gamingId }, { projection: { giftLockUntil: 1 } });
  const until = user?.giftLockUntil;
  if (until && until.getTime() > Date.now()) return { locked: true, until };
  return { locked: false };
}

/** Counts a wrong gift password; locks the account on the 5th and alerts the admin. */
export async function recordGiftPasswordFailure(gamingId: string, ip: string): Promise<{ lockedNow: boolean; attemptsLeft: number }> {
  const db = await connectToDatabase();
  const users = db.collection<User>('users');
  const updated = await users.findOneAndUpdate({ gamingId }, { $inc: { giftFailedAttempts: 1 } }, { returnDocument: 'after', projection: { giftFailedAttempts: 1 } });
  const failures = updated?.giftFailedAttempts ?? 1;
  if (failures < GIFT_RULES.maxFailures) return { lockedNow: false, attemptsLeft: GIFT_RULES.maxFailures - failures };

  const until = new Date(Date.now() + GIFT_RULES.lockMs);
  await users.updateOne({ gamingId }, { $set: { giftLockUntil: until }, $unset: { giftFailedAttempts: '' } });
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  await sendTelegramAlert(`🔒 Coin gifting locked for Gaming ID ${gamingId} after ${GIFT_RULES.maxFailures} wrong gift passwords (30 min).\nIP: ${ip}\nTime: ${when}`);
  return { lockedNow: true, attemptsLeft: 0 };
}

export async function clearGiftFailures(gamingId: string): Promise<void> {
  const db = await connectToDatabase();
  await db.collection<User>('users').updateOne({ gamingId }, { $unset: { giftFailedAttempts: '', giftLockUntil: '' } });
}
