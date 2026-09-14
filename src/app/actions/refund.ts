'use server';

import { cookies } from 'next/headers';
import { ObjectId } from 'mongodb';
import { unstable_noStore as noStore } from 'next/cache';
import { revalidatePath } from 'next/cache';
import { connectToDatabase } from '@/lib/mongodb';
import { isAdminAuthenticated } from '@/app/actions';
import { sendPushNotification } from '@/lib/push-notifications';
import type { Order, Notification, User } from '@/lib/definitions';
import type { SupportTicket, SupportMessage } from '@/lib/support-definitions';
import { RefundRequest, RefundStatus, REFUND_WINDOW_DAYS } from '@/lib/refund-definitions';

const REFUND_COLLECTION = 'refund_requests';
const ORDER_COLLECTION = 'orders';
const SUPPORT_COLLECTION = 'support_tickets';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function getCurrentGamingId(): Promise<string | undefined> {
    return (await cookies()).get('gaming_id')?.value;
}

// Escape any dynamic text (product names, etc.) before it goes into the HTML
// notification body so a product name can never break the markup.
function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Build a compact, self-contained animated "refund accepted" card for the
// notification bell. Everything (layout, colours, animation keyframes) is inlined
// so it renders identically in both light and dark themes and needs no app CSS.
// Class names + keyframes are prefixed `rfa-` so they cannot collide with the app.
function buildRefundAcceptedHtml(params: {
    products: { name: string; amount: number }[];
    days: number;
    statusUrl: string;
    supportUrl: string;
    // Whether to render the secondary "Open Support Page" button. Shown in the
    // notification bell, but hidden inside the support chat (it's already there).
    showSupportButton: boolean;
}): string {
    const { products, days, statusUrl, supportUrl, showSupportButton } = params;

    const productRows = products
        .map(
            (p) => `<div class="rfa-row">
                <span class="rfa-dot"></span>
                <span class="rfa-name">${escapeHtml(p.name)}</span>
                <span class="rfa-amt">₹${escapeHtml(String(p.amount))}</span>
            </div>`
        )
        .join('');

    return `<div class="rfa-card">
        <style>
            .rfa-card{position:relative;overflow:hidden;border-radius:14px;padding:16px 14px 14px;
                background:linear-gradient(135deg,#065f46 0%,#0f766e 55%,#0e7490 100%);
                color:#ecfdf5;font-family:ui-sans-serif,system-ui,sans-serif;
                box-shadow:0 8px 24px -8px rgba(13,148,136,.55);}
            .rfa-card *{box-sizing:border-box;}
            .rfa-glow{position:absolute;top:-40px;right:-40px;width:140px;height:140px;border-radius:50%;
                background:radial-gradient(circle,rgba(16,185,129,.55),transparent 70%);
                animation:rfa-float 4s ease-in-out infinite;pointer-events:none;}
            .rfa-head{display:flex;align-items:center;gap:10px;position:relative;z-index:1;}
            .rfa-badge{flex:none;width:38px;height:38px;border-radius:50%;
                display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;
                color:#065f46;background:#fff;box-shadow:0 0 0 0 rgba(255,255,255,.6);
                animation:rfa-pop .5s cubic-bezier(.18,.89,.32,1.28) both,rfa-ring 2.2s ease-out .5s infinite;}
            .rfa-title{font-size:15px;font-weight:700;line-height:1.2;}
            .rfa-sub{font-size:11.5px;opacity:.85;margin-top:1px;}
            .rfa-products{margin:12px 0 10px;display:flex;flex-direction:column;gap:6px;position:relative;z-index:1;}
            .rfa-row{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;
                background:rgba(255,255,255,.12);border-radius:8px;padding:7px 9px;
                animation:rfa-rise .5s ease both .15s;}
            .rfa-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#a7f3d0;margin-top:5px;}
            .rfa-name{flex:1;min-width:0;line-height:1.35;overflow-wrap:anywhere;word-break:break-word;}
            .rfa-amt{flex:none;font-weight:700;color:#fff;white-space:nowrap;}
            .rfa-eta{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;
                background:rgba(255,255,255,.14);border-radius:999px;padding:4px 10px;margin-bottom:12px;
                position:relative;z-index:1;}
            .rfa-eta b{font-weight:700;}
            .rfa-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;
                text-decoration:none;font-size:13.5px;font-weight:700;color:#065f46 !important;
                background:#fff;border-radius:10px;padding:10px 14px;position:relative;overflow:hidden;z-index:1;
                box-shadow:0 4px 14px -4px rgba(0,0,0,.35);}
            .rfa-btn::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;
                background:linear-gradient(120deg,transparent,rgba(255,255,255,.7),transparent);
                transform:skewX(-20deg);animation:rfa-shine 2.6s ease-in-out infinite;}
            .rfa-btn-support{margin-top:8px;background:rgba(255,255,255,.14);color:#fff !important;
                border:1px solid rgba(255,255,255,.45);box-shadow:none;}
            @keyframes rfa-pop{0%{transform:scale(0) rotate(-30deg);opacity:0;}100%{transform:scale(1) rotate(0);opacity:1;}}
            @keyframes rfa-ring{0%{box-shadow:0 0 0 0 rgba(255,255,255,.55);}70%,100%{box-shadow:0 0 0 12px rgba(255,255,255,0);}}
            @keyframes rfa-rise{0%{transform:translateY(6px);opacity:0;}100%{transform:translateY(0);opacity:1;}}
            @keyframes rfa-float{0%,100%{transform:translateY(0);}50%{transform:translateY(10px);}}
            @keyframes rfa-shine{0%{left:-60%;}60%,100%{left:130%;}}
        </style>
        <div class="rfa-glow"></div>
        <div class="rfa-head">
            <div class="rfa-badge">✓</div>
            <div>
                <div class="rfa-title">Refund Accepted 🎉</div>
                <div class="rfa-sub">Your refund is now in progress</div>
            </div>
        </div>
        <div class="rfa-products">${productRows}</div>
        <div class="rfa-eta">⏱️ Completed within <b>${days} days</b></div>
        <a class="rfa-btn" href="${statusUrl}" target="_blank" rel="noopener noreferrer">Track Refund →</a>
        ${showSupportButton ? `<a class="rfa-btn rfa-btn-support" href="${supportUrl}" target="_blank" rel="noopener noreferrer">💬 Open Support Page</a>` : ''}
    </div>`;
}

