'use server';

/**
 * UPI payment locks.
 *
 * A "lock" reserves a unique rupee amount (price + 0.01 … +1.00) for one buyer
 * for 90 seconds, so that the incoming bank SMS (see /api/sms) can be matched
 * back to exactly one purchase by its amount.
 *
 * Security model (task 3 of the security plan):
 * - The browser only sends the product id. Who is paying comes from the
 *   session cookie, the price and coin discount come from the database, and
 *   the unique amount is chosen here. Nothing money-related is trusted from
 *   the client.
 * - Eligibility is re-checked on the server before every lock.
 * - One active lock per user; creating a new one releases the previous.
 * - Creation is rate limited per user and per IP so the amount space cannot
 *   be flooded to block real customers.
 * - A lock can only be released or polled by the user who created it.
 * - A unique partial index guarantees two active locks never share an amount,
 *   even under concurrent requests.
 */

import { cookies, headers } from 'next/headers';
import { unstable_noStore as noStore } from 'next/cache';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from '@/lib/mongodb';
import type { PaymentLock, Product, User } from '@/lib/definitions';
import { checkPurchaseEligibility } from '@/app/actions/check-purchase-eligibility';
import { rateLimit } from '@/lib/rate-limit';

const LOCK_TTL_MS = 90 * 1000;
const RECENTLY_EXPIRED_COOLDOWN_MS = 30 * 1000; // matches the grace period in /api/sms
const MAX_PRICE_ATTEMPTS = 100; // up to +₹1.00
const MIN_UPI_AMOUNT = 1;
const USER_LIMIT = { limit: 8, windowMs: 10 * 60 * 1000 };
const IP_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

export type QuoteResult =
  | { success: true; basePrice: number; coinsToUse: number; finalPrice: number; fee: number }
  | { success: false; message: string };

export type CreateLockResult =
  | { success: true; lockId: string; amount: number; fee: number; coinsToUse: number; expiresInSec: number }
  | { success: false; message: string };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let indexReady: Promise<void> | undefined;

/** Best effort: unique amount among active locks. Skipped if existing data conflicts. */
async function ensureLockIndex() {
  if (!indexReady) {
    indexReady = connectToDatabase()
      .then((db) =>
        db
          .collection<PaymentLock>('payment_locks')
          .createIndex({ amount: 1 }, { unique: true, partialFilterExpression: { status: 'active' }, name: 'unique_active_amount' })
      )
      .then(() => undefined)
      .catch((error) => {
        console.error('[payment-locks] could not create unique index (continuing without it):', error?.message ?? error);
      });
  }
  await indexReady;
}

async function currentGamingId(): Promise<string | null> {
  const value = (await cookies()).get('gaming_id')?.value?.trim();
  return value ? value : null;
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown';
}

/** Marks stale active locks as expired (sweeper; also run by /api/sms). */
async function expireOldLocks(): Promise<void> {
  try {
    const db = await connectToDatabase();
    await db.collection<PaymentLock>('payment_locks').updateMany({ status: 'active', expiresAt: { $lt: new Date() } }, { $set: { status: 'expired' } });
  } catch (error) {
    console.error('Error expiring old payment locks:', error);
  }
}

function toMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Price the user has to pay via UPI before any uniqueness fee. */
function basePriceFor(product: Product, user: User): { basePrice: number; coinsToUse: number } {
  const coinsToUse = !product.isCoinProduct ? Math.max(0, Math.min(user.coins ?? 0, product.coinsApplicable || 0)) : 0;
  const basePrice = product.isCoinProduct ? product.purchasePrice || product.price : product.price - coinsToUse;
  return { basePrice: toMoney(basePrice), coinsToUse };
}

/** First amount at or above `baseAmount` not held by an active or just-expired lock. */
async function findAvailableUpiPrice(baseAmount: number): Promise<{ finalPrice: number; fee: number }> {
  await expireOldLocks();
  const db = await connectToDatabase();
  const cooldown = new Date(Date.now() - RECENTLY_EXPIRED_COOLDOWN_MS);
  let finalPrice = toMoney(baseAmount);
  let fee = 0;
  for (let attempt = 0; attempt < MAX_PRICE_ATTEMPTS; attempt++) {
    const taken = await db.collection<PaymentLock>('payment_locks').findOne({
      amount: finalPrice,
      $or: [{ status: 'active' }, { status: 'expired', expiresAt: { $gte: cooldown } }],
    });
    if (!taken) return { finalPrice, fee };
    finalPrice = toMoney(finalPrice + 0.01);
    fee = toMoney(fee + 0.01);
  }
  return { finalPrice: toMoney(baseAmount), fee: 0 };
}

