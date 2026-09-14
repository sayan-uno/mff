import { connectToDatabase } from '@/lib/mongodb';
import { type User } from '@/lib/definitions';
import { promoteVisualId } from '@/lib/visual-id-promoter';

/**
 * Checks if a given gamingId is involved in any visualGamingId relationship
 * and triggers a promotion if necessary. This is intended to be called at the
 * beginning of the user registration/login process.
 * @param gamingId The ID the user is attempting to register with.
 */
export async function handlePreRegistrationPromotion(gamingId: string): Promise<void> {
  if (!gamingId) {
    return;
  }

  try {
    const db = await connectToDatabase();
    
    // Find any user where the incoming gamingId is either their real ID (and they have a visualId)
    // or the incoming gamingId is their visualId.
    const userInvolvedInVisualId = await db.collection<User>('users').findOne({
      $and: [
        { visualGamingId: { $exists: true, $ne: null, $ne: "" } },
        { 
          $or: [
            { gamingId: gamingId },
            { visualGamingId: gamingId }
          ]
        }
      ]
    });

    // If such a user is found, it means a promotion is required.
    if (userInvolvedInVisualId) {
      console.log(`Pre-registration promotion triggered for ID: ${gamingId}. User involved: ${userInvolvedInVisualId.gamingId}`);
      // The promoteVisualId function correctly handles the logic of creating the new
      // account from the visualId and cleaning up the old one.
      await promoteVisualId(userInvolvedInVisualId);
      console.log(`Promotion complete for ID: ${gamingId}.`);
    }
  } catch (error: any) {
    // We log the error but do not re-throw it. The registration process should
    // continue. If promotion failed, the subsequent login attempt will either
    // find the original user or fail gracefully. This prevents a promotion failure
    // from breaking the entire login flow.
    console.error(`An error occurred during pre-registration promotion for ID ${gamingId}:`, error.message);
  }
}
