
'use server';

import { isAdminAuthenticated } from '@/app/actions';
import { findPayCodeInText, partialPayCode } from '@/lib/pay-code';
import { PaymentLock, User, Product, Order, Notification, LegacyUser } from '@/lib/definitions';
import { connectToDatabase } from '@/lib/mongodb';
import { unstable_noStore as noStore } from 'next/cache';
import { ObjectId } from 'mongodb';
import { revalidatePath } from 'next/cache';
import { sendPushNotification } from '@/lib/push-notifications';
import { buildPurchaseSuccessHtml } from '@/lib/purchase-success-notifier';

const PAGE_SIZE = 10;

// India Standard Time is a fixed UTC+05:30 offset (no daylight saving). The
// admin date/time pickers send a wall-clock value with no timezone (e.g.
// "2026-06-14T15:30") entered in IST. We pin the IST offset here so it is
// converted to the correct UTC instant before querying (createdAt is UTC).
function istLocalToUtcDate(local: string): Date | null {
    if (!local) return null;
    const withSeconds = local.length === 16 ? `${local}:00` : local;
    const date = new Date(`${withSeconds}+05:30`);
    return isNaN(date.getTime()) ? null : date;
}

// Builds the query shared by the listing, count and range-deletion so that
// "what you see" and "what gets deleted" always match. The time frame filters
// on `createdAt` (when the payment session was opened).
function buildPaymentSessionsQuery(search: string, startDate?: string, endDate?: string) {
    const query: any = {};
    if (search) {
        query.$or = [
            { gamingId: { $regex: search, $options: 'i' } },
            { productName: { $regex: search, $options: 'i' } }
        ];
        // Pay code: the bare code, lower case, or the whole note pasted from the UPI
        // app all find the session; three or more characters match as a prefix.
        const fullCode = findPayCodeInText(search);
        const partialCode = fullCode ? null : partialPayCode(search);
        if (fullCode) query.$or.push({ payCode: fullCode });
        else if (partialCode) query.$or.push({ payCode: { $regex: `^${partialCode}` } });
    }

    const start = istLocalToUtcDate(startDate || '');
    const end = istLocalToUtcDate(endDate || '');
    if (start || end) {
        query.createdAt = {};
        if (start) query.createdAt.$gte = start;
        if (end) query.createdAt.$lte = end;
    }

    return query;
}

async function expireOldLocks() {
    try {
        const db = await connectToDatabase();
        const now = new Date();
        const result = await db.collection<PaymentLock>('payment_locks').updateMany(
            { status: 'active', expiresAt: { $lt: now } },
            { $set: { status: 'expired' } }
        );
        if (result.modifiedCount > 0) {
            console.log(`Expired ${result.modifiedCount} old payment locks during admin check.`);
            revalidatePath('/admin/payment-sessions');
        }
    } catch (error) {
        console.error("Error expiring old payment locks from admin action:", error);
    }
}

export async function getPaymentSessions(page: number, search: string, startDate?: string, endDate?: string) {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { sessions: [], hasMore: false, total: 0 };
    }

    // Run cleanup before fetching
    await expireOldLocks();

    try {
        const db = await connectToDatabase();
        const skip = (page - 1) * PAGE_SIZE;

        const query = buildPaymentSessionsQuery(search, startDate, endDate);

        const sessionsFromDb = await db.collection<PaymentLock>('payment_locks')
            .find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(PAGE_SIZE)
            .toArray();

        const total = await db.collection('payment_locks').countDocuments(query);
        const hasMore = skip + sessionsFromDb.length < total;

        const sessions = JSON.parse(JSON.stringify(sessionsFromDb));

        return { sessions, hasMore, total };

    } catch (error) {
        console.error("Error fetching payment sessions:", error);
        return { sessions: [], hasMore: false, total: 0 };
    }
}


export async function forceExpireLock(lockId: string): Promise<{ success: boolean; message: string }> {
  const isAdmin = await isAdminAuthenticated();
  if (!isAdmin) {
    return { success: false, message: 'Unauthorized' };
  }

  try {
    const db = await connectToDatabase();
    const result = await db.collection<PaymentLock>('payment_locks').updateOne(
      { _id: new ObjectId(lockId), status: 'active' },
      { $set: { status: 'expired' } }
    );
    if (result.modifiedCount === 0) {
      return { success: false, message: 'Session not found or already inactive.' };
    }
    revalidatePath('/admin/payment-sessions');
    return { success: true, message: 'Session has been manually expired.' };
  } catch (error) {
    console.error('Error force expiring lock:', error);
    return { success: false, message: 'An internal error occurred.' };
  }
}

