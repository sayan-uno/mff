import type { CustomAd } from '@/lib/definitions';
import { cookies } from 'next/headers';

// A simple in-memory cache to store ad locks.
// The key is a user identifier, and the value is the locked ad and a timestamp.
const adLockCache = new Map<string, { ad: CustomAd; expires: number }>();

// A unique identifier for the current user/session.
// We use a combination of the gaming_id cookie and a session-specific random value.
async function getUserLockKey(): Promise<string> {
    const gamingId = cookies().get('gaming_id')?.value;
    let sessionKey = cookies().get('ad_lock_session')?.value;

    if (!sessionKey) {
        sessionKey = Math.random().toString(36).substring(2, 15);
        cookies().set('ad_lock_session', sessionKey, { maxAge: 60 * 15, httpOnly: true }); // 15 minute session
    }
    
    return `${gamingId || 'guest'}_${sessionKey}`;
}


/**
 * Attempts to retrieve a "locked" ad for the current user from the cache.
 * @returns The cached CustomAd if a valid lock exists, otherwise null.
 */
export async function getLockedAd(): Promise<CustomAd | null> {
    const key = await getUserLockKey();
    const lockedItem = adLockCache.get(key);

    if (lockedItem && lockedItem.expires > Date.now()) {
        // The lock is still valid, return the cached ad.
        return lockedItem.ad;
    } else if (lockedItem) {
        // The lock has expired, remove it from the cache.
        adLockCache.delete(key);
    }
    
    return null;
}

/**
 * Creates a "lock" for the current user with a specific ad for 10 seconds.
 * @param ad The CustomAd to lock for the user.
 */
export async function setAdLock(ad: CustomAd): Promise<void> {
    const key = await getUserLockKey();
    const expires = Date.now() + 10 * 1000; // 10-second lock
    adLockCache.set(key, { ad, expires });
}