// A trimmed, client-safe shape for an order the admin can pick to refund.
export interface AdminFailedOrder {
    orderId: string;
    productName: string;
    productImageUrl?: string;
    amount: number;
    paymentMethod?: string;
    utr?: string;
    createdAt: string;
    orderStatus: Order['status'];    // The order's own status (Failed / Completed / Processing)
    alreadyRefunding: boolean;       // A refund is already in progress for this order
    refundStatus?: RefundStatus;
    refundAcceptedAt?: string;       // ISO: when the existing refund was (re)accepted
    refundCompleteBy?: string;       // ISO: when that refund is due to complete
}

// Serializes a stored date for the client; undefined when missing or invalid.
function toIso(value: Date | string | undefined): string | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// The order statuses an admin is allowed to accept a refund for.
const REFUNDABLE_ORDER_STATUSES: Order['status'][] = ['Failed', 'Completed', 'Processing'];

// ---------------------------------------------------------------------------
// USER-FACING
// ---------------------------------------------------------------------------

// All refund requests belonging to the currently logged-in user, newest first.
// Drives the /refundstatus page and the floating banner on /refund-request.
export async function getMyRefundRequests(): Promise<RefundRequest[]> {
    noStore();
    const gamingId = await getCurrentGamingId();
    if (!gamingId) return [];

    try {
        const db = await connectToDatabase();
        const requests = await db
            .collection<RefundRequest>(REFUND_COLLECTION)
            .find({ gamingId })
            .sort({ acceptedAt: -1 })
            .toArray();
        return JSON.parse(JSON.stringify(requests));
    } catch (error) {
        console.error('Refund: failed to fetch user refund requests', error);
        return [];
    }
}

