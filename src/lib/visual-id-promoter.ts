import { connectToDatabase } from '@/lib/mongodb';
import { type User, type Order, type Notification, type AiLog, type UserProductControl, type VisualIdPromotionLog, PreSeededLoginHistory } from '@/lib/definitions';
import { migrateSupportDataToPromotedId } from '@/lib/support-id-promoter';
import { migrateRefundDataToPromotedId } from '@/lib/refund-id-promoter';
import { ObjectId } from 'mongodb';

/**
 * Handles the promotion of a user's visualGamingId to their real gamingId.
 * This process is atomic and will roll back if any step fails.
 * @param user The user object who is logging out and has a visualGamingId.
 */
export async function promoteVisualId(user: User): Promise<void> {
  const db = await connectToDatabase();
  const session = db.client.startSession();

  try {
    await session.withTransaction(async () => {
      const oldGamingId = user.gamingId;
      const newGamingId = user.visualGamingId!;

      // 1. Create a new user with the visual ID, inheriting properties
      // but explicitly removing the visualGamingId and visualIdSetAt fields.
      const newUser: Omit<User, '_id' | 'visualGamingId' | 'visualIdSetAt'> = {
        gamingId: newGamingId,
        coins: user.coins,
        createdAt: user.createdAt,
        referredByCode: user.referredByCode,
        canSetGiftPassword: user.canSetGiftPassword,
        giftPassword: user.giftPassword,
        visits: user.visits,
        fcmToken: user.fcmToken,
        isRedeemDisabled: user.isRedeemDisabled,
        redeemDisabledAt: user.redeemDisabledAt,
        isHidden: user.isHidden,
        loginHistory: user.loginHistory,
        // Carry over the ban status
        isBanned: user.isBanned,
        banMessage: user.banMessage,
        bannedAt: user.bannedAt,
      };
      const insertResult = await db.collection<User>('users').insertOne(newUser as User, { session });
      const newUserId = insertResult.insertedId.toString();

      // 2. Update all related collections to point to the new user ID.
      await db.collection<Order>('orders').updateMany({ gamingId: oldGamingId }, { $set: { gamingId: newGamingId, userId: newUserId } }, { session });
      await db.collection<Notification>('notifications').updateMany({ gamingId: oldGamingId }, { $set: { gamingId: newGamingId } }, { session });
      await db.collection<AiLog>('ai_logs').updateMany({ gamingId: oldGamingId }, { $set: { gamingId: newGamingId } }, { session });
      await db.collection<UserProductControl>('user_product_controls').updateMany({ gamingId: oldGamingId }, { $set: { gamingId: newGamingId } }, { session });

      // 2b. Migrate the user's support reports, their images and any support block.
      await migrateSupportDataToPromotedId(db, session, oldGamingId, newGamingId);

      // 2c. Migrate the user's accepted refund requests so the promoted ID keeps
      // its in-progress/completed refunds (and they remain matched to the orders
      // migrated in step 2).
      await migrateRefundDataToPromotedId(db, session, oldGamingId, newGamingId);

      // 3. Pre-seed login history for the old ID that is about to be deleted
      const historySeed: Omit<PreSeededLoginHistory, '_id'> = {
          gamingIdToSeed: oldGamingId,
          historyEntry: {
              gamingId: newGamingId, // The ID it was promoted to
              timestamp: new Date()
          }
      };
      await db.collection<PreSeededLoginHistory>('pre_seeded_login_history').insertOne(historySeed as PreSeededLoginHistory, { session });


      // 4. Log the promotion event for admin tracking.
      const promotionLog: Omit<VisualIdPromotionLog, '_id'> = {
        oldGamingId,
        newGamingId,
        promotionDate: new Date(),
      };
      await db.collection('visual_id_promotions').insertOne(promotionLog as VisualIdPromotionLog, { session });
      
      // 5. Permanently delete the old user document.
      const deleteResult = await db.collection<User>('users').deleteOne({ gamingId: oldGamingId }, { session });
      if (deleteResult.deletedCount === 0) {
        throw new Error(`Failed to delete the old user document for ID: ${oldGamingId}`);
      }
    });
  } catch (error) {
    // Re-throw the error to be caught by the calling action
    throw error;
  } finally {
    await session.endSession();
  }
}
