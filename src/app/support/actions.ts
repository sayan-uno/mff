'use server';

import { cookies } from 'next/headers';
import { rateLimit } from '@/lib/rate-limit';
import { after } from 'next/server';
import { ObjectId } from 'mongodb';
import { unstable_noStore as noStore } from 'next/cache';
import { revalidatePath } from 'next/cache';
import { connectToDatabase } from '@/lib/mongodb';
import { isAdminAuthenticated } from '@/app/actions';
import type { SupportTicket, SupportMessage, SupportImage } from '@/lib/support-definitions';
import type { User, Notification } from '@/lib/definitions';
import { notifyUserOfSupportReply } from '@/lib/support-reply-notifier';
import { populateTicketFiles, deleteTicketFiles } from '@/lib/support-files';

const COLLECTION = 'support_tickets';
const IMAGE_COLLECTION = 'support_images';
const BLOCK_COLLECTION = 'support_blocks';
const MAX_TEXT_LENGTH = 2000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;        // 8 MB per image
const IMAGE_LIMIT_PER_HOUR = 10;                // Max images a user can send per hour
const ONE_HOUR_MS = 60 * 60 * 1000;
const SUPPORT_BLOCKED_MESSAGE = 'You are blocked from this feature. Please use email for support.';

// Whether a gaming id is blocked from using the support feature.
async function isGamingIdSupportBlocked(
    db: Awaited<ReturnType<typeof connectToDatabase>>,
    gamingId: string
): Promise<boolean> {
    const found = await db.collection(BLOCK_COLLECTION).findOne({ gamingId });
    return !!found;
}

// Helper: read the currently logged-in gaming id from the cookie.
function getCurrentGamingId(): string | undefined {
    return cookies().get('gaming_id')?.value;
}

// Estimate the real byte size of a base64 data URI.
function dataUriByteSize(dataUri: string): number {
    const base64 = dataUri.split(',')[1] || '';
    const len = base64.length;
    if (len === 0) return 0;
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor((len * 3) / 4) - padding;
}

// Attach the actual image data URIs to a ticket's messages for viewing.
// (The ticket itself only stores lightweight image IDs.)
async function populateTicketImages(
    db: Awaited<ReturnType<typeof connectToDatabase>>,
    ticket: SupportTicket
): Promise<SupportTicket> {
    const ids: ObjectId[] = [];
    for (const m of ticket.messages) {
        for (const id of m.imageIds || []) {
            if (ObjectId.isValid(id)) ids.push(new ObjectId(id));
        }
    }
    if (ids.length === 0) return ticket;

    const images = await db
        .collection<SupportImage>(IMAGE_COLLECTION)
        .find({ _id: { $in: ids } })
        .toArray();
    const map = new Map(images.map((img) => [img._id.toString(), img.dataUri]));

    ticket.messages = ticket.messages.map((m) => ({
        ...m,
        images: (m.imageIds || [])
            .map((id) => ({ _id: id, url: map.get(id) || '' }))
            .filter((x) => x.url),
    }));
    return ticket;
}

// ---------------------------------------------------------------------------
// USER-FACING ACTIONS
// ---------------------------------------------------------------------------

// Returns whether the visitor currently has a gaming profile (gaming_id cookie).
export async function getSupportUser(): Promise<{ gamingId: string; visualGamingId?: string } | null> {
    noStore();
    const gamingId = getCurrentGamingId();
    if (!gamingId) return null;

    try {
        const db = await connectToDatabase();
        const user = await db.collection<User>('users').findOne({ gamingId });
        if (!user) return null;
        return {
            gamingId: user.gamingId,
            visualGamingId: user.visualGamingId,
        };
    } catch (error) {
        console.error('Support: failed to read user', error);
        return null;
    }
}

// Get all tickets belonging to the current user (newest first).
export async function getMyTickets(): Promise<SupportTicket[]> {
    noStore();
    const gamingId = getCurrentGamingId();
    if (!gamingId) return [];

    const db = await connectToDatabase();
    const tickets = await db.collection<SupportTicket>(COLLECTION)
        .find({ gamingId })
        .sort({ updatedAt: -1 })
        .toArray();

    return JSON.parse(JSON.stringify(tickets));
}

