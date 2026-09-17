
import { NextRequest, NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { PaymentLock, SmsWebhookLog, User, Order, Notification, Product, LegacyUser } from '@/lib/definitions';
import { ObjectId } from 'mongodb';
import { sendPushNotification } from '@/lib/push-notifications';
import { buildPurchaseSuccessHtml } from '@/lib/purchase-success-notifier';
import { timingSafeEqual } from 'crypto';
import { onceEvery, rateLimit } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/client-ip';
import { sendTelegramAlert } from '@/lib/telegram';
import { alertUnmatchedPayment } from '@/lib/admin-alerts';

// --- SMS Parsing Logic ---
function parseSms(body: string): { amount: number | null, upiRef: string | null } {
    // Regex for "Received ₹1 from Sayan Mondal"
    const newAmountMatch = body.match(/Received ₹\s*([\d,]+(\.\d{1,2})?)/);

    // Regex for "Bharat Interface for Money Received INR 1.00..."
    const oldAmountMatch = body.match(/Received INR\s*(\d+(\.\d{2})?)/);
    
    // Regex for "Received Rs.30.00 in your Kotak Bank..."
    const kotakAmountMatch = body.match(/Received Rs\.\s*([\d,]+(\.\d{1,2})?)/);

    // Regex for "credited with Rs.1.00"
    const airtelAmountMatch = body.match(/credited with Rs\.\s*([\d,]+(\.\d{1,2})?)/i);
    
    // Regex for "100.00 was credited to..."
    const growwAmountMatch = body.match(/([\d,]+(\.\d{1,2})?)\s*was credited to/i);

    // Upi Ref for compatibility, including formats like "UPI Ref:"
    const upiRefMatch = body.match(/Ref:(\d+)/i); // case-insensitive

    let amount = null;
    if (newAmountMatch) {
      amount = parseFloat(newAmountMatch[1].replace(/,/g, ''));
    } else if (oldAmountMatch) {
      amount = parseFloat(oldAmountMatch[1].replace(/,/g, ''));
    } else if (kotakAmountMatch) {
      amount = parseFloat(kotakAmountMatch[1].replace(/,/g, ''));
    } else if (airtelAmountMatch) {
      amount = parseFloat(airtelAmountMatch[1].replace(/,/g, ''));
    } else if (growwAmountMatch) {
      amount = parseFloat(growwAmountMatch[1].replace(/,/g, ''));
    }

    return {
        amount,
        upiRef: upiRefMatch ? upiRefMatch[1] : null
    };
}


async function createOrderFromLock(lock: PaymentLock, smsLogId: ObjectId, upiRef: string | null) {
    const db = await connectToDatabase();
    const session = db.client.startSession();
    
    try {
        let createdOrder: Order | null = null;
        await session.withTransaction(async () => {
            const user = await db.collection<User>('users').findOne({ gamingId: lock.gamingId }, { session });
            const product = await db.collection<Product>('products').findOne({ _id: new ObjectId(lock.productId) });

            if (!user || !product) {
                throw new Error('User or Product not found for the payment lock.');
            }

            const coinsUsed = product.isCoinProduct ? 0 : Math.min(user.coins, product.coinsApplicable || 0);

            // Determine order status based on product type
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
                ...(upiRef ? { utr: upiRef } : {}),
                ...(lock.payCode ? { payCode: lock.payCode } : {}),
            };

            const orderResult = await db.collection<Order>('orders').insertOne(newOrder as Order, { session });
            createdOrder = { ...newOrder, _id: orderResult.insertedId };
            
            if (product.isCoinProduct) {
                // For coin products, order is completed immediately
                // Add coins to user
                await db.collection<User>('users').updateOne({ _id: user._id }, { $inc: { coins: product.quantity } }, { session });
                
                // If it's a coin product and it's completed, credit the referrer immediately.
                if (newOrder.referralCode) {
                    const rewardAmount = newOrder.finalPrice * 0.50;
                    await db.collection<LegacyUser>('legacy_users').updateOne(
                        { referralCode: newOrder.referralCode },
                        { $inc: { walletBalance: rewardAmount } },
                        { session }
                    );
                }

            } else if (coinsUsed > 0) {
                // For normal products, just deduct coins used.
                // The referrer will be credited when admin marks order as 'Completed'.
                await db.collection<User>('users').updateOne({ _id: user._id }, { $inc: { coins: -coinsUsed } }, { session });
            }


            await db.collection<PaymentLock>('payment_locks').updateOne(
                { _id: lock._id },
                { $set: { status: 'completed' } },
                { session }
            );

            await db.collection<SmsWebhookLog>('sms_webhook_logs').updateOne(
                { _id: smsLogId },
                { $set: { status: 'verified', matchedPaymentLockId: lock._id, matchedGamingId: user.gamingId } },
                { session }
            );
            
            const orderUrl = 'https://www.garenafreefire.store/order';
            const notificationMessage = `Your payment of ₹${lock.amount} for "${lock.productName}" has been successfully received. You can see the details and track your order here: ${orderUrl}`;
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
                isRead: false,
                createdAt: new Date(),
            };
            await db.collection<Notification>('notifications').insertOne(newNotification as Notification, { session });
        });
        
        // TypeScript narrows `createdOrder` to `never` after the closure above; re-type it once.
        const finishedOrder = createdOrder as Order | null;

        // Send push notification outside the transaction
        const userForPush = await db.collection<User>('users').findOne({ gamingId: lock.gamingId });
        if (userForPush?.fcmToken && finishedOrder) {
            await sendPushNotification({
                token: userForPush.fcmToken,
                title: 'Garena Store: Payment Received!',
                body: `Your payment of ₹${lock.amount} for "${finishedOrder.productName}" is now processing.`,
                imageUrl: finishedOrder.productImageUrl,
            });
        }
    } catch(error) {
        console.error(`Failed to create order for lock ${lock._id}:`, error);
        // If transaction fails, the webhook log remains 'unprocessed' for potential retry.
    } finally {
        await session.endSession();
    }
}


