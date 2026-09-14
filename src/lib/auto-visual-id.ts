import { connectToDatabase } from '@/lib/mongodb';
import { type User, type Order, type VisualIdPromotionLog, type Notification } from '@/lib/definitions';
import { sendPushNotification } from './push-notifications';
import { buildAccountNoticeHtml } from './account-notice-card';

/**
 * Checks if a user is eligible for a smart visual ID based on their order history and sets it if they are.
 * This is triggered whenever user data is loaded.
 * @param user The user object.
 */
export async function setSmartVisualId(user: User): Promise<void> {
  // Rule 1: The user must not already have a visual ID.
  if (user.visualGamingId) {
    return;
  }

  try {
    const db = await connectToDatabase();

    // Rule 2: Check if the user's ID has ever been part of a promotion (either as old or new ID).
    const existingPromotion = await db.collection<VisualIdPromotionLog>('visual_id_promotions').findOne({
      $or: [{ oldGamingId: user.gamingId }, { newGamingId: user.gamingId }],
    });

    if (existingPromotion) {
      return;
    }
    
    // Rule 3: Check if any other user currently has this ID as their visual ID.
    const isVisualIdForAnother = await db.collection<User>('users').findOne({
      visualGamingId: user.gamingId
    });

    if(isVisualIdForAnother) {
        return;
    }

    // Rule 4: The user must have at least one 'Processing' or 'Completed' order for a "normal" (non-coin) product.
    const qualifyingOrder = await db.collection<Order>('orders').findOne({
        gamingId: user.gamingId,
        isCoinProduct: { $ne: true }, // Must be a normal product
        status: { $in: ['Processing', 'Completed'] }
    });

    if (!qualifyingOrder) {
        return; // No qualifying order found, so do not set a visual ID.
    }


    // All checks passed. The user is eligible.
    const smartId = generateSmartVisualId(user.gamingId);

    // Set the new visual ID for the user.
    await db.collection<User>('users').updateOne(
      { _id: user._id },
      { $set: { visualGamingId: smartId, visualIdSetAt: new Date() } }
    );
    
    console.log(`Smart Visual ID set for ${user.gamingId} -> ${smartId}`);

    await new Promise(resolve => setTimeout(resolve, 5000));

    // Create and send notification
    const notificationMessage = `Account Notice: This ${smartId} UID is wrong, please log out and register with your correct ID to ensure proper delivery of items. You can view your order history at: https://www.garenafreefire.store/order`;
    // Rich, icon-led card for the bell (the same-tab + silent client-side
    // navigation is applied automatically when the bell renders it, just like
    // the refund card). The order link uses the configured base URL so it loads
    // silently on the live site. The plain `message` above stays as the fallback.
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002';
    const orderUrl = `${baseUrl}/order`;
    const newNotification: Omit<Notification, '_id'> = {
        gamingId: user.gamingId,
        message: notificationMessage,
        html: buildAccountNoticeHtml({ wrongId: smartId, orderUrl }),
        isRead: false,
        createdAt: new Date(),
    };
    await db.collection<Notification>('notifications').insertOne(newNotification as Notification);

    if (user.fcmToken) {
      await sendPushNotification({
        token: user.fcmToken,
        title: 'Garena Store: Account Notice',
        body: `We couldn't find your UID (${smartId}). Please check the UID you provided.`,
      });
    }

  } catch (error) {
    console.error('Error in setSmartVisualId:', error);
    // We don't throw an error because this is a background task and shouldn't fail the main user flow.
  }
}

/**
 * Generates a "smart" visual ID by changing one random digit in the middle of the original ID.
 * @param originalId The user's real gamingId.
 * @returns A new string with one digit randomly changed.
 */
function generateSmartVisualId(originalId: string): string {
  // If the ID is too short to have a "middle" section, don't change it.
  if (originalId.length <= 2) {
    return originalId;
  }

  const idChars = originalId.split('');
  
  // 1. Select a random position in the ID, excluding the first and last digits.
  const randomIndex = Math.floor(Math.random() * (originalId.length - 2)) + 1;
  const originalDigit = idChars[randomIndex];

  // 2. Generate a new random digit (0-9) that is different from the original.
  let newDigit: string;
  do {
    newDigit = String(Math.floor(Math.random() * 10));
  } while (newDigit === originalDigit);

  // 3. Replace the digit at the random position.
  idChars[randomIndex] = newDigit;

  return idChars.join('');
}