// Get a single ticket (verifying it belongs to the current user).
export async function getMyTicket(ticketId: string): Promise<SupportTicket | null> {
    noStore();
    const gamingId = getCurrentGamingId();
    if (!gamingId || !ObjectId.isValid(ticketId)) return null;

    const db = await connectToDatabase();
    const ticket = await db.collection<SupportTicket>(COLLECTION).findOne({
        _id: new ObjectId(ticketId),
        gamingId,
    });

    if (!ticket) return null;
    await populateTicketImages(db, ticket);
    await populateTicketFiles(db, ticket);
    return JSON.parse(JSON.stringify(ticket));
}

// Escape a string so it can be safely used inside a RegExp.
function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Create a new report (ticket) with the first user message.
// The report is auto-named using `namePrefix` + a per-user sequence number,
// e.g. "Support Report 1", "Support Report 2", or "Refund Request 1".
export async function createTicket(
    message: string,
    namePrefix: string = 'Support Report'
): Promise<{ success: boolean; message: string; ticketId?: string }> {
    const gamingId = getCurrentGamingId();
    if (!gamingId) {
        return { success: false, message: 'Please open the app and set your Free Fire ID first.' };
    }

    const cleanMessage = (message || '').trim();
    const prefix = (namePrefix || 'Support Report').trim() || 'Support Report';

    if (!cleanMessage) {
        return { success: false, message: 'Please write a message.' };
    }
    if (cleanMessage.length > MAX_TEXT_LENGTH) {
        return { success: false, message: 'Message is too long.' };
    }

    try {
        const db = await connectToDatabase();

        if (await isGamingIdSupportBlocked(db, gamingId)) {
            return { success: false, message: SUPPORT_BLOCKED_MESSAGE };
        }

        const user = await db.collection<User>('users').findOne({ gamingId });

        // Work out the next sequence number for this user + report type.
        const existingCount = await db.collection<SupportTicket>(COLLECTION).countDocuments({
            gamingId,
            subject: { $regex: `^${escapeRegex(prefix)} \\d+$` },
        });
        const subject = `${prefix} ${existingCount + 1}`;

        const now = new Date();
        const firstMessage: SupportMessage = {
            _id: new ObjectId(),
            sender: 'user',
            text: cleanMessage,
            createdAt: now,
        };

        const newTicket: Omit<SupportTicket, '_id'> = {
            gamingId,
            visualGamingId: user?.visualGamingId,
            subject,
            status: 'open',
            messages: [firstMessage],
            lastSenderRole: 'user',
            userUnread: 0,
            adminUnread: 1,
            createdAt: now,
            updatedAt: now,
        };

        const result = await db.collection<SupportTicket>(COLLECTION).insertOne(newTicket as SupportTicket);

        revalidatePath('/admin/support');
        return { success: true, message: 'Report created.', ticketId: result.insertedId.toString() };
    } catch (error) {
        console.error('Support: failed to create ticket', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}

// User sends a message in an existing ticket.
export async function sendUserMessage(
    ticketId: string,
    text: string
): Promise<{ success: boolean; message: string }> {
    const gamingId = getCurrentGamingId();
    if (!gamingId) {
        return { success: false, message: 'You are not logged in.' };
    }
    if (!ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Invalid report.' };
    }

    const cleanText = (text || '').trim();
    if (!cleanText) {
        return { success: false, message: 'Please write a message.' };
    }
    if (cleanText.length > MAX_TEXT_LENGTH) {
        return { success: false, message: 'Message is too long.' };
    }

    try {
        const db = await connectToDatabase();

        if (await isGamingIdSupportBlocked(db, gamingId)) {
            return { success: false, message: SUPPORT_BLOCKED_MESSAGE };
        }

        const newMessage: SupportMessage = {
            _id: new ObjectId(),
            sender: 'user',
            text: cleanText,
            createdAt: new Date(),
        };

        const result = await db.collection<SupportTicket>(COLLECTION).updateOne(
            { _id: new ObjectId(ticketId), gamingId },
            {
                $push: { messages: newMessage },
                $set: { lastSenderRole: 'user', status: 'open', updatedAt: new Date() },
                $inc: { adminUnread: 1 },
            }
        );

        if (result.matchedCount === 0) {
            return { success: false, message: 'Report not found.' };
        }

        revalidatePath('/admin/support');
        return { success: true, message: 'Sent.' };
    } catch (error) {
        console.error('Support: failed to send user message', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}

// Mark all admin replies in a ticket as read by the user.
// `userLastReadAt` is stamped to "now" — this is the user's genuine presence
// signal. The user client only calls this while the chat tab is open AND
// visible (and the call only succeeds while online), so the timestamp staying
// fresh means the user is actually looking at the chat. The admin's "seen"
// read-receipt and the 3-second reply-notification rule both rely on it.
export async function markTicketReadByUser(ticketId: string): Promise<{ success: boolean }> {
    const gamingId = getCurrentGamingId();
    if (!gamingId || !ObjectId.isValid(ticketId)) {
        return { success: false };
    }

    const db = await connectToDatabase();
    await db.collection<SupportTicket>(COLLECTION).updateOne(
        { _id: new ObjectId(ticketId), gamingId },
        { $set: { userUnread: 0, userLastReadAt: new Date() } }
    );

    // The user has now genuinely seen this report's replies, so clear any
    // reply notifications we left in their bell for THIS ticket — this keeps the
    // bell history from piling up when they repeatedly leave/re-open the chat.
    // Scoped tightly to this user + ticket + the support_reply tag so no other
    // notification kind (orders, gifts, broadcasts, …) is ever touched.
    await db.collection<Notification>('notifications').deleteMany({
        gamingId,
        type: 'support_reply',
        supportTicketId: ticketId,
    });

    return { success: true };
}

// Three seconds after an admin reply, decide whether the report owner needs a
// notification. We deliberately do NOT notify at send time: if the user is
// actively viewing the chat their client will have marked the reply read within
// this window (fast poll), so we stay quiet. If the user never saw it — they
// never opened the chat, minimised the browser, or lost connection — the read
// timestamp stays stale and we send the website + FCM notification.
//
// Runs via `after()` so it executes on the server *after* the admin's response
// is returned (the reply itself is never delayed).
function scheduleUnseenReplyNotification(ticketId: string, replyAt: Date): void {
    after(async () => {
        try {
            await new Promise((resolve) => setTimeout(resolve, 3000));

            const db = await connectToDatabase();
            const ticket = await db.collection<SupportTicket>(COLLECTION).findOne(
                { _id: new ObjectId(ticketId) },
                { projection: { gamingId: 1, subject: 1, userLastReadAt: 1, lastSenderRole: 1, messages: { $slice: -1 } } }
            );
            if (!ticket) return;

            // Only notify if this admin reply is STILL the latest message. If the
            // admin sent another message, or the user already replied, that later
            // event owns the decision — this avoids duplicate notifications.
            const last = ticket.messages?.[ticket.messages.length - 1];
            const isStillLatestReply =
                ticket.lastSenderRole === 'admin' &&
                !!last &&
                last.sender === 'admin' &&
                new Date(last.createdAt).getTime() === replyAt.getTime();
            if (!isStillLatestReply) return;

            // Seen in time → stay silent. This is what protects the user from
            // getting pinged for a message they were already reading.
            const seen =
                !!ticket.userLastReadAt &&
                new Date(ticket.userLastReadAt).getTime() >= replyAt.getTime();
            if (seen) return;

            await notifyUserOfSupportReply(db, ticket.gamingId, ticket.subject, ticketId);
        } catch (error) {
            console.error('Support: deferred reply notification failed', error);
        }
    });
}

// ---------------------------------------------------------------------------
// IMAGE ATTACHMENTS (user-facing)
// ---------------------------------------------------------------------------

// How many images the user may still send in the current rolling hour window.
// This is counted across ALL the user's reports, so the limit persists even
// when the user opens a brand new report.
export async function getImageQuota(): Promise<{ used: number; remaining: number; limit: number }> {
    noStore();
    const gamingId = getCurrentGamingId();
    if (!gamingId) {
        return { used: 0, remaining: 0, limit: IMAGE_LIMIT_PER_HOUR };
    }
    const db = await connectToDatabase();
    const since = new Date(Date.now() - ONE_HOUR_MS);
    const used = await db
        .collection<SupportImage>(IMAGE_COLLECTION)
        .countDocuments({ gamingId, createdAt: { $gt: since }, uploadedBy: { $ne: 'admin' } });
    return {
        used,
        remaining: Math.max(0, IMAGE_LIMIT_PER_HOUR - used),
        limit: IMAGE_LIMIT_PER_HOUR,
    };
}

// Upload a single image (sent one at a time to stay within request size limits).
// Validates the 8 MB cap and the per-hour rate limit before storing.
export async function uploadSupportImage(
    ticketId: string,
    dataUri: string
): Promise<{ success: boolean; message: string; imageId?: string }> {
    const gamingId = getCurrentGamingId();
    if (!gamingId) {
        return { success: false, message: 'You are not logged in.' };
    }
    if (!ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Invalid report.' };
    }
    if (!rateLimit(`support-image:${gamingId}`, { limit: 30, windowMs: 10 * 60 * 1000 }).allowed) {
        return { success: false, message: 'Too many uploads in a short time. Please wait a few minutes.' };
    }
    if (!dataUri || !dataUri.startsWith('data:image/')) {
        return { success: false, message: 'Only image files are supported.' };
    }
    if (dataUriByteSize(dataUri) > MAX_IMAGE_BYTES) {
        return { success: false, message: 'Max 8 MB images are supported.' };
    }

    try {
        const db = await connectToDatabase();

        if (await isGamingIdSupportBlocked(db, gamingId)) {
            return { success: false, message: SUPPORT_BLOCKED_MESSAGE };
        }

        // Verify the ticket belongs to this user.
        const ticket = await db.collection<SupportTicket>(COLLECTION).findOne({
            _id: new ObjectId(ticketId),
            gamingId,
        });
        if (!ticket) {
            return { success: false, message: 'Report not found.' };
        }

        // Enforce the per-hour image limit (across all of the user's reports).
        const since = new Date(Date.now() - ONE_HOUR_MS);
        const used = await db
            .collection<SupportImage>(IMAGE_COLLECTION)
            .countDocuments({ gamingId, createdAt: { $gt: since }, uploadedBy: { $ne: 'admin' } });
        if (used >= IMAGE_LIMIT_PER_HOUR) {
            return { success: false, message: 'You can only send 10 images in every hour.' };
        }

        const imageDoc: Omit<SupportImage, '_id'> = {
            ticketId,
            gamingId,
            dataUri,
            uploadedBy: 'user',
            createdAt: new Date(),
        };
        const result = await db
            .collection<SupportImage>(IMAGE_COLLECTION)
            .insertOne(imageDoc as SupportImage);

        return { success: true, message: 'Uploaded.', imageId: result.insertedId.toString() };
    } catch (error) {
        console.error('Support: failed to upload image', error);
        return { success: false, message: 'Failed to upload image. Please try again.' };
    }
}

// After all images are uploaded, append one chat message referencing them
// (optionally with a caption). Images appear together like a WhatsApp album.
export async function sendUserImageMessage(
    ticketId: string,
    imageIds: string[],
    caption: string = ''
): Promise<{ success: boolean; message: string }> {
    const gamingId = getCurrentGamingId();
    if (!gamingId) {
        return { success: false, message: 'You are not logged in.' };
    }
    if (!ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Invalid report.' };
    }

    const validIds = (imageIds || []).filter((id) => ObjectId.isValid(id));
    if (validIds.length === 0) {
        return { success: false, message: 'No images to send.' };
    }

    const cleanCaption = (caption || '').trim().slice(0, MAX_TEXT_LENGTH);

    try {
        const db = await connectToDatabase();

        if (await isGamingIdSupportBlocked(db, gamingId)) {
            return { success: false, message: SUPPORT_BLOCKED_MESSAGE };
        }

        const newMessage: SupportMessage = {
            _id: new ObjectId(),
            sender: 'user',
            text: cleanCaption,
            imageIds: validIds,
            createdAt: new Date(),
        };

        const result = await db.collection<SupportTicket>(COLLECTION).updateOne(
            { _id: new ObjectId(ticketId), gamingId },
            {
                $push: { messages: newMessage },
                $set: { lastSenderRole: 'user', status: 'open', updatedAt: new Date() },
                $inc: { adminUnread: 1 },
            }
        );

        if (result.matchedCount === 0) {
            return { success: false, message: 'Report not found.' };
        }

        revalidatePath('/admin/support');
        return { success: true, message: 'Sent.' };
    } catch (error) {
        console.error('Support: failed to send image message', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}

// ---------------------------------------------------------------------------
// ADMIN-FACING ACTIONS
// ---------------------------------------------------------------------------

// Get every ticket (admin only), newest activity first.
export async function getAllTicketsForAdmin(): Promise<SupportTicket[]> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return [];

    const db = await connectToDatabase();
    const tickets = await db.collection<SupportTicket>(COLLECTION)
        .find({})
        .sort({ updatedAt: -1 })
        .toArray();

    return JSON.parse(JSON.stringify(tickets));
}

// Get a single ticket (admin only).
export async function getTicketForAdmin(ticketId: string): Promise<SupportTicket | null> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !ObjectId.isValid(ticketId)) return null;

    const db = await connectToDatabase();
    const ticket = await db.collection<SupportTicket>(COLLECTION).findOne({ _id: new ObjectId(ticketId) });
    if (!ticket) return null;
    await populateTicketImages(db, ticket);
    await populateTicketFiles(db, ticket);
    return JSON.parse(JSON.stringify(ticket));
}

// Admin replies to a ticket.
export async function sendAdminReply(
    ticketId: string,
    text: string
): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized.' };
    }
    if (!ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Invalid report.' };
    }

    const cleanText = (text || '').trim();
    if (!cleanText) {
        return { success: false, message: 'Please write a reply.' };
    }
    if (cleanText.length > MAX_TEXT_LENGTH) {
        return { success: false, message: 'Reply is too long.' };
    }

    try {
        const db = await connectToDatabase();
        const now = new Date();
        const newMessage: SupportMessage = {
            _id: new ObjectId(),
            sender: 'admin',
            text: cleanText,
            createdAt: now,
        };

        const result = await db.collection<SupportTicket>(COLLECTION).updateOne(
            { _id: new ObjectId(ticketId) },
            {
                $push: { messages: newMessage },
                $set: { lastSenderRole: 'admin', updatedAt: now },
                $inc: { userUnread: 1 },
            }
        );

        if (result.matchedCount === 0) {
            return { success: false, message: 'Report not found.' };
        }

        // Notify the report owner only if they haven't seen this reply within 3s
        // (website bell + FCM). Deferred so an actively-watching user stays unpinged.
        scheduleUnseenReplyNotification(ticketId, now);

        return { success: true, message: 'Reply sent.' };
    } catch (error) {
        console.error('Support: failed to send admin reply', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}

// Admin uploads a single image (sent one at a time). No hourly limit for admins.
export async function uploadAdminImage(
    ticketId: string,
    dataUri: string
): Promise<{ success: boolean; message: string; imageId?: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized.' };
    }
    if (!ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Invalid report.' };
    }
    if (!dataUri || !dataUri.startsWith('data:image/')) {
        return { success: false, message: 'Only image files are supported.' };
    }
    if (dataUriByteSize(dataUri) > MAX_IMAGE_BYTES) {
        return { success: false, message: 'Max 8 MB images are supported.' };
    }

    try {
        const db = await connectToDatabase();
        const ticket = await db.collection<SupportTicket>(COLLECTION).findOne({ _id: new ObjectId(ticketId) });
        if (!ticket) {
            return { success: false, message: 'Report not found.' };
        }

        const imageDoc: Omit<SupportImage, '_id'> = {
            ticketId,
            gamingId: ticket.gamingId,
            dataUri,
            uploadedBy: 'admin',
            createdAt: new Date(),
        };
        const result = await db
            .collection<SupportImage>(IMAGE_COLLECTION)
            .insertOne(imageDoc as SupportImage);

        return { success: true, message: 'Uploaded.', imageId: result.insertedId.toString() };
    } catch (error) {
        console.error('Support: failed to upload admin image', error);
        return { success: false, message: 'Failed to upload image. Please try again.' };
    }
}

// Admin posts a chat message with one or more images (optional caption).
export async function sendAdminImageMessage(
    ticketId: string,
    imageIds: string[],
    caption: string = ''
): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized.' };
    }
    if (!ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Invalid report.' };
    }

    const validIds = (imageIds || []).filter((id) => ObjectId.isValid(id));
    if (validIds.length === 0) {
        return { success: false, message: 'No images to send.' };
    }

    const cleanCaption = (caption || '').trim().slice(0, MAX_TEXT_LENGTH);

    try {
        const db = await connectToDatabase();
        const now = new Date();
        const newMessage: SupportMessage = {
            _id: new ObjectId(),
            sender: 'admin',
            text: cleanCaption,
            imageIds: validIds,
            createdAt: now,
        };

        const result = await db.collection<SupportTicket>(COLLECTION).updateOne(
            { _id: new ObjectId(ticketId) },
            {
                $push: { messages: newMessage },
                $set: { lastSenderRole: 'admin', updatedAt: now },
                $inc: { userUnread: 1 },
            }
        );

        if (result.matchedCount === 0) {
            return { success: false, message: 'Report not found.' };
        }

        // Notify the report owner only if they haven't seen this reply within 3s
        // (website bell + FCM). Deferred so an actively-watching user stays unpinged.
        scheduleUnseenReplyNotification(ticketId, now);

        return { success: true, message: 'Sent.' };
    } catch (error) {
        console.error('Support: failed to send admin image message', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}

// Mark all user messages in a ticket as read by the admin.
export async function markTicketReadByAdmin(ticketId: string): Promise<{ success: boolean }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !ObjectId.isValid(ticketId)) {
        return { success: false };
    }

    const db = await connectToDatabase();
    await db.collection<SupportTicket>(COLLECTION).updateOne(
        { _id: new ObjectId(ticketId) },
        { $set: { adminUnread: 0 } }
    );
    return { success: true };
}

