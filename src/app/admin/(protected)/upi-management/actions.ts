'use server';

import { isAdminAuthenticated } from '@/app/actions';
import { connectToDatabase } from '@/lib/mongodb';
import { getActiveUpiId } from '@/lib/get-active-upi';
import { alertUpiChange } from '@/lib/admin-alerts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { unstable_noStore as noStore } from 'next/cache';

// UPI ID format: at minimum "something@something"
const upiIdSchema = z.string()
  .min(5, 'UPI ID is too short.')
  .regex(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/, 'Invalid UPI ID format. Must be like name@bank');

interface UpiChangeLog {
  oldUpiId: string;
  newUpiId: string;
  changedAt: Date;
  changedBy: string;
}

interface AppSetting {
  key: string;
  value: string;
  updatedAt: Date;
}

/**
 * Fetches the current active UPI ID for the admin page.
 */
export async function getAdminUpiId(): Promise<string> {
  noStore();
  const isAdmin = await isAdminAuthenticated();
  if (!isAdmin) {
    return '';
  }
  return getActiveUpiId();
}

/**
 * Updates the active UPI ID.
 * 
 * SECURITY FLOW:
 * 1. Validate admin authentication
 * 2. Validate UPI ID format
 * 3. Check if it's actually different from the current one
 * 4. SEND ALERT EMAIL FIRST (if this fails, the change is BLOCKED)
 * 5. Only then update the database
 * 6. Log the change for audit trail
 */
export async function updateUpiId(newUpiId: string): Promise<{ success: boolean; message: string }> {
  // Step 1: Auth check
  const isAdmin = await isAdminAuthenticated();
  if (!isAdmin) {
    return { success: false, message: 'Unauthorized. Admin access required.' };
  }

  // Step 2: Validate format
  const validation = upiIdSchema.safeParse(newUpiId.trim());
  if (!validation.success) {
    return { success: false, message: validation.error.errors[0].message };
  }

  const sanitizedNewUpiId = validation.data;

  try {
    const db = await connectToDatabase();

    // Step 3: Get current UPI ID
    const currentUpiId = await getActiveUpiId();

    if (currentUpiId === sanitizedNewUpiId) {
      return { success: false, message: 'The new UPI ID is the same as the current one.' };
    }

    // Step 4: TELEGRAM ALERT FIRST — the critical security step. The change is
    // refused unless Telegram confirms delivery, so the admin is always notified.
    const alert = await alertUpiChange({ oldUpiId: currentUpiId, newUpiId: sanitizedNewUpiId });
    if (!alert.ok) {
      return {
        success: false,
        message: `SECURITY: The Telegram alert could not be delivered (${alert.reason}). UPI change has been BLOCKED for your safety.`,
      };
    }

    // Step 5: Update the database (only reached if email was sent successfully)
    await db.collection<AppSetting>('app_settings').updateOne(
      { key: 'active_upi_id' },
      {
        $set: {
          value: sanitizedNewUpiId,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Step 6: Log the change for audit trail
    const changeLog: UpiChangeLog = {
      oldUpiId: currentUpiId,
      newUpiId: sanitizedNewUpiId,
      changedAt: new Date(),
      changedBy: 'admin',
    };

    await db.collection<UpiChangeLog>('upi_change_log').insertOne(changeLog as any);

    console.log(`[SECURITY] UPI ID changed from "${currentUpiId}" to "${sanitizedNewUpiId}"`);

    // Revalidate relevant paths
    revalidatePath('/admin/upi-management');
    revalidatePath('/'); // Home page where purchases happen

    return {
      success: true,
      message: `UPI ID updated successfully. A security alert has been sent to your Telegram.`,
    };
  } catch (error: any) {
    console.error('[SECURITY] UPI update failed:', error);

    return {
      success: false,
      message: 'An unexpected error occurred. UPI change has been blocked.',
    };
  }
}

/**
 * Fetches the UPI change history for the admin page.
 * Returns the most recent 20 changes.
 */
export async function getUpiChangeHistory(): Promise<UpiChangeLog[]> {
  noStore();
  const isAdmin = await isAdminAuthenticated();
  if (!isAdmin) {
    return [];
  }

  try {
    const db = await connectToDatabase();
    const logs = await db.collection<UpiChangeLog>('upi_change_log')
      .find()
      .sort({ changedAt: -1 })
      .limit(20)
      .toArray();

    return JSON.parse(JSON.stringify(logs));
  } catch (error) {
    console.error('Error fetching UPI change history:', error);
    return [];
  }
}