// ---------------------------------------------------------------------------
// ADMIN-FACING
// ---------------------------------------------------------------------------

// The refundable orders for a given gaming id (Failed, Completed or Processing),
// with a flag for each one telling the admin whether a refund is already running.
// Used by the "Accept refund request" dialog so the admin can pick which order(s)
// to refund.
export async function getUserFailedOrders(gamingId: string): Promise<AdminFailedOrder[]> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !gamingId) return [];

    try {
        const db = await connectToDatabase();
        const orders = await db
            .collection<Order>(ORDER_COLLECTION)
            .find({ gamingId, status: { $in: REFUNDABLE_ORDER_STATUSES } })
            .sort({ createdAt: -1 })
            .toArray();

        const orderIds = orders.map((o) => o._id.toString());
        const existingRefunds = await db
            .collection<RefundRequest>(REFUND_COLLECTION)
            .find({ gamingId, orderId: { $in: orderIds } })
            .toArray();
        const refundByOrder = new Map(existingRefunds.map((r) => [r.orderId, r]));

        return orders.map((o) => {
            const existing = refundByOrder.get(o._id.toString());
            return {
                orderId: o._id.toString(),
                productName: o.productName,
                productImageUrl: o.productImageUrl,
                amount: o.finalPrice ?? o.productPrice ?? 0,
                paymentMethod: o.paymentMethod,
                utr: o.utr,
                createdAt: (o.createdAt as unknown as Date).toString(),
                orderStatus: o.status,
                alreadyRefunding: existing?.status === 'in_progress',
                refundStatus: existing?.status,
                refundAcceptedAt: toIso(existing?.acceptedAt),
                refundCompleteBy: toIso(existing?.completeBy),
            };
        });
    } catch (error) {
        console.error('Refund: failed to fetch user failed orders', error);
        return [];
    }
}

// ---------------------------------------------------------------------------
// ADMIN — REFUND MANAGEMENT LIST
// ---------------------------------------------------------------------------

// Client-safe shape of an accepted refund row shown in the admin refund list.
export interface AdminRefundListItem {
    _id: string;
    gamingId: string;
    visualGamingId?: string;
    orderId: string;
    productName: string;
    productImageUrl?: string;
    amount: number;
    paymentMethod?: string;
    utr?: string;
    status: 'in_progress' | 'completed' | 'failed';
    acceptedAt: string;
    completeBy: string;
}

const REFUNDS_PER_PAGE = 10;

// India Standard Time is a fixed UTC+05:30 offset (no daylight saving). The
// admin date/time pickers send a wall-clock value with no timezone (e.g.
// "2026-06-14T15:30") entered in IST. We pin the IST offset here so it is
// converted to the correct UTC instant before querying (acceptedAt is UTC).
function istLocalToUtcDate(local?: string): Date | null {
    if (!local) return null;
    const withSeconds = local.length === 16 ? `${local}:00` : local;
    const date = new Date(`${withSeconds}+05:30`);
    return isNaN(date.getTime()) ? null : date;
}

// Builds the acceptedAt range filter shared by the listing and range-deletion
// so that "what you see" and "what gets deleted" always match.
function buildAcceptedAtFilter(from?: string, to?: string): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    const range: Record<string, Date> = {};
    const start = istLocalToUtcDate(from);
    const end = istLocalToUtcDate(to);
    if (start) range.$gte = start;
    if (end) range.$lte = end;
    if (Object.keys(range).length > 0) filter.acceptedAt = range;
    return filter;
}

