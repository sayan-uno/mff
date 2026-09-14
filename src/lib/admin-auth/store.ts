/**
 * Persistence for admin authentication (MongoDB). Server-only.
 *
 * Collections:
 * - admin_security        one document: password hash, backup code hashes,
 *                         session version, timestamps.
 * - admin_login_attempts  every password / code / backup-code attempt
 *                         (TTL 24h) — used for lockouts and the activity list.
 * - admin_lockouts        active lockouts (per IP or global), TTL on `until`.
 * - admin_login_challenges pending logins whose password was accepted and
 *                         whose Telegram code is awaited (TTL 5 min).
 *
 * Bootstrap: while no admin_security document exists, the password is checked
 * against the ADMIN_PASSWORD env var (constant-time). The first successful
 * login then creates the document (bcrypt hash + backup codes) and the env
 * password is never consulted again.
 */

import bcrypt from 'bcryptjs';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { connectToDatabase } from '@/lib/mongodb';
import { randomHex } from './session';

export const LOGIN_RULES = {
  codeTtlMs: 5 * 60 * 1000,
  codeLength: 6,
  maxCodeAttempts: 5,
  maxCodeSends: 3,
  ipFailLimit: 5,
  ipLockMs: 15 * 60 * 1000,
  globalFailLimit: 20,
  globalLockMs: 60 * 60 * 1000,
  failureWindowMs: 15 * 60 * 1000,
  backupCodeCount: 5,
  minPasswordLength: 12,
  bcryptRounds: 12,
} as const;

const SECURITY_ID = 'admin';
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export type AttemptKind = 'password' | 'code' | 'backup';

export interface LoginAttempt {
  ip: string;
  userAgent: string;
  kind: AttemptKind;
  success: boolean;
  at: Date;
}

interface SecurityDoc {
  _id: string;
  passwordHash: string;
  backupCodes: { hash: string; usedAt?: Date }[];
  sessionVersion: number;
  passwordUpdatedAt: Date;
  backupCodesUpdatedAt: Date;
  createdAt: Date;
}

interface LockoutDoc {
  _id: string; // "ip:<ip>" or "global"
  scope: 'ip' | 'global';
  until: Date;
}

export interface ChallengeDoc {
  _id: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  sends: number;
  ip: string;
  userAgent: string;
  createdAt: Date;
  /** Set during bootstrap: bcrypt hash of the env password, stored on first login. */
  bootstrapHash?: string;
}

export type LockState = { locked: false } | { locked: true; scope: 'ip' | 'global'; until: Date };

export interface SecurityOverview {
  initialized: boolean;
  passwordUpdatedAt: string | null;
  backupCodesTotal: number;
  backupCodesUnused: number;
  backupCodesUpdatedAt: string | null;
  sessionVersion: number;
}

let indexesReady: Promise<void> | undefined;

async function db() {
  const database = await connectToDatabase();
  if (!indexesReady) {
    indexesReady = Promise.all([
      database.collection('admin_login_attempts').createIndex({ at: 1 }, { expireAfterSeconds: 24 * 60 * 60 }),
      database.collection('admin_login_attempts').createIndex({ ip: 1, at: -1 }),
      database.collection('admin_lockouts').createIndex({ until: 1 }, { expireAfterSeconds: 0 }),
      database.collection('admin_login_challenges').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ])
      .then(() => undefined)
      .catch((error) => {
        indexesReady = undefined;
        throw error;
      });
  }
  await indexesReady;
  return database;
}

// ---------------------------------------------------------------------------
// Security record (password, backup codes, session version)
// ---------------------------------------------------------------------------

async function getSecurityRecord(): Promise<SecurityDoc | null> {
  return (await db()).collection<SecurityDoc>('admin_security').findOne({ _id: SECURITY_ID });
}

