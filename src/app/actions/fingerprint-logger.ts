
'use server';

import { connectToDatabase } from '@/lib/mongodb';
import { User } from '@/lib/definitions';
import { cookies, headers } from 'next/headers';
import { rateLimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';

/**
 * Logs the current user's device fingerprint to their user document.
 */
export async function logUserFingerprint(fingerprint: string) {
  const gamingId = cookies().get('gaming_id')?.value;
  if (!gamingId || !fingerprint) {
    return; // No user logged in or no fingerprint generated.
  }
  const requestHeaders = await headers();
  const ip = getClientIp(requestHeaders);
  if (typeof fingerprint !== 'string' || fingerprint.length > 200 || !rateLimit(`fplog:${ip}`, { limit: 30, windowMs: 10 * 60 * 1000 }).allowed) {
    return; // Malformed or flooding: skip silently.
  }

  try {
    const db = await connectToDatabase();
    
    const fingerprintHistoryEntry = {
        fingerprint,
        timestamp: new Date(),
    };

    await db.collection<User>('users').updateOne(
      { gamingId },
      { $push: { fingerprintHistory: fingerprintHistoryEntry } }
    );
  } catch (error) {
    // Log the error but don't crash the request, as this is a background task.
    console.error('Failed to log user fingerprint:', error);
  }
}
