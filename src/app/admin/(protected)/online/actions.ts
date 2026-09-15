'use server';

// --- Online visitors: admin data action ---
// The only way the admin page reads presence data. Admin-guarded like every
// other admin action; reads nothing outside the two presence collections.

import { unstable_noStore as noStore } from 'next/cache';
import { isAdminAuthenticated } from '@/app/actions';
import { getOnlineSnapshot, sampleIfDue } from '@/lib/presence/store';
import { emptySnapshot, isHistoryRange, type HistoryRangeHours, type OnlineSnapshot } from '@/lib/presence/types';

export async function getOnlineSnapshotForAdmin(rangeHours: HistoryRangeHours): Promise<OnlineSnapshot> {
    noStore();
    const range: HistoryRangeHours = isHistoryRange(rangeHours) ? rangeHours : 6;

    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return emptySnapshot(range, true);

    try {
        // Record this minute's point even when nobody is sending heartbeats, so
        // quiet stretches show as zero on the chart instead of as gaps.
        await sampleIfDue();
        return await getOnlineSnapshot(range);
    } catch (error) {
        console.error('[presence] snapshot failed:', error);
        return emptySnapshot(range, true);
    }
}