export async function getSecurityOverview(): Promise<SecurityOverview> {
  const rec = await getSecurityRecord();
  if (!rec) {
    return { initialized: false, passwordUpdatedAt: null, backupCodesTotal: 0, backupCodesUnused: 0, backupCodesUpdatedAt: null, sessionVersion: 1 };
  }
  return {
    initialized: true,
    passwordUpdatedAt: rec.passwordUpdatedAt.toISOString(),
    backupCodesTotal: rec.backupCodes.length,
    backupCodesUnused: rec.backupCodes.filter((c) => !c.usedAt).length,
    backupCodesUpdatedAt: rec.backupCodesUpdatedAt.toISOString(),
    sessionVersion: rec.sessionVersion,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // keep timing similar
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, LOGIN_RULES.bcryptRounds);
}

/**
 * Checks a password. `bootstrap: true` means the stored record does not exist
 * yet and the ADMIN_PASSWORD env var was used.
 */
export async function verifyAdminPassword(candidate: string): Promise<{ ok: boolean; bootstrap: boolean }> {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 200) return { ok: false, bootstrap: false };
  const rec = await getSecurityRecord();
  if (rec) return { ok: await bcrypt.compare(candidate, rec.passwordHash), bootstrap: false };
  const envPassword = process.env.ADMIN_PASSWORD ?? '';
  if (!envPassword) return { ok: false, bootstrap: false };
  return { ok: constantTimeEqual(candidate, envPassword), bootstrap: true };
}

export function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < LOGIN_RULES.backupCodeCount; i++) {
    const groups: string[] = [];
    for (let g = 0; g < 3; g++) {
      let group = '';
      for (let c = 0; c < 4; c++) group += BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
      groups.push(group);
    }
    codes.push(groups.join('-'));
  }
  return codes;
}

function normalizeBackupCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function hashBackupCodes(codes: string[]) {
  return Promise.all(codes.map(async (code) => ({ hash: await bcrypt.hash(normalizeBackupCode(code), 10) })));
}

/** Creates the security record on first login. Returns the plain backup codes once. */
export async function bootstrapSecurityRecord(passwordHash: string): Promise<{ created: boolean; backupCodes: string[] }> {
  const codes = generateBackupCodes();
  const now = new Date();
  try {
    await (await db()).collection<SecurityDoc>('admin_security').insertOne({
      _id: SECURITY_ID,
      passwordHash,
      backupCodes: await hashBackupCodes(codes),
      sessionVersion: 1,
      passwordUpdatedAt: now,
      backupCodesUpdatedAt: now,
      createdAt: now,
    });
    invalidateVersionCache();
    return { created: true, backupCodes: codes };
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) return { created: false, backupCodes: [] }; // raced: already exists
    throw error;
  }
}

/** Sets a new password hash and bumps the session version. Returns the new version. */
export async function changeAdminPasswordHash(newHash: string): Promise<number> {
  const res = await (await db())
    .collection<SecurityDoc>('admin_security')
    .findOneAndUpdate(
      { _id: SECURITY_ID },
      { $set: { passwordHash: newHash, passwordUpdatedAt: new Date() }, $inc: { sessionVersion: 1 } },
      { returnDocument: 'after' }
    );
  invalidateVersionCache();
  return res?.sessionVersion ?? 1;
}

export async function regenerateBackupCodes(): Promise<string[]> {
  const codes = generateBackupCodes();
  await (await db())
    .collection<SecurityDoc>('admin_security')
    .updateOne({ _id: SECURITY_ID }, { $set: { backupCodes: await hashBackupCodes(codes), backupCodesUpdatedAt: new Date() } });
  return codes;
}

/** Marks a backup code as used if it matches an unused one. */
export async function consumeBackupCode(code: string): Promise<boolean> {
  const normalized = normalizeBackupCode(String(code ?? ''));
  if (normalized.length < 8) return false;
  const rec = await getSecurityRecord();
  if (!rec) return false;
  for (let i = 0; i < rec.backupCodes.length; i++) {
    const entry = rec.backupCodes[i];
    if (entry.usedAt) continue;
    if (await bcrypt.compare(normalized, entry.hash)) {
      const res = await (await db())
        .collection<SecurityDoc>('admin_security')
        .updateOne({ _id: SECURITY_ID, [`backupCodes.${i}.usedAt`]: { $exists: false } }, { $set: { [`backupCodes.${i}.usedAt`]: new Date() } });
      return res.modifiedCount === 1; // false if consumed concurrently
    }
  }
  return false;
}