async function loadUserAndProduct(gamingId: string, productId: string): Promise<{ user: User; product: Product } | { message: string }> {
  if (!ObjectId.isValid(productId)) return { message: 'Product not found.' };
  const db = await connectToDatabase();
  const [user, product] = await Promise.all([
    db.collection<User>('users').findOne({ gamingId }),
    db.collection<Product>('products').findOne({ _id: new ObjectId(productId) }),
  ]);
  if (!user) return { message: 'Please register your Gaming ID first.' };
  if (!product || product.isVanished) return { message: 'Product not found.' };
  return { user, product };
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/** Price preview for the purchase modal. Identity from the cookie, numbers from the database. */
export async function quoteUpiPrice(productId: string): Promise<QuoteResult> {
  noStore();
  const gamingId = await currentGamingId();
  if (!gamingId) return { success: false, message: 'Please register your Gaming ID first.' };
  const loaded = await loadUserAndProduct(gamingId, String(productId ?? ''));
  if ('message' in loaded) return { success: false, message: loaded.message };
  const { basePrice, coinsToUse } = basePriceFor(loaded.product, loaded.user);
  if (basePrice < MIN_UPI_AMOUNT) return { success: false, message: 'This item does not need a UPI payment.' };
  const { finalPrice, fee } = await findAvailableUpiPrice(basePrice);
  return { success: true, basePrice, coinsToUse, finalPrice, fee };
}

/**
 * Reserves a unique amount for the current user and product. Returns the
 * exact amount to pay; the bank SMS with that amount completes the order.
 */
export async function createPaymentLock(productId: string): Promise<CreateLockResult> {
  noStore();
  const gamingId = await currentGamingId();
  if (!gamingId) return { success: false, message: 'Please register your Gaming ID first.' };

  const ip = await clientIp();
  if (!rateLimit(`lock:user:${gamingId}`, USER_LIMIT).allowed || !rateLimit(`lock:ip:${ip}`, IP_LIMIT).allowed) {
    return { success: false, message: 'Too many payment attempts. Please wait a few minutes and try again.' };
  }

  const loaded = await loadUserAndProduct(gamingId, String(productId ?? ''));
  if ('message' in loaded) return { success: false, message: loaded.message };
  const { user, product } = loaded;

  const eligibility = await checkPurchaseEligibility(user._id.toString(), product._id.toString());
  if (!eligibility.eligible) return { success: false, message: eligibility.message };

  const { basePrice, coinsToUse } = basePriceFor(product, user);
  if (basePrice < MIN_UPI_AMOUNT) return { success: false, message: 'This item does not need a UPI payment.' };

  try {
    await ensureLockIndex();
    const db = await connectToDatabase();
    const locks = db.collection<PaymentLock>('payment_locks');

    // One active lock per user: release anything older first.
    await locks.updateMany({ gamingId, status: 'active' }, { $set: { status: 'expired', expiresAt: new Date() } });

    for (let attempt = 0; attempt < 3; attempt++) {
      const { finalPrice, fee } = await findAvailableUpiPrice(basePrice);
      const now = new Date();
      const newLock: Omit<PaymentLock, '_id'> = {
        gamingId,
        productId: product._id.toString(),
        productName: product.name,
        amount: finalPrice,
        status: 'active',
        createdAt: now,
        expiresAt: new Date(now.getTime() + LOCK_TTL_MS),
      };
      try {
        const result = await locks.insertOne(newLock as PaymentLock);
        return { success: true, lockId: result.insertedId.toString(), amount: finalPrice, fee, coinsToUse, expiresInSec: Math.floor(LOCK_TTL_MS / 1000) };
      } catch (error) {
        // Duplicate active amount (unique index) → another buyer got it first; try the next slot.
        if ((error as { code?: number })?.code !== 11000) throw error;
      }
    }
    return { success: false, message: 'Another payment for the same amount is in progress. Please try again in a moment.' };
  } catch (error) {
    console.error('Error creating payment lock:', error);
    return { success: false, message: 'An internal error occurred.' };
  }
}

/** Releases the current user's active lock (modal closed or timer ran out). */
export async function releasePaymentLock(lockId: string): Promise<{ success: boolean }> {
  noStore();
  const gamingId = await currentGamingId();
  if (!gamingId || !ObjectId.isValid(String(lockId ?? ''))) return { success: false };
  try {
    const db = await connectToDatabase();
    const result = await db
      .collection<PaymentLock>('payment_locks')
      .updateOne({ _id: new ObjectId(lockId), gamingId, status: 'active' }, { $set: { status: 'expired', expiresAt: new Date() } });
    return { success: result.matchedCount === 1 };
  } catch (error) {
    console.error('Error releasing payment lock:', error);
    return { success: false };
  }
}

/** Polled by the modal: has the bank SMS completed this lock? Only the owner may ask. */
export async function checkPaymentStatus(lockId: string): Promise<{ isCompleted: boolean }> {
  noStore();
  const gamingId = await currentGamingId();
  if (!gamingId || !ObjectId.isValid(String(lockId ?? ''))) return { isCompleted: false };
  try {
    const db = await connectToDatabase();
    const lock = await db.collection<PaymentLock>('payment_locks').findOne({ _id: new ObjectId(lockId), gamingId }, { projection: { status: 1 } });
    return { isCompleted: lock?.status === 'completed' };
  } catch (error) {
    console.error('Error checking payment status:', error);
    return { isCompleted: false };
  }
}
