'use server';

import { connectToDatabase } from '@/lib/mongodb';
import { User } from '@/lib/definitions';
import { cookies, headers } from 'next/headers';
import { rateLimit } from '@/lib/rate-limit';
import { getClientIp, UNKNOWN_IP } from '@/lib/client-ip';

/**
 * Logs the current user's IP address to their user document.
 */
export async function logUserIp() {
  const gamingId = cookies().get('gaming_id')?.value;
  if (!gamingId) {
    return; // No user logged in, nothing to log.
  }

  // Get IP address from headers
  const resolvedIp = getClientIp(await headers());
  const ip = resolvedIp === UNKNOWN_IP ? '127.0.0.1' : resolvedIp;
  
  if (!ip) {
      return; // No IP found
  }
  // Floods from one address must not fill the user document; skip silently.
  if (!rateLimit(`iplog:${ip}`, { limit: 30, windowMs: 10 * 60 * 1000 }).allowed) {
      return;
  }

  try {
    const db = await connectToDatabase();
    
    const ipHistoryEntry = {
        ip,
        timestamp: new Date(),
    };

    await db.collection<User>('users').updateOne(
      { gamingId },
      { $push: { ipHistory: ipHistoryEntry } }
    );
  } catch (error) {
    // Log the error but don't crash the request, as this is a background task.
    console.error('Failed to log user IP:', error);
  }
}
