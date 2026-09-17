'use server';

// --- Ad Analytics: admin data action ---
// The only way the admin page reads the ad event log. Admin-guarded like every
// other admin action, and it only reads: `ad_watch_events` plus the ad button
// texts from `custom_ads`.

import { unstable_noStore as noStore } from 'next/cache';
import { isAdminAuthenticated } from '@/app/actions';
import { emptyAdAnalyticsResult, getAdAnalyticsReport } from '@/lib/ad-analytics/store';
import type { AdAnalyticsQuery, AdAnalyticsResult, AdRangePreset } from '@/lib/ad-analytics/types';

/** Server actions receive arbitrary JSON: keep only the known fields, as plain strings and numbers. */
function sanitize(input: unknown): AdAnalyticsQuery {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 64) : undefined);
    return {
        preset: text(raw.preset) as AdRangePreset | undefined,
        month: text(raw.month),
        from: text(raw.from),
        to: text(raw.to),
        gamingId: text(raw.gamingId),
        top: typeof raw.top === 'number' && Number.isFinite(raw.top) ? raw.top : undefined,
    };
}

export async function getAdAnalytics(input: AdAnalyticsQuery): Promise<AdAnalyticsResult> {
    noStore();
    const query = sanitize(input);

    const isAdmin = await isAdminAuthenticated();
    if (!isAdmin) return emptyAdAnalyticsResult(query, new Date(), 'Not authorised.');

    try {
        return await getAdAnalyticsReport(query);
    } catch (error) {
        console.error('[ad-analytics] report failed:', error);
        return emptyAdAnalyticsResult(query, new Date(), 'The report could not be loaded. Check the server logs and the MongoDB connection.');
    }
}