export async function bumpSessionVersion(): Promise<number> {
  const res = await (await db())
    .collection<SecurityDoc>('admin_security')
    .findOneAndUpdate({ _id: SECURITY_ID }, { $inc: { sessionVersion: 1 } }, { returnDocument: 'after' });
  invalidateVersionCache();
  return res?.sessionVersion ?? 1;
}

const versionCache = { value: 1, at: 0 };
const VERSION_CACHE_MS = 10 * 1000;

function invalidateVersionCache() {
  versionCache.at = 0;
}

/** Current session version (cached 10s so per-request checks stay cheap). */
export async function getSessionVersion(fresh = false): Promise<number> {
  if (!fresh && Date.now() - versionCache.at < VERSION_CACHE_MS) return versionCache.value;
  const rec = await getSecurityRecord();
  versionCache.value = rec?.sessionVersion ?? 1;
  versionCache.at = Date.now();
  return versionCache.value;
}

// ---------------------------------------------------------------------------
// Attempts and lockouts
// ---------------------------------------------------------------------------

export async function getLockState(ip: string): Promise<LockState> {
  const now = new Date();
  const locks = await (await db())
    .collection<LockoutDoc>('admin_lockouts')
    .find({ _id: { $in: ['global', `ip:${ip}`] }, until: { $gt: now } })
    .toArray();
  const global = locks.find((l) => l.scope === 'global');
  if (global) return { locked: true, scope: 'global', until: global.until };
  const byIp = locks.find((l) => l.scope === 'ip');
  if (byIp) return { locked: true, scope: 'ip', until: byIp.until };
  return { locked: false };
}

/**
 * Records an attempt and, on failure, applies the lockout rules.
 * Returns how many failures this IP has in the window and whether a lock was
 * created by this attempt (so the caller can alert exactly once).
 */
export async function recordLoginAttempt(input: {
  ip: string;
  userAgent: string;
  kind: AttemptKind;
  success: boolean;
}): Promise<{ failuresFromIp: number; failuresGlobal: number; lockedNow: 'ip' | 'global' | null }> {
  const database = await db();
  const attempts = database.collection<LoginAttempt>('admin_login_attempts');
  const now = new Date();
  await attempts.insertOne({ ip: input.ip, userAgent: input.userAgent, kind: input.kind, success: input.success, at: now });
  if (input.success) return { failuresFromIp: 0, failuresGlobal: 0, lockedNow: null };

  const since = new Date(now.getTime() - LOGIN_RULES.failureWindowMs);
  const [failuresFromIp, failuresGlobal] = await Promise.all([
    attempts.countDocuments({ ip: input.ip, success: false, at: { $gte: since } }),
    attempts.countDocuments({ success: false, at: { $gte: since } }),
  ]);
  const lockouts = database.collection<LockoutDoc>('admin_lockouts');
  let lockedNow: 'ip' | 'global' | null = null;
  if (failuresGlobal >= LOGIN_RULES.globalFailLimit) {
    const res = await lockouts.updateOne(
      { _id: 'global', until: { $gt: now } },
      { $setOnInsert: { _id: 'global', scope: 'global', until: new Date(now.getTime() + LOGIN_RULES.globalLockMs) } },
      { upsert: true }
    );
    if (res.upsertedCount === 1) lockedNow = 'global';
  } else if (failuresFromIp >= LOGIN_RULES.ipFailLimit) {
    const res = await lockouts.updateOne(
      { _id: `ip:${input.ip}`, until: { $gt: now } },
      { $setOnInsert: { _id: `ip:${input.ip}`, scope: 'ip', until: new Date(now.getTime() + LOGIN_RULES.ipLockMs) } },
      { upsert: true }
    );
    if (res.upsertedCount === 1) lockedNow = 'ip';
  }
  return { failuresFromIp, failuresGlobal, lockedNow };
}