// Permanently deletes one or more payment session records by their _id.
// Used for the single-row delete and the "Delete Selected" action.
export async function deletePaymentSessions(ids: string[]) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const objectIds = ids
        .filter(id => ObjectId.isValid(id))
        .map(id => new ObjectId(id));

    if (objectIds.length === 0) {
        return { success: false, message: 'No valid sessions selected.', deletedCount: 0 };
    }

    try {
        const db = await connectToDatabase();
        const result = await db.collection<PaymentLock>('payment_locks').deleteMany({ _id: { $in: objectIds } });
        revalidatePath('/admin/payment-sessions');
        return { success: true, message: `Deleted ${result.deletedCount} session(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Error deleting payment sessions:', error);
        return { success: false, message: 'Failed to delete sessions.', deletedCount: 0 };
    }
}

// Permanently deletes every payment session matching the current filter
// (search + IST time frame). Clears the whole time frame, not just the page.
export async function deletePaymentSessionsInRange(search: string, startDate?: string, endDate?: string) {
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return { success: false, message: 'Unauthorized', deletedCount: 0 };

    const query = buildPaymentSessionsQuery(search, startDate, endDate);

    try {
        const db = await connectToDatabase();
        const result = await db.collection<PaymentLock>('payment_locks').deleteMany(query);
        revalidatePath('/admin/payment-sessions');
        return { success: true, message: `Deleted ${result.deletedCount} session(s).`, deletedCount: result.deletedCount };
    } catch (error) {
        console.error('Error deleting payment sessions in range:', error);
        return { success: false, message: 'Failed to delete sessions.', deletedCount: 0 };
    }
}

export async function approvePaymentManually(lockId: string): Promise<{ success: boolean; message: string }> {
    noStore();
    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) {
        return { success: false, message: "Unauthorized" };
    }

    const db = await connectToDatabase();
    const lock = await db.collection<PaymentLock>('payment_locks').findOne({ _id: new ObjectId(lockId) });

    if (!lock) {
        return { success: false, message: "Payment session not found." };
    }
    if (lock.status === 'completed') {
        return { success: false, message: "This payment has already been completed." };
    }

    const session = db.client.startSession();

    try {
        let createdOrder: Order | null = null;
        await session.withTransaction(async () => {
            const user = await db.collection<User>('users').findOne({ gamingId: lock.gamingId }, { session });
            const product = await db.collection<Product>('products').findOne({ _id: new ObjectId(lock.productId) });

            if (!user || !product) throw new Error('User or Product not found for the payment lock.');

            const coinsUsed = product.isCoinProduct ? 0 : Math.min(user.coins, product.coinsApplicable || 0);
            const orderStatus: Order['status'] = product.isCoinProduct ? 'Completed' : 'Processing';

            const newOrder: Omit<Order, '_id'> = {
                userId: user._id.toString(),
                gamingId: user.gamingId,
                productId: lock.productId,
                productName: lock.productName,
                productPrice: product.price,
                productImageUrl: product.imageUrl,
                paymentMethod: 'UPI-Auto',
                status: orderStatus,
                coinsUsed,
                finalPrice: lock.amount,
                referralCode: user.referredByCode,
                isCoinProduct: !!product.isCoinProduct,
                createdAt: new Date(),
                coinsAtTimeOfPurchase: user.coins,
                ...(lock.payCode ? { payCode: lock.payCode } : {}),
            };

            const orderResult = await db.collection<Order>('orders').insertOne(newOrder as Order, { session });
            createdOrder = { ...newOrder, _id: orderResult.insertedId };
            
            if (product.isCoinProduct) {
                await db.collection<User>('users').updateOne({ _id: user._id }, { $inc: { coins: product.quantity } }, { session });
                if (newOrder.referralCode) {
                    const rewardAmount = newOrder.finalPrice * 0.50;
                    await db.collection<LegacyUser>('legacy_users').updateOne({ referralCode: newOrder.referralCode }, { $inc: { walletBalance: rewardAmount } }, { session });
                }
            } else if (coinsUsed > 0) {
                await db.collection<User>('users').updateOne({ _id: user._id }, { $inc: { coins: -coinsUsed } }, { session });
            }

            await db.collection<PaymentLock>('payment_locks').updateOne({ _id: lock._id }, { $set: { status: 'completed' } }, { session });

            const notificationMessage = `Your payment of ₹${lock.amount} for "${lock.productName}" has been successfully received. Order is ${orderStatus}.`;
            const orderUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002'}/order`;
            const newNotification: Omit<Notification, '_id'> = {
                gamingId: user.gamingId,
                message: notificationMessage,
                // Rich animated "purchase successful" card for the bell; `message`
                // stays as the plain-text fallback (push / non-HTML clients).
                // The product image is embedded inside the card (near the bottom),
                // so we intentionally don't set the doc's separate `imageUrl` here
                // — that would render the image twice in the bell.
                html: buildPurchaseSuccessHtml({
                    productName: lock.productName,
                    amount: lock.amount,
                    status: orderStatus,
                    orderUrl,
                    imageUrl: product.imageUrl,
                }),
                isRead: false, createdAt: new Date(),
            };
            await db.collection<Notification>('notifications').insertOne(newNotification as Notification, { session });
        });
        
        await session.endSession();

        const userForPush = await db.collection<User>('users').findOne({ gamingId: lock.gamingId });
        if (userForPush?.fcmToken && createdOrder) {
            await sendPushNotification({
                token: userForPush.fcmToken,
                title: 'Garena Store: Payment Verified',
                body: `Your payment for "${createdOrder.productName}" has been successfully verified.`,
                imageUrl: createdOrder.productImageUrl,
            });
        }
        
        revalidatePath('/admin/payment-sessions');
        return { success: true, message: 'Payment approved and order created successfully.' };

    } catch (error: any) {
        await session.endSession();
        console.error('Manual Payment Approval Error:', error);
        return { success: false, message: error.message || "Failed to approve payment." };
    }
}
