'use server';

// --- Support Inbox: user order summary resolver ---
// Given the UID a support report came from, count that user's orders (store
// coin orders included) and fetch the newest few so the admin gets a first
// impression of the customer right in the conversation header. This is a
// brand-new, self-contained, admin-only server action that only READS the
// existing `orders` collection, so none of the existing support / order
// features are affected.
//
// Orders are looked up by the ticket's current canonical gamingId, exactly like
// the user's own "My Orders" page does. When an ID is promoted, the promoter
// migrates the user's orders to the new gamingId, so this stays correct after
// a promotion too.

import { isAdminAuthenticated } from '@/app/actions';
import { connectToDatabase } from '@/lib/mongodb';
import { unstable_noStore as noStore } from 'next/cache';
import type { Order } from '@/lib/definitions';
import {
    SUPPORT_RECENT_ORDER_LIMIT,
    type SupportRecentOrder,
    type SupportUserOrderSummary,
} from '@/lib/support-orders-types';

const ORDERS_COLLECTION = 'orders';

interface StatusBucket {
    _id: string | null;
    count: number;
    coin: number;
}

function emptySummary(sourceUid: string, unavailable: boolean): SupportUserOrderSummary {
    return {
        sourceUid,
        totalOrders: 0,
        completed: 0,
        processing: 0,
        pending: 0,
        failed: 0,
        coinOrders: 0,
        latestOrders: [],
        ...(unavailable ? { unavailable: true } : {}),
    };
}

function toRecentOrder(order: Order): SupportRecentOrder {
    const createdAt = order.createdAt ? new Date(order.createdAt) : null;
    return {
        id: order._id.toString(),
        productName: order.productName || 'Unnamed product',
        status: String(order.status ?? ''),
        createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : '',
        finalPrice: Number.isFinite(order.finalPrice) ? order.finalPrice : 0,
        isCoinProduct: order.isCoinProduct === true,
        paymentMethod: String(order.paymentMethod ?? ''),
    };
}

/**
 * Count the orders on a UID (all statuses, coin orders included) and return the
 * newest `SUPPORT_RECENT_ORDER_LIMIT` of them.
 *
 * @param sourceUid The ticket's current canonical gamingId.
 */
export async function getSupportUserOrderSummary(sourceUid: string): Promise<SupportUserOrderSummary> {
    noStore();

    const uid = (sourceUid || '').trim();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin || !uid) {
        return emptySummary(uid, true);
    }

    try {
        const db = await connectToDatabase();
        const orders = db.collection<Order>(ORDERS_COLLECTION);

        const [buckets, latest] = await Promise.all([
            // One pass over the user's orders: count per status, and how many of
            // those are store-coin orders.
            orders
                .aggregate<StatusBucket>([
                    { $match: { gamingId: uid } },
                    {
                        $group: {
                            _id: '$status',
                            count: { $sum: 1 },
                            coin: { $sum: { $cond: [{ $eq: ['$isCoinProduct', true] }, 1, 0] } },
                        },
                    },
                ])
                .toArray(),
            // Newest orders first; `_id` as a tie-breaker keeps the order stable
            // when two orders share the same timestamp.
            orders
                .find(
                    { gamingId: uid },
                    {
                        projection: {
                            productName: 1,
                            status: 1,
                            createdAt: 1,
                            finalPrice: 1,
                            isCoinProduct: 1,
                            paymentMethod: 1,
                        },
                    },
                )
                .sort({ createdAt: -1, _id: -1 })
                .limit(SUPPORT_RECENT_ORDER_LIMIT)
                .toArray(),
        ]);

        const summary = emptySummary(uid, false);
        for (const bucket of buckets) {
            summary.totalOrders += bucket.count;
            summary.coinOrders += bucket.coin;
            if (bucket._id === 'Completed') summary.completed += bucket.count;
            else if (bucket._id === 'Processing') summary.processing += bucket.count;
            else if (bucket._id === 'Pending') summary.pending += bucket.count;
            else if (bucket._id === 'Failed') summary.failed += bucket.count;
            // Any other (legacy) status still counts towards `totalOrders`.
        }
        summary.latestOrders = latest.map(toRecentOrder);
        return summary;
    } catch (error) {
        console.error('Support: failed to load user order summary', error);
        return emptySummary(uid, true);
    }
}