// Paginated list of accepted refund requests for the admin section.
//  - sort: 'desc' = newest first (default), 'asc' = oldest first.
//  - from / to: optional ISO datetime range filter on acceptedAt.
//  - page is 1-based; 10 per page with a hasMore flag for the "Load more" button.
export async function getAcceptedRefunds(params: {
    page?: number;
    sort?: 'asc' | 'desc';
    from?: string;
    to?: string;
}): Promise<{ refunds: AdminRefundListItem[]; hasMore: boolean }> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { refunds: [], hasMore: false };

    const page = Math.max(1, params.page ?? 1);
    const sortDir = params.sort === 'asc' ? 1 : -1;

    const filter = buildAcceptedAtFilter(params.from, params.to);

    try {
        const db = await connectToDatabase();
        // Fetch one extra row to know whether there is a next page.
        const rows = await db
            .collection<RefundRequest>(REFUND_COLLECTION)
            .find(filter)
            .sort({ acceptedAt: sortDir })
            .skip((page - 1) * REFUNDS_PER_PAGE)
            .limit(REFUNDS_PER_PAGE + 1)
            .toArray();

        const hasMore = rows.length > REFUNDS_PER_PAGE;
        const refunds = rows.slice(0, REFUNDS_PER_PAGE).map((r) => ({
            _id: r._id.toString(),
            gamingId: r.gamingId,
            visualGamingId: r.visualGamingId,
            orderId: r.orderId,
            productName: r.productName,
            productImageUrl: r.productImageUrl,
            amount: r.amount,
            paymentMethod: r.paymentMethod,
            utr: r.utr,
            status: r.status,
            acceptedAt: (r.acceptedAt as unknown as Date).toString(),
            completeBy: (r.completeBy as unknown as Date).toString(),
        }));

        return { refunds, hasMore };
    } catch (error) {
        console.error('Refund: failed to fetch accepted refunds', error);
        return { refunds: [], hasMore: false };
    }
}

