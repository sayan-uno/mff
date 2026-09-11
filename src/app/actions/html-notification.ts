'use server';

/**
 * Raw-HTML notification actions ("HTML Notifier" admin section).
 *
 * This is a completely self-contained, additive feature that lets an admin send
 * an arbitrary, hand-written HTML notification card to:
 *   1. a single user (by Gaming ID),
 *   2. a hand-picked group of users (comma/newline separated Gaming IDs), or
 *   3. every active user (broadcast, with batched push + live progress tracking).
 *
 * It intentionally lives in its own file and does NOT modify the existing
 * single-user (`sendNotification`), multi-user (`sendNotificationToMultiple`) or
 * broadcast (`sendNotificationToAll`) actions — those keep working exactly as
 * before. The only thing this adds is writing the `html` field on the notification
 * documents, which the notification bell already knows how to render
 * (see src/components/layout/notification-bell.tsx). The plain-text `message`
 * stays as the fallback used by push notifications and any non-HTML client.
 *
 * SECURITY NOTE: the HTML is injected via `dangerouslySetInnerHTML` in the bell
 * (identical to how the existing server-built cards render). It is therefore
 * trusted content authored by an authenticated admin — exactly the same trust
 * model the app already uses for its refund / support / purchase cards. Every
 * action below re-checks `isAdminAuthenticated()` before doing anything.
 */

import { z } from 'zod';
import { isSafeHttpUrl, MEDIA_URL_ERROR } from '@/lib/media-urls';
import { connectToDatabase } from '@/lib/mongodb';
import { isAdminAuthenticated } from '@/app/actions';
import { type User, type Notification } from '@/lib/definitions';
import { sendPushNotification, sendMulticastPushNotification } from '@/lib/push-notifications';
import { sendBatchedPushNotifications } from '@/lib/broadcast-push-notifications';
import { revalidatePath } from 'next/cache';

// Push notifications (and any client that can't render HTML) need a plain-text
// body. The admin may supply one; otherwise we fall back to this.
const DEFAULT_FALLBACK_TEXT = 'You have a new notification from Garena Store.';

// Shared field validation. `html` is the only truly required piece; `message`
// is the optional plain-text fallback and `imageUrl` is optional.
const baseFields = {
    html: z.string().min(1, 'HTML content is required.'),
    message: z.string().optional(),
    imageUrl: z.string().trim().refine(isSafeHttpUrl, MEDIA_URL_ERROR).optional().or(z.literal('')),
};

const singleSchema = z.object({ gamingId: z.string().min(1, 'Gaming ID is required.'), ...baseFields });
const multiSchema = z.object({ gamingIds: z.string().min(1, 'At least one Gaming ID is required.'), ...baseFields });
const allSchema = z.object({ ...baseFields });

export interface HtmlNotificationResult {
    success: boolean;
    message: string;
    /** Gaming IDs that were entered but did not match any user (bulk mode). */
    notFound?: string[];
    /** Number of users the notification was actually delivered to. */
    sentCount?: number;
    /** Broadcast id (broadcast mode) so the UI can link to progress tracking. */
    broadcastId?: string;
}

