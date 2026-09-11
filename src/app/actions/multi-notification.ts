'use server';

/**
 * Multi-user (selected group) notification action.
 *
 * This is a self-contained, additive feature that lets an admin send the same
 * notification to a hand-picked set of users by entering several Gaming IDs
 * separated by commas (e.g. "1111111111, 2222222222"). It intentionally lives
 * in its own file and does NOT modify the existing single-user
 * (`sendNotification`) or broadcast (`sendNotificationToAll`) actions, so those
 * keep working exactly as before.
 */

import { z } from 'zod';
import { isSafeHttpUrl, MEDIA_URL_ERROR } from '@/lib/media-urls';
import { connectToDatabase } from '@/lib/mongodb';
import { isAdminAuthenticated } from '@/app/actions';
import { type User, type Notification } from '@/lib/definitions';
import { sendMulticastPushNotification } from '@/lib/push-notifications';
import { revalidatePath } from 'next/cache';

const multiNotificationSchema = z.object({
    gamingIds: z.string().min(1, 'At least one Gaming ID is required.'),
    message: z.string().min(1, 'Message is required.'),
    imageUrl: z.string().trim().refine(isSafeHttpUrl, MEDIA_URL_ERROR).optional().or(z.literal('')),
    isPopup: z.enum(['on', 'off']).optional(),
});

export interface MultiNotificationResult {
    success: boolean;
    message: string;
    /** Gaming IDs that were entered but did not match any user. */
    notFound?: string[];
    /** Number of users the notification was actually delivered to. */
    sentCount?: number;
}

/**
 * Parse a raw comma-separated string into a clean, de-duplicated list of
 * Gaming IDs. Handles extra spaces, trailing commas, newlines and accidental
 * duplicates.
 */
function parseGamingIds(raw: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const part of raw.split(/[,\n]/)) {
        const id = part.trim();
        if (id && !seen.has(id)) {
            seen.add(id);
            result.push(id);
        }
    }
    return result;
}

export async function sendNotificationToMultiple(formData: FormData): Promise<MultiNotificationResult> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized' };
    }

    const rawFormData = Object.fromEntries(formData.entries());
    const validatedFields = multiNotificationSchema.safeParse(rawFormData);

    if (!validatedFields.success) {
        return { success: false, message: 'Invalid data. Please provide Gaming IDs and a message.' };
    }

    const { gamingIds: gamingIdsRaw, message, imageUrl } = validatedFields.data;
    const isPopup = rawFormData.isPopup === 'on';

    const gamingIds = parseGamingIds(gamingIdsRaw);
    if (gamingIds.length === 0) {
        return { success: false, message: 'Please provide at least one valid Gaming ID.' };
    }

    const db = await connectToDatabase();

    // Find all matching users in a single query.
    const users = await db.collection<User>('users')
        .find({ gamingId: { $in: gamingIds } })
        .project({ gamingId: 1, fcmToken: 1 })
        .toArray() as Pick<User, 'gamingId' | 'fcmToken'>[];

    const foundIds = new Set(users.map(u => u.gamingId));
    const notFound = gamingIds.filter(id => !foundIds.has(id));

    if (users.length === 0) {
        return {
            success: false,
            message: 'None of the provided Gaming IDs matched an existing user.',
            notFound,
        };
    }

    // Insert one notification document per matching user so each user sees it
    // in their notification bell.
    const now = new Date();
    const notifications: Omit<Notification, '_id'>[] = users.map(user => ({
        gamingId: user.gamingId,
        message,
        imageUrl: imageUrl || undefined,
        isRead: false,
        createdAt: now,
        isPopup,
    }));

    await db.collection<Notification>('notifications').insertMany(
        notifications as Notification[],
        { ordered: false }
    );

    // Send push notifications to users who have a registered FCM token.
    const tokens = users
        .map(u => u.fcmToken)
        .filter((t): t is string => !!t);

    if (tokens.length > 0) {
        await sendMulticastPushNotification({
            tokens,
            title: 'Garena Store',
            body: message,
            imageUrl: imageUrl || undefined,
        });
    }

    revalidatePath('/'); // Refresh the notification bell for recipients.

    let resultMessage = `Notification sent to ${users.length} user${users.length === 1 ? '' : 's'}.`;
    if (notFound.length > 0) {
        resultMessage += ` ${notFound.length} ID${notFound.length === 1 ? '' : 's'} not found: ${notFound.join(', ')}.`;
    }

    return {
        success: true,
        message: resultMessage,
        notFound,
        sentCount: users.length,
    };
}
