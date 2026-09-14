import admin from 'firebase-admin';
import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';

// Firebase Admin SDK initialization (reuses the same pattern as push-notifications.ts)
function initializeFirebaseAdmin() {
  if (!admin.apps.length) {
    try {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY;
      if (!privateKey) {
        throw new Error('FIREBASE_PRIVATE_KEY is not set');
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: privateKey.replace(/\\n/g, '\n'),
        }),
      });
      console.log('Firebase Admin SDK initialized for broadcast push notifications.');
    } catch (error: any) {
      console.error('Error initializing Firebase Admin SDK:', error.message);
    }
  }
  return admin.messaging();
}

const BATCH_SIZE = 500; // Firebase limit per sendEachForMulticast call

export interface BatchResult {
  totalSent: number;
  totalFailed: number;
  invalidTokenGamingIds: string[];
}

// Helper to build the data-only payload (same structure as push-notifications.ts)
const buildDataPayload = (payload: { title: string; body: string; imageUrl?: string }) => {
  return {
    data: {
      title: payload.title,
      body: payload.body,
      ...(payload.imageUrl && { image: payload.imageUrl }),
      link: process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002',
    },
  };
};

/**
 * Sends push notifications in batches of 500 tokens.
 * Updates the broadcast_notifications document in the database after each batch
 * so the SSE progress endpoint can stream live progress to the admin UI.
 *
 * After each batch, marks individual notification docs with pushDelivered: true
 * for users whose push was successful.
 *
 * Also cleans up invalid/expired FCM tokens from user documents and records
 * which gamingIds had their tokens removed.
 *
 * @param tokenUserPairs - Array of { token, gamingId } pairs
 */
export async function sendBatchedPushNotifications(
  tokenUserPairs: { token: string; gamingId: string }[],
  title: string,
  body: string,
  broadcastId: string,
  imageUrl?: string
): Promise<BatchResult> {
  if (tokenUserPairs.length === 0) {
    return { totalSent: 0, totalFailed: 0, invalidTokenGamingIds: [] };
  }

  const messaging = initializeFirebaseAdmin();
  const dataPayload = buildDataPayload({ title, body, imageUrl });
  const db = await connectToDatabase();
  const broadcastObjectId = new ObjectId(broadcastId);

  let totalSent = 0;
  let totalFailed = 0;
  const invalidTokens: string[] = [];
  const invalidTokenGamingIds: string[] = [];

  // Split into chunks of BATCH_SIZE
  const chunks: { token: string; gamingId: string }[][] = [];
  for (let i = 0; i < tokenUserPairs.length; i += BATCH_SIZE) {
    chunks.push(tokenUserPairs.slice(i, i + BATCH_SIZE));
  }

  console.log(`[Broadcast ${broadcastId}] Starting batched push: ${tokenUserPairs.length} tokens in ${chunks.length} batches`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkTokens = chunk.map(p => p.token);
    const batchSuccessGamingIds: string[] = [];

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: chunkTokens,
        ...dataPayload,
      });

      let batchSent = 0;
      let batchFailed = 0;

      response.responses.forEach((resp, idx) => {
        if (resp.success) {
          batchSent++;
          batchSuccessGamingIds.push(chunk[idx].gamingId);
        } else {
          batchFailed++;
          // Check for token-related errors that indicate the token is stale
          const errorCode = resp.error?.code;
          if (
            errorCode === 'messaging/invalid-registration-token' ||
            errorCode === 'messaging/registration-token-not-registered'
          ) {
            invalidTokens.push(chunk[idx].token);
            invalidTokenGamingIds.push(chunk[idx].gamingId);
          }
        }
      });

      totalSent += batchSent;
      totalFailed += batchFailed;

      console.log(
        `[Broadcast ${broadcastId}] Batch ${i + 1}/${chunks.length}: sent=${batchSent}, failed=${batchFailed}`
      );
    } catch (error) {
      // If the entire batch call fails, count all tokens in this chunk as failed
      console.error(`[Broadcast ${broadcastId}] Batch ${i + 1}/${chunks.length} failed entirely:`, error);
      totalFailed += chunk.length;
    }

    // Mark notifications as pushDelivered for users who got the push in this batch
    if (batchSuccessGamingIds.length > 0) {
      try {
        await db.collection('notifications').updateMany(
          { broadcastId, gamingId: { $in: batchSuccessGamingIds } },
          { $set: { pushDelivered: true } }
        );
      } catch (dbError) {
        console.error(`[Broadcast ${broadcastId}] Failed to mark pushDelivered for batch ${i + 1}:`, dbError);
      }
    }

    // Update progress in the database after each batch
    try {
      await db.collection('broadcast_notifications').updateOne(
        { _id: broadcastObjectId },
        {
          $set: {
            pushSent: totalSent,
            pushFailed: totalFailed,
          },
        }
      );
    } catch (dbError) {
      console.error(`[Broadcast ${broadcastId}] Failed to update progress in DB:`, dbError);
    }
  }

  // Clean up invalid tokens from user documents
  if (invalidTokens.length > 0) {
    console.log(`[Broadcast ${broadcastId}] Cleaning up ${invalidTokens.length} invalid FCM tokens`);
    try {
      await db.collection('users').updateMany(
        { fcmToken: { $in: invalidTokens } },
        { $unset: { fcmToken: '' } }
      );
      console.log(`[Broadcast ${broadcastId}] Successfully cleaned up invalid tokens`);
    } catch (cleanupError) {
      console.error(`[Broadcast ${broadcastId}] Failed to clean up invalid tokens:`, cleanupError);
    }
  }

  // Mark broadcast as completed and store removed token gaming IDs
  try {
    await db.collection('broadcast_notifications').updateOne(
      { _id: broadcastObjectId },
      {
        $set: {
          pushSent: totalSent,
          pushFailed: totalFailed,
          status: 'completed',
          ...(invalidTokenGamingIds.length > 0 && { removedTokenGamingIds: invalidTokenGamingIds }),
        },
      }
    );
  } catch (dbError) {
    console.error(`[Broadcast ${broadcastId}] Failed to mark as completed:`, dbError);
  }

  console.log(
    `[Broadcast ${broadcastId}] Complete: sent=${totalSent}, failed=${totalFailed}, removedTokens=${invalidTokenGamingIds.length}`
  );

  return { totalSent, totalFailed, invalidTokenGamingIds };
}