// Admin marks a refund as completed or failed (or back to in_progress). This only
// changes the refund record — the underlying order is untouched, so the user's
// order page shows the refund outcome until the refund is deleted.
export async function updateRefundStatus(
    refundId: string,
    status: 'in_progress' | 'completed' | 'failed'
): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized.' };
    if (!ObjectId.isValid(refundId)) return { success: false, message: 'Invalid refund.' };
    if (!['in_progress', 'completed', 'failed'].includes(status)) {
        return { success: false, message: 'Invalid status.' };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<RefundRequest>(REFUND_COLLECTION).updateOne(
            { _id: new ObjectId(refundId) },
            { $set: { status, updatedAt: new Date() } }
        );
        if (result.matchedCount === 0) {
            return { success: false, message: 'Refund not found.' };
        }
        revalidatePath('/admin/refunds');
        revalidatePath('/refundstatus');
        revalidatePath('/order');
        return { success: true, message: `Refund marked as ${status.replace('_', ' ')}.` };
    } catch (error) {
        console.error('Refund: failed to update refund status', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}

// Admin deletes a refund record entirely. Once gone, the user's order page falls
// back to showing the order's own status (Failed / Completed / Processing) again,
// because that override is keyed purely on the existence of a refund request.
export async function deleteRefundRequest(
    refundId: string
): Promise<{ success: boolean; message: string }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized.' };
    if (!ObjectId.isValid(refundId)) return { success: false, message: 'Invalid refund.' };

    try {
        const db = await connectToDatabase();
        const result = await db
            .collection<RefundRequest>(REFUND_COLLECTION)
            .deleteOne({ _id: new ObjectId(refundId) });
        if (result.deletedCount === 0) {
            return { success: false, message: 'Refund not found.' };
        }
        revalidatePath('/admin/refunds');
        revalidatePath('/refundstatus');
        revalidatePath('/order');
        return { success: true, message: 'Refund deleted.' };
    } catch (error) {
        console.error('Refund: failed to delete refund', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}

// Admin deletes several refund records at once by their _id. Used by the
// "Delete Selected" action in the admin refund list.
export async function deleteRefundRequests(
    refundIds: string[]
): Promise<{ success: boolean; message: string; deletedCount: number }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized.', deletedCount: 0 };

    const objectIds = (refundIds || [])
        .filter((id) => ObjectId.isValid(id))
        .map((id) => new ObjectId(id));
    if (objectIds.length === 0) {
        return { success: false, message: 'No valid refunds selected.', deletedCount: 0 };
    }

    try {
        const db = await connectToDatabase();
        const result = await db
            .collection<RefundRequest>(REFUND_COLLECTION)
            .deleteMany({ _id: { $in: objectIds } });
        revalidatePath('/admin/refunds');
        revalidatePath('/refundstatus');
        revalidatePath('/order');
        return { success: true, message: `Deleted ${result.deletedCount} refund(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Refund: failed to delete refunds', error);
        return { success: false, message: 'Something went wrong. Please try again.', deletedCount: 0 };
    }
}

// Admin deletes every accepted refund within the current IST time frame. Clears
// the whole range, not just the loaded page.
export async function deleteAcceptedRefundsInRange(params: {
    from?: string;
    to?: string;
}): Promise<{ success: boolean; message: string; deletedCount: number }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized.', deletedCount: 0 };

    const filter = buildAcceptedAtFilter(params.from, params.to);
    // Guard against an accidental "delete everything": this action is only for
    // deleting within a chosen time frame.
    if (!filter.acceptedAt) {
        return { success: false, message: 'Please choose a time frame first.', deletedCount: 0 };
    }

    try {
        const db = await connectToDatabase();
        const result = await db
            .collection<RefundRequest>(REFUND_COLLECTION)
            .deleteMany(filter);
        revalidatePath('/admin/refunds');
        revalidatePath('/refundstatus');
        revalidatePath('/order');
        return { success: true, message: `Deleted ${result.deletedCount} refund(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Refund: failed to delete refunds in range', error);
        return { success: false, message: 'Something went wrong. Please try again.', deletedCount: 0 };
    }
}

// Admin accepts a refund for one or more of a user's failed orders (chosen from
// a support ticket). For each selected order we UPSERT a refund request keyed by
// (gamingId + orderId): if one already exists for that failed product the old
// one is replaced and the 14-day countdown is RESET to now — so a user who keeps
// re-asking only pushes their own refund further out. A confirmation message is
// posted into the ticket chat and a website + push notification is sent, both
// pointing at the /refundstatus page.
export async function acceptRefundRequest(
    ticketId: string,
    orderIds: string[]
): Promise<{ success: boolean; message: string; count?: number }> {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: 'Unauthorized.' };
    }
    if (!ObjectId.isValid(ticketId)) {
        return { success: false, message: 'Invalid report.' };
    }

    const validOrderIds = (orderIds || []).filter((id) => ObjectId.isValid(id));
    if (validOrderIds.length === 0) {
        return { success: false, message: 'Please select at least one order.' };
    }

    try {
        const db = await connectToDatabase();

        const ticket = await db
            .collection<SupportTicket>(SUPPORT_COLLECTION)
            .findOne({ _id: new ObjectId(ticketId) });
        if (!ticket) {
            return { success: false, message: 'Report not found.' };
        }
        const gamingId = ticket.gamingId;

        // Only allow refunding this user's OWN refundable orders
        // (Failed, Completed or Processing).
        const orders = await db
            .collection<Order>(ORDER_COLLECTION)
            .find({
                _id: { $in: validOrderIds.map((id) => new ObjectId(id)) },
                gamingId,
                status: { $in: REFUNDABLE_ORDER_STATUSES },
            })
            .toArray();

        if (orders.length === 0) {
            return { success: false, message: 'No matching orders found for this user.' };
        }

        const now = new Date();
        const completeBy = new Date(now.getTime() + REFUND_WINDOW_DAYS * ONE_DAY_MS);

        // Upsert each refund (resetting the timer on re-accept). Doing one
        // updateOne per order keeps the "delete the old + start new + reset time"
        // behaviour the user asked for in a single atomic step per product.
        for (const order of orders) {
            await db.collection<RefundRequest>(REFUND_COLLECTION).updateOne(
                { gamingId, orderId: order._id.toString() },
                {
                    $set: {
                        gamingId,
                        visualGamingId: ticket.visualGamingId,
                        orderId: order._id.toString(),
                        productName: order.productName,
                        productImageUrl: order.productImageUrl,
                        amount: order.finalPrice ?? order.productPrice ?? 0,
                        paymentMethod: order.paymentMethod,
                        utr: order.utr,
                        status: 'in_progress',
                        ticketId,
                        acceptedAt: now,   // reset countdown
                        completeBy,        // reset countdown
                        updatedAt: now,
                    },
                    $setOnInsert: { createdAt: now },
                },
                { upsert: true }
            );
        }

        const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002';
        const statusUrl = `${baseUrl}/refundstatus`;
        const supportUrl = `${baseUrl}/support`;

        const productLines = orders
            .map((o) => `• ${o.productName} (₹${o.finalPrice ?? o.productPrice ?? 0})`)
            .join('\n');

        // 1. Post a confirmation message into the ticket chat (clickable link).
        const chatText = `✅ Your refund request has been accepted.

Refund is now in progress for:
${productLines}

It will be completed within ${REFUND_WINDOW_DAYS} days. You can track the live progress here: ${statusUrl}`;

        const refundCardProducts = orders.map((o) => ({
            name: o.productName,
            amount: o.finalPrice ?? o.productPrice ?? 0,
        }));

        // Chat card omits the "Open Support Page" button — the user is already on
        // the support page when reading it.
        const chatCardHtml = buildRefundAcceptedHtml({
            products: refundCardProducts,
            days: REFUND_WINDOW_DAYS,
            statusUrl,
            supportUrl,
            showSupportButton: false,
        });

        const adminMessage: SupportMessage = {
            _id: new ObjectId(),
            sender: 'admin',
            text: chatText,   // plain-text fallback (admin inbox preview / older clients)
            html: chatCardHtml,
            createdAt: now,
        };
        await db.collection<SupportTicket>(SUPPORT_COLLECTION).updateOne(
            { _id: new ObjectId(ticketId) },
            {
                $push: { messages: adminMessage },
                $set: { lastSenderRole: 'admin', status: 'open', updatedAt: now },
                $inc: { userUnread: 1 },
            }
        );

        // 2. Website notification — a rich animated HTML card in the bell, with a
        // plain-text `message` kept as the fallback (used by push and any client
        // that doesn't render HTML).
        const notifMessage = `🎉 Good news! Your refund request was accepted and is now in progress. It will be completed within ${REFUND_WINDOW_DAYS} days. Track it here: ${statusUrl}
Need help? Reach us on the support page: ${supportUrl}`;
        // Bell card includes the "Open Support Page" button.
        const bellCardHtml = buildRefundAcceptedHtml({
            products: refundCardProducts,
            days: REFUND_WINDOW_DAYS,
            statusUrl,
            supportUrl,
            showSupportButton: true,
        });
        const newNotification: Omit<Notification, '_id'> = {
            gamingId,
            message: notifMessage,
            html: bellCardHtml,
            isRead: false,
            createdAt: now,
            type: 'refund_status',
        };
        await db.collection<Notification>('notifications').insertOne(newNotification as Notification);

        // 3. FCM push (best-effort) — clicking opens /refundstatus.
        try {
            const user = await db.collection<User>('users').findOne({ gamingId });
            if (user?.fcmToken) {
                await sendPushNotification({
                    token: user.fcmToken,
                    title: 'Refund Accepted',
                    body: `Your refund request was accepted and will complete within ${REFUND_WINDOW_DAYS} days.`,
                    link: statusUrl,
                });
            }
        } catch (pushError) {
            console.error('Refund: push notification failed', pushError);
        }

        revalidatePath('/admin/support');
        revalidatePath('/refundstatus');
        return {
            success: true,
            message: `Refund initiated for ${orders.length} order${orders.length > 1 ? 's' : ''}.`,
            count: orders.length,
        };
    } catch (error) {
        console.error('Refund: failed to accept refund request', error);
        return { success: false, message: 'Something went wrong. Please try again.' };
    }
}
