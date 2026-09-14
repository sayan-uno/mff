import { cookies } from 'next/headers';
import { randomBytes } from 'crypto';

// This file is now deprecated in favor of the new user actions in `src/app/actions.ts`
// --- User Identification ---
export async function getUserId(): Promise<string | null> {
    const userIdCookie = cookies().get('user_id')?.value;
    if (userIdCookie) {
        return userIdCookie;
    }
    return null;
}

export async function ensureUserId(): Promise<string> {
    let userId = await getUserId();
    if (!userId) {
        userId = randomBytes(16).toString('hex');
        cookies().set('user_id', userId, {
            maxAge: 365 * 24 * 60 * 60, // 1 year
            path: '/',
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
        });
    }
    return userId;
}