// Admin toggles a ticket open/closed.
export async function setTicketStatus(
    ticketId: string,
    status: 'open' | 'closed'
): Promise<{ success: boolean }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !ObjectId.isValid(ticketId)) {
        return { success: false };
    }

    const db = await connectToDatabase();
    await db.collection<SupportTicket>(COLLECTION).updateOne(
        { _id: new ObjectId(ticketId) },
        { $set: { status, updatedAt: new Date() } }
    );
    return { success: true };
}

// Admin permanently deletes a whole report (ticket) and all of its images.
// The report then disappears from the user's support page entirely.
export async function deleteTicket(ticketId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Unauthorized.' };
    }

    try {
        const db = await connectToDatabase();
        await db.collection<SupportImage>(IMAGE_COLLECTION).deleteMany({ ticketId });
        await deleteTicketFiles(db, [ticketId]);
        await db.collection<SupportTicket>(COLLECTION).deleteOne({ _id: new ObjectId(ticketId) });
        revalidatePath('/admin/support');
        return { success: true, message: 'Report deleted.' };
    } catch (error) {
        console.error('Support: failed to delete ticket', error);
        return { success: false, message: 'Failed to delete report.' };
    }
}

// Admin deletes several reports at once by their _id, including each report's
// images. Used by the "Delete Selected" / "Delete All in Filter" actions.
export async function deleteTickets(ticketIds: string[]): Promise<{ success: boolean; message: string; deletedCount: number }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized.', deletedCount: 0 };
    }

    const validIds = (ticketIds || []).filter((id) => ObjectId.isValid(id));
    if (validIds.length === 0) {
        return { success: false, message: 'No valid reports selected.', deletedCount: 0 };
    }

    try {
        const db = await connectToDatabase();
        const objectIds = validIds.map((id) => new ObjectId(id));
        // Remove the images + GridFS files attached to these reports, then the reports.
        await db.collection<SupportImage>(IMAGE_COLLECTION).deleteMany({ ticketId: { $in: validIds } });
        await deleteTicketFiles(db, validIds);
        const result = await db.collection<SupportTicket>(COLLECTION).deleteMany({ _id: { $in: objectIds } });
        revalidatePath('/admin/support');
        return { success: true, message: `Deleted ${result.deletedCount} report(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Support: failed to delete tickets', error);
        return { success: false, message: 'Failed to delete reports.', deletedCount: 0 };
    }
}

// Whether a given gaming id is blocked from the support feature (admin only).
export async function getSupportBlockStatus(gamingId: string): Promise<boolean> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !gamingId) return false;
    const db = await connectToDatabase();
    return isGamingIdSupportBlocked(db, gamingId);
}

// Admin blocks a user from using the support feature.
export async function blockSupportUser(gamingId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !gamingId) {
        return { success: false, message: 'Unauthorized.' };
    }
    const db = await connectToDatabase();
    await db.collection(BLOCK_COLLECTION).updateOne(
        { gamingId },
        { $set: { gamingId, createdAt: new Date() } },
        { upsert: true }
    );
    return { success: true, message: 'User blocked from support.' };
}

// Admin unblocks a user.
export async function unblockSupportUser(gamingId: string): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !gamingId) {
        return { success: false, message: 'Unauthorized.' };
    }
    const db = await connectToDatabase();
    await db.collection(BLOCK_COLLECTION).deleteOne({ gamingId });
    return { success: true, message: 'User unblocked.' };
}