// ---------------------------------------------------------------------------
// Webhook authentication and abuse protection
//
// The SMS forwarder (MacroDroid) must send, as JSON:
//   { "key": "<SMS_WEBHOOK_SECRET>", "message": "<sms text>", "sender": "<sender>" }
// The secret may instead be sent as the header `X-Webhook-Key` or
// `Authorization: Bearer <secret>`. Requests are rejected BEFORE anything is
// written to the database when the secret is missing/wrong, the body is too
// large, or an IP sends too many requests. The secret itself is never logged.
// ---------------------------------------------------------------------------
const MAX_BODY_BYTES = 4096;
const PER_IP_LIMIT = { limit: 30, windowMs: 60 * 1000 };
const MIN_SECRET_LENGTH = 16;

function webhookSecret(): string {
  return (process.env.SMS_WEBHOOK_SECRET ?? '').trim();
}

function secretMatches(provided: string): boolean {
  const expected = webhookSecret();
  if (expected.length < MIN_SECRET_LENGTH || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function clientIp(req: NextRequest): string {
  return getClientIp(req.headers);
}

/** One Telegram alert per 10 minutes when rejected requests pile up. */
async function noteRejection(reason: string, ip: string) {
  const burst = rateLimit('sms:rejections', { limit: 20, windowMs: 10 * 60 * 1000 });
  if (!burst.allowed && onceEvery('sms:rejection-alert', 10 * 60 * 1000)) {
    await sendTelegramAlert(`⚠️ Payment webhook: more than 20 rejected requests in 10 minutes (latest: ${reason}, IP ${ip}). Someone may be probing /api/sms.`);
  }
}

const reject = (status: number, message: string, headers?: Record<string, string>) =>
  NextResponse.json({ success: false, message }, { status, headers });

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  // Fail closed: without a configured secret the webhook does nothing.
  if (webhookSecret().length < MIN_SECRET_LENGTH) {
    return reject(503, 'Webhook disabled: SMS_WEBHOOK_SECRET is not configured on the server.');
  }

  const verdict = rateLimit(`sms:${ip}`, PER_IP_LIMIT);
  if (!verdict.allowed) {
    await noteRejection('rate limit', ip);
    return reject(429, 'Too many requests.', { 'Retry-After': String(verdict.retryAfterSec) });
  }

  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return reject(413, 'Request body too large.');
  let raw = '';
  try {
    raw = await req.text();
  } catch {
    return reject(400, 'Could not read request body.');
  }
  if (raw.length > MAX_BODY_BYTES) return reject(413, 'Request body too large.');

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(400, 'Body must be a JSON object.');
    data = parsed as Record<string, unknown>;
  } catch {
    return reject(400, 'Invalid JSON.');
  }

  const headerKey = req.headers.get('x-webhook-key') ?? (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const provided = String(headerKey || (typeof data.key === 'string' ? data.key : '') || '');
  if (!secretMatches(provided)) {
    await noteRejection('bad key', ip);
    return reject(401, 'Unauthorized.');
  }

  const smsBody = typeof data.message === 'string' ? data.message.trim() : '';
  if (!smsBody) return reject(400, 'SMS text not found in the "message" field.');
  const sender = typeof data.sender === 'string' ? data.sender.slice(0, 100) : undefined;

  try {
    const db = await connectToDatabase();

    // Log the incoming SMS (only after authentication)
    const smsLog: Omit<SmsWebhookLog, '_id'> = {
        body: smsBody,
        sender,
        receivedAt: new Date(),
        status: 'unprocessed',
    };
    const logResult = await db.collection('sms_webhook_logs').insertOne(smsLog as SmsWebhookLog);
    const smsLogId = logResult.insertedId;

    const { amount, upiRef } = parseSms(smsBody);
    
    if (amount === null) {
        await db.collection('sms_webhook_logs').updateOne({ _id: smsLogId }, { $set: { status: 'ignored_not_payment' } });
        return NextResponse.json({ success: true, message: 'Ignored: Not a payment SMS.' });
    }

    // Update log with parsed amount
    await db.collection('sms_webhook_logs').updateOne({ _id: smsLogId }, { $set: { parsedAmount: amount } });

    // --- Primary Match: Find an active lock for the exact amount ---
    const activeLock = await db.collection<PaymentLock>('payment_locks').findOne({ amount: amount, status: 'active' });
    if (activeLock) {
        await createOrderFromLock(activeLock, smsLogId, upiRef);
        return NextResponse.json({ success: true, message: 'Payment verified and order created.' });
    }
    
    // --- Grace Period Match: Find a recently expired lock for the exact amount ---
    const graceWindowStart = new Date(Date.now() - 60 * 1000); // 1 minute after the session closed
    const recentExpiredLocks = await db.collection<PaymentLock>('payment_locks').find({
        amount: amount,
        status: 'expired',
        expiresAt: { $gte: graceWindowStart }
    }).sort({ expiresAt: -1 }).toArray();

    if (recentExpiredLocks.length > 0) {
        // Grant the order to the most recently expired lock
        const lockToProcess = recentExpiredLocks[0];
        await createOrderFromLock(lockToProcess, smsLogId, upiRef);
        return NextResponse.json({ success: true, message: 'Payment verified for recently expired session.' });
    }

    // If no match found: keep the log and tell the admin (best effort), who can
    // investigate in Payment Sessions / SMS Logs and approve manually.
    await db.collection('sms_webhook_logs').updateOne({ _id: smsLogId }, { $set: { status: 'ignored_no_match' } });
    await alertUnmatchedPayment({ amount, upiRef, sender, text: smsBody });
    return NextResponse.json({ success: true, message: 'No matching payment session found.' });

  } catch (error) {
    console.error('SMS Webhook Error:', error);
    return NextResponse.json({ success: false, message: 'An internal error occurred.' }, { status: 500 });
  }
}

// Expire old locks that might have been missed by client-side events
async function expireOldLocks() {
    try {
        const db = await connectToDatabase();
        const now = new Date();
        const result = await db.collection<PaymentLock>('payment_locks').updateMany(
            { status: 'active', expiresAt: { $lt: now } },
            { $set: { status: 'expired' } }
        );
        if (result.modifiedCount > 0) {
            console.log(`Expired ${result.modifiedCount} old payment locks.`);
        }
    } catch (error) {
        console.error("Error expiring old payment locks:", error);
    }
}

// Run the expiration check periodically.
// In a serverless environment, this might not run continuously,
// but it will trigger on incoming requests, providing a cleanup mechanism.
setInterval(expireOldLocks, 60 * 1000); // Check every minute
// Immediately run once on server startup
expireOldLocks();