export async function listRecentLoginAttempts(limit = 20): Promise<LoginAttempt[]> {
  return (await db())
    .collection<LoginAttempt>('admin_login_attempts')
    .find({}, { projection: { _id: 0 } })
    .sort({ at: -1 })
    .limit(limit)
    .toArray();
}

// ---------------------------------------------------------------------------
// Login challenges (password accepted, Telegram code pending)
// ---------------------------------------------------------------------------

function codeHash(challengeId: string, code: string): string {
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  return createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
}

function newCode(): string {
  return String(randomInt(0, 10 ** LOGIN_RULES.codeLength)).padStart(LOGIN_RULES.codeLength, '0');
}

export async function createChallenge(input: { ip: string; userAgent: string; bootstrapHash?: string }): Promise<{ id: string; code: string }> {
  const id = randomHex(24);
  const code = newCode();
  const now = new Date();
  const doc: ChallengeDoc = {
    _id: id,
    codeHash: codeHash(id, code),
    expiresAt: new Date(now.getTime() + LOGIN_RULES.codeTtlMs),
    attempts: 0,
    sends: 1,
    ip: input.ip,
    userAgent: input.userAgent,
    createdAt: now,
  };
  if (input.bootstrapHash) doc.bootstrapHash = input.bootstrapHash;
  await (await db()).collection<ChallengeDoc>('admin_login_challenges').insertOne(doc);
  return { id, code };
}

export async function getChallenge(id: string): Promise<ChallengeDoc | null> {
  if (!id || id.length !== 48) return null;
  return (await db()).collection<ChallengeDoc>('admin_login_challenges').findOne({ _id: id, expiresAt: { $gt: new Date() } });
}

/** Issues a fresh code for an existing challenge (limited number of sends). */
export async function rotateChallengeCode(id: string): Promise<{ code: string; sendsLeft: number } | { error: 'not_found' | 'exhausted' }> {
  const code = newCode();
  const res = await (await db())
    .collection<ChallengeDoc>('admin_login_challenges')
    .findOneAndUpdate(
      { _id: id, expiresAt: { $gt: new Date() }, sends: { $lt: LOGIN_RULES.maxCodeSends } },
      { $set: { codeHash: codeHash(id, code), expiresAt: new Date(Date.now() + LOGIN_RULES.codeTtlMs) }, $inc: { sends: 1 } },
      { returnDocument: 'after' }
    );
  if (!res) {
    const existing = await getChallenge(id);
    return { error: existing ? 'exhausted' : 'not_found' };
  }
  return { code, sendsLeft: LOGIN_RULES.maxCodeSends - res.sends };
}

export async function verifyChallengeCode(
  id: string,
  code: string
): Promise<{ outcome: 'ok'; challenge: ChallengeDoc } | { outcome: 'wrong' | 'expired' | 'locked' }> {
  const collection = (await db()).collection<ChallengeDoc>('admin_login_challenges');
  // Count the attempt first so a wrong guess can never be retried for free.
  const challenge = await collection.findOneAndUpdate(
    { _id: id, expiresAt: { $gt: new Date() } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  );
  if (!challenge) return { outcome: 'expired' };
  if (challenge.attempts > LOGIN_RULES.maxCodeAttempts) {
    await collection.deleteOne({ _id: id });
    return { outcome: 'locked' };
  }
  const expected = Buffer.from(challenge.codeHash, 'hex');
  const actual = Buffer.from(codeHash(id, code), 'hex');
  const match = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!match) {
    if (challenge.attempts >= LOGIN_RULES.maxCodeAttempts) {
      await collection.deleteOne({ _id: id });
      return { outcome: 'locked' };
    }
    return { outcome: 'wrong' };
  }
  await collection.deleteOne({ _id: id });
  return { outcome: 'ok', challenge };
}

export async function deleteChallenge(id: string): Promise<void> {
  if (!id) return;
  await (await db()).collection<ChallengeDoc>('admin_login_challenges').deleteOne({ _id: id });
}
