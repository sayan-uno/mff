// --- Ad Analytics ---
// Shared constants and types for the admin "Ad Analytics" section: how many
// rewarded ads were watched (per hour / day / month), who watched the most in a
// chosen period, and which ads were watched most.
//
// Why a new collection: the reward flow keeps its sessions in
// `ad_reward_sessions`, which deletes every record about ten minutes after the
// ad ends, so no history survives there. This feature writes its own permanent
// record, one document per ad session, into `ad_watch_events`.
//
// The feature is self-contained: src/lib/ad-analytics/* and the admin page
// src/app/admin/(protected)/ad-analytics. The only touches to existing code are
// two best-effort calls in src/lib/ad-rewards.ts (when an ad starts and when its
// reward is paid) and one entry in the admin sidebar. Recording can never break
// or slow down a reward: every failure is swallowed and logged.
//
// This file has ONLY constants and types, so client and server can share it.

export const AD_EVENTS_COLLECTION = 'ad_watch_events';

/** Events delete themselves after this many days (keeps the collection bounded). */
export const AD_EVENT_RETENTION_DAYS = 400;

/** Longest period one report may cover. */
export const MAX_RANGE_DAYS = 400;

export const TOP_LIMITS = [25, 50, 100] as const;
export const DEFAULT_TOP_LIMIT = 25;
export const TOP_ADS_LIMIT = 10;

export type AdRangePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth';

export const AD_RANGE_PRESETS: { value: AdRangePreset; label: string }[] = [
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'last7', label: 'Last 7 days' },
    { value: 'last30', label: 'Last 30 days' },
    { value: 'thisMonth', label: 'This month' },
    { value: 'lastMonth', label: 'Last month' },
];

export const DEFAULT_PRESET: AdRangePreset = 'last7';

/**
 * What the admin asks for. Exactly one way of choosing the period is used, in
 * this order: a custom from/to, a month, a preset. All local times are India
 * time (IST), formatted like an <input type="datetime-local"> value.
 */
export interface AdAnalyticsQuery {
    preset?: AdRangePreset;
    /** 'YYYY-MM' */
    month?: string;
    /** 'YYYY-MM-DDTHH:mm' (IST) */
    from?: string;
    /** 'YYYY-MM-DDTHH:mm' (IST), inclusive of that minute */
    to?: string;
    /** Only this Gaming ID (exact match). */
    gamingId?: string;
    /** How many top watchers to list. */
    top?: number;
}

export type AdBucket = 'hour' | 'day' | 'month';

export interface AdSeriesPoint {
    /** Bucket key in IST: 'YYYY-MM-DD HH', 'YYYY-MM-DD' or 'YYYY-MM'. */
    key: string;
    /** Short axis label, e.g. '3 pm', '17 Sept', 'Sept 2026'. */
    label: string;
    /** Full label for tooltips and the table, e.g. '17 Sept 2026, 3 pm'. */
    fullLabel: string;
    watched: number;
}

export interface AdTopWatcher {
    gamingId: string;
    watched: number;
    coins: number;
    /** ISO timestamps of the first and last rewarded ad inside the period. */
    firstAt: string;
    lastAt: string;
}

/**
 * One ad in the "most watched" list. Ads have no title, and several ads can
 * share the same button text and link, so what identifies an ad to a person is
 * its video. The details come from Custom Ad Management while the ad exists,
 * and otherwise from the snapshot stored with its views.
 */
export interface AdTopAd {
    adId: string;
    /** The ad's button text ("Install Now"), or '' when unknown. */
    buttonText: string;
    /** The ad video, shown as a small preview. */
    videoUrl: string | null;
    /** Where the ad's button sends people. */
    ctaLink: string | null;
    durationSec: number | null;
    rewardAtSec: number | null;
    /** When the ad was added in Custom Ad Management (ISO), if it still exists. */
    addedAt: string | null;
    /** False when the ad has since been deleted from Custom Ad Management. */
    exists: boolean;
    watched: number;
    watchers: number;
}

export interface AdAnalyticsResult {
    generatedAt: string;
    range: {
        startIso: string;
        endIso: string;
        /** Human label, e.g. 'Last 7 days' or '1 Sept 2026, 12:00 am to 17 Sept 2026, 11:59 pm'. */
        label: string;
        /** The period as datetime-local values (IST), to fill the custom inputs. */
        fromLocal: string;
        toLocal: string;
        preset: AdRangePreset | null;
        month: string | null;
    };
    bucket: AdBucket;
    totals: {
        /** Rewarded ad views in the period. */
        watched: number;
        /** Distinct Gaming IDs with at least one rewarded view. */
        watchers: number;
        coins: number;
        /** Ad sessions started in the period (rewarded or not). */
        started: number;
        /** Of those started sessions, the share that ended in a reward (0..1), or null when none started. */
        completionRate: number | null;
        avgPerWatcher: number;
    };
    series: AdSeriesPoint[];
    topWatchers: AdTopWatcher[];
    topAds: AdTopAd[];
    gamingId: string;
    top: number;
    /** When the very first event was recorded (nothing older can exist), or null when there is no data yet. */
    trackingSince: string | null;
    /** Set when the request could not be answered (bad period, not admin, database error). */
    error?: string;
}
