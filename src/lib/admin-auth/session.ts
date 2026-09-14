/**
 * Admin session tokens: signed JWTs (HS256 with SESSION_SECRET) stored in an
 * httpOnly cookie. Replaces the old forgeable `admin_session=true` cookie.
 *
 * This module is imported by `middleware.ts` (Edge runtime), so it must only
 * use `jose` and Web Crypto: no Node built-ins, no database access.
 *
 * A token carries the security record's `sessionVersion` (`ver`). Changing the
 * admin password or pressing "log out everywhere" bumps that number, which
 * invalidates every existing token at the next server-side check.
 */

import { SignJWT, jwtVerify } from 'jose';

export const ADMIN_SESSION_COOKIE = 'admin_session';
export const ADMIN_CHALLENGE_COOKIE = 'admin_login_challenge';
export const ADMIN_SESSION_HOURS = 12;

const ISSUER = 'garena-admin';
const AUDIENCE = 'admin-panel';
const MIN_SECRET_LENGTH = 32;

export interface AdminSessionPayload {
  ver: number;
  jti: string;
  iat: number;
  exp: number;
}

function secretKey(): Uint8Array | null {
  const secret = (process.env.SESSION_SECRET ?? '').trim();
  if (secret.length < MIN_SECRET_LENGTH) return null;
  return new TextEncoder().encode(secret);
}

/** True when SESSION_SECRET exists and is long enough to sign with. */
export function isAdminSigningConfigured(): boolean {
  return secretKey() !== null;
}

export async function createAdminSessionToken(version: number): Promise<{ token: string; expires: Date }> {
  const key = secretKey();
  if (!key) throw new Error(`SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters.`);
  const expires = new Date(Date.now() + ADMIN_SESSION_HOURS * 60 * 60 * 1000);
  const token = await new SignJWT({ role: 'admin', ver: version })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(randomHex(16))
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key);
  return { token, expires };
}

/** Verifies signature, issuer, audience and expiry. Returns null for anything invalid. */
export async function verifyAdminSessionToken(token: string | undefined | null): Promise<AdminSessionPayload | null> {
  if (!token) return null;
  const key = secretKey();
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
    if (payload.role !== 'admin' || typeof payload.ver !== 'number' || typeof payload.jti !== 'string') return null;
    return { ver: payload.ver, jti: payload.jti, iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  } catch {
    return null;
  }
}

export function adminCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    expires,
  };
}

/** Cryptographically random lower-case hex string of `bytes` bytes. */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
