/**
 * Ad-reward sessions (server-only, MongoDB).
 *
 * Before: any browser could call `rewardAdCoins()` in a loop for free coins.
 * Now the watch-ad page first asks the server for a single-use token when the
 * ad starts; the server records when the reward may be claimed (the ad's
 * reward time, measured by the SERVER clock). The reward is paid only for a
 * token that belongs to the same user, has not been claimed, whose reward
 * time has passed and which has not expired. A daily cap bounds abuse even
 * with real watching.
 *
 * Collection: ad_reward_sessions { _id: token, gamingId, adId, rewardAt,
 * expiresAt (TTL), createdAt, claimedAt? }
 */

import { connectToDatabase } from '@/lib/mongodb';
import type { User } from '@/lib/definitions';
import { randomHex } from '@/lib/admin-auth/session';

export const AD_REWARD_COINS = 5;
const CLAIM_TOLERANCE_MS = 500; // small allowance for network latency
const SESSION_GRACE_MS = 10 * 60 * 1000; // token stays valid this long after the ad ends
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function dailyRewardCap(): number {
  const raw = Number(process.env.AD_REWARD_DAILY_CAP ?? 100);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

interface AdRewardSession {
  _id: string;
  gamingId: string;
  adId: string;
  rewardAt: Date;
  expiresAt: Date;
  createdAt: Date;
  claimedAt?: Date;
}

export type ClaimResult =
  | { ok: true; coins: number }
  | { ok: false; reason: 'not_found' | 'not_yet' | 'expired' | 'claimed' | 'daily_cap' | 'user_missing'; retryAfterMs?: number };

let indexesReady: Promise<void> | undefined;

async function collection() {
  const db = await connectToDatabase();
  const col = db.collection<AdRewardSession>('ad_reward_sessions');
  if (!indexesReady) {
    indexesReady = Promise.all([
      col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      col.createIndex({ gamingId: 1, claimedAt: 1 }),
    ])
      .then(() => undefined)
      .catch((error) => {
        indexesReady = undefined;
        throw error;
      });
  }
  await indexesReady;
  return { db, col };
}

/** Creates a session when an ad starts. `rewardTimeSec` / `totalDurationSec` come from the ad record. */
export async function startAdRewardSession(input: {
  gamingId: string;
  adId: string;
  rewardTimeSec: number;
  totalDurationSec: number;
}): Promise<{ token: string; rewardInSec: number }> {
  const { col } = await collection();
  const rewardInSec = Math.max(1, Math.floor(input.rewardTimeSec > 0 ? input.rewardTimeSec : input.totalDurationSec));
  const now = new Date();
  const token = randomHex(24);
  await col.insertOne({
    _id: token,
    gamingId: input.gamingId,
    adId: input.adId,
    rewardAt: new Date(now.getTime() + rewardInSec * 1000),
    expiresAt: new Date(now.getTime() + Math.max(input.totalDurationSec, rewardInSec) * 1000 + SESSION_GRACE_MS),
    createdAt: now,
  });
  return { token, rewardInSec };
}

/** Pays the reward for a valid, unclaimed, matured token. Atomic per token. */
export async function claimAdReward(gamingId: string, token: string): Promise<ClaimResult> {
  if (!/^[0-9a-f]{48}$/.test(String(token ?? ''))) return { ok: false, reason: 'not_found' };
  const { db, col } = await collection();
  const now = new Date();

  const existing = await col.findOne({ _id: token, gamingId });
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.claimedAt) return { ok: false, reason: 'claimed' };
  if (existing.expiresAt.getTime() < now.getTime()) return { ok: false, reason: 'expired' };
  const remaining = existing.rewardAt.getTime() - now.getTime() - CLAIM_TOLERANCE_MS;
  if (remaining > 0) return { ok: false, reason: 'not_yet', retryAfterMs: remaining + 250 };

  const claimedToday = await col.countDocuments({ gamingId, claimedAt: { $gte: new Date(now.getTime() - DAILY_WINDOW_MS) } });
  if (claimedToday >= dailyRewardCap()) return { ok: false, reason: 'daily_cap' };

  // Mark claimed first (only one request can win), then pay.
  const marked = await col.updateOne({ _id: token, gamingId, claimedAt: { $exists: false } }, { $set: { claimedAt: now } });
  if (marked.modifiedCount !== 1) return { ok: false, reason: 'claimed' };

  const paid = await db.collection<User>('users').updateOne({ gamingId }, { $inc: { coins: AD_REWARD_COINS } });
  if (paid.modifiedCount !== 1) {
    await col.updateOne({ _id: token }, { $unset: { claimedAt: '' } });
    return { ok: false, reason: 'user_missing' };
  }
  return { ok: true, coins: AD_REWARD_COINS };
}