/**
 * Parse a raw comma/newline-separated string into a clean, de-duplicated list of
 * Gaming IDs. Handles extra spaces, trailing commas, newlines and duplicates.
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

/** Build the notification document shared by all three modes. */
function buildNotificationDoc(
    gamingId: string,
    html: string,
    message: string,
    imageUrl: string | undefined,
    extra: Partial<Notification> = {}
): Omit<Notification, '_id'> {
    return {
        gamingId,
        message,                       // plain-text fallback (push / non-HTML clients)
        html,                          // the admin's raw HTML, rendered by the bell
        imageUrl: imageUrl || undefined,
        isRead: false,
        createdAt: new Date(),
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// 1. SINGLE USER
// ---------------------------------------------------------------------------
export async function sendHtmlNotificationToUser(formData: FormData): Promise<HtmlNotificationResult> {
    if (!(await isAdminAuthenticated())) return { success: false, message: 'Unauthorized' };

    const parsed = singleSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
        return { success: false, message: parsed.error.errors[0]?.message || 'Invalid data.' };
    }
    const { gamingId, html, message, imageUrl } = parsed.data;
    const fallbackText = (message && message.trim()) || DEFAULT_FALLBACK_TEXT;

    const db = await connectToDatabase();
    const user = await db.collection<User>('users').findOne({ gamingId });
    if (!user) return { success: false, message: 'User with that Gaming ID does not exist.' };

    await db.collection<Notification>('notifications').insertOne(
        buildNotificationDoc(gamingId, html, fallbackText, imageUrl) as Notification
    );

    if (user.fcmToken) {
        await sendPushNotification({
            token: user.fcmToken,
            title: 'Garena Store',
            body: fallbackText,
            imageUrl: imageUrl || undefined,
        });
    }

    revalidatePath('/');
    return { success: true, message: 'HTML notification sent successfully!', sentCount: 1 };
}

// ---------------------------------------------------------------------------
// 2. SELECTED BULK USERS
// ---------------------------------------------------------------------------
export async function sendHtmlNotificationToMultiple(formData: FormData): Promise<HtmlNotificationResult> {
    if (!(await isAdminAuthenticated())) return { success: false, message: 'Unauthorized' };

    const parsed = multiSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
        return { success: false, message: parsed.error.errors[0]?.message || 'Invalid data.' };
    }
    const { gamingIds: gamingIdsRaw, html, message, imageUrl } = parsed.data;
    const fallbackText = (message && message.trim()) || DEFAULT_FALLBACK_TEXT;

    const gamingIds = parseGamingIds(gamingIdsRaw);
    if (gamingIds.length === 0) {
        return { success: false, message: 'Please provide at least one valid Gaming ID.' };
    }

    const db = await connectToDatabase();
    const users = await db.collection<User>('users')
        .find({ gamingId: { $in: gamingIds } })
        .project({ gamingId: 1, fcmToken: 1 })
        .toArray() as Pick<User, 'gamingId' | 'fcmToken'>[];

    const foundIds = new Set(users.map(u => u.gamingId));
    const notFound = gamingIds.filter(id => !foundIds.has(id));

    if (users.length === 0) {
        return { success: false, message: 'None of the provided Gaming IDs matched an existing user.', notFound };
    }

    const notifications = users.map(u =>
        buildNotificationDoc(u.gamingId, html, fallbackText, imageUrl)
    );
    await db.collection<Notification>('notifications').insertMany(notifications as Notification[], { ordered: false });

    const tokens = users.map(u => u.fcmToken).filter((t): t is string => !!t);
    if (tokens.length > 0) {
        await sendMulticastPushNotification({
            tokens,
            title: 'Garena Store',
            body: fallbackText,
            imageUrl: imageUrl || undefined,
        });
    }

    revalidatePath('/');

    let resultMessage = `HTML notification sent to ${users.length} user${users.length === 1 ? '' : 's'}.`;
    if (notFound.length > 0) {
        resultMessage += ` ${notFound.length} ID${notFound.length === 1 ? '' : 's'} not found: ${notFound.join(', ')}.`;
    }
    return { success: true, message: resultMessage, notFound, sentCount: users.length };
}

// ---------------------------------------------------------------------------
// 3. BROADCAST TO ALL ACTIVE USERS
// ---------------------------------------------------------------------------
export async function sendHtmlNotificationToAll(formData: FormData): Promise<HtmlNotificationResult> {
    if (!(await isAdminAuthenticated())) return { success: false, message: 'Unauthorized' };

    const parsed = allSchema.safeParse(Object.fromEntries(formData.entries()));
    if (!parsed.success) {
        return { success: false, message: parsed.error.errors[0]?.message || 'Invalid data.' };
    }
    const { html, message, imageUrl } = parsed.data;
    const fallbackText = (message && message.trim()) || DEFAULT_FALLBACK_TEXT;

    const db = await connectToDatabase();
    const allUsers = await db.collection<User>('users')
        .find({ isBanned: { $ne: true }, isHidden: { $ne: true } })
        .project({ gamingId: 1, fcmToken: 1 })
        .toArray();

    if (allUsers.length === 0) {
        return { success: false, message: 'No active users found to send notifications to.' };
    }

    const tokens = allUsers
        .filter(u => !!u.fcmToken)
        .map(u => ({ token: u.fcmToken as string, gamingId: u.gamingId }));

    // Mirror the existing broadcast: a single broadcast_notifications doc tracks
    // delivery progress (shown on the Users Notification page). It stores the
    // plain-text fallback as its `message` for that history view.
    const broadcastDoc = {
        message: fallbackText,
        imageUrl: imageUrl || undefined,
        isPopup: false,
        createdAt: new Date(),
        totalUsers: allUsers.length,
        pushTotal: tokens.length,
        pushSent: 0,
        pushFailed: 0,
        status: 'sending' as const,
    };
    const broadcastResult = await db.collection('broadcast_notifications').insertOne(broadcastDoc);
    const broadcastId = broadcastResult.insertedId.toString();

    const notifications = allUsers.map(u =>
        buildNotificationDoc(u.gamingId, html, fallbackText, imageUrl, { broadcastId })
    );
    await db.collection<Notification>('notifications').insertMany(notifications as Notification[], { ordered: false });

    if (tokens.length > 0) {
        // Fire-and-forget batched push; progress is streamed via the existing SSE endpoint.
        sendBatchedPushNotifications(tokens, 'Garena Store', fallbackText, broadcastId, imageUrl || undefined)
            .catch(err => console.error('[HTML Broadcast] Background push sending failed:', err));
    } else {
        await db.collection('broadcast_notifications').updateOne(
            { _id: broadcastResult.insertedId },
            { $set: { status: 'completed' } }
        );
    }

    revalidatePath('/');
    return {
        success: true,
        message: `HTML notification sent to ${allUsers.length} users. Push notifications are being delivered in batches.`,
        broadcastId,
        sentCount: allUsers.length,
    };
}
