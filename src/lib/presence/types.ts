// --- Online visitors ("presence") ---
// Shared constants and types for the live "who is on the site right now"
// feature. This file contains ONLY constants and types (no 'use server', no
// DB code) so it can be imported by the browser beacon, the API route, the
// MongoDB store and the admin page alike.
//
// How the feature works, in one paragraph: every open page sends a tiny
// heartbeat once on load and then every HEARTBEAT_MS while the tab is visible
// and the device is online. When the tab is hidden (other tab, minimised
// browser, switched app) or closed, the page sends a "bye" so it drops out at
// once. A visitor counts as online when their last heartbeat is younger than
// ONLINE_WINDOW_MS and they have not said bye. Anything that stops sending
// (network gone, battery died) ages out of the window by itself.
//
// The feature is fully self-contained: src/lib/presence/*, the API route
// src/app/api/presence, the beacon component src/components/presence and the
// admin page src/app/admin/(protected)/online. The only touches to existing
// code are one line mounting the beacon in the root layout and one entry in
// the admin sidebar.

/** Where the beacon posts to (anonymous, same origin). */
export const PRESENCE_ENDPOINT = '/api/presence';

/** The page pings this often while visible. */
export const HEARTBEAT_MS = 60_000;

/**
 * A visitor is "online" when their last heartbeat is younger than this.
 * 1.5 heartbeats: one missed or slightly late ping does not flicker the
 * visitor off, a dead device disappears within a minute and a half at most.
 */
export const ONLINE_WINDOW_MS = 90_000;

/** Visitor documents auto-delete this long after their last heartbeat. */
export const VISITOR_TTL_SECONDS = 30 * 60;

/** One history point per minute, kept for a week for the chart. */
export const SAMPLE_INTERVAL_MS = 60_000;
export const SAMPLE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Hard caps on what the beacon may send. */
export const MAX_BODY_BYTES = 1024;
export const MAX_PATH_LENGTH = 200;
export const MAX_USER_AGENT_LENGTH = 256;

/** Visitor ids are random hex made in the browser (32 chars normally). */
export const VISITOR_ID_PATTERN = /^[a-f0-9]{16,64}$/;

/** localStorage keys used by the beacon. */
export const PRESENCE_STORAGE_KEY = 'gg_presence_id';
export const PRESENCE_SYNC_KEY = 'gg_presence_sync';

/** Paths that are never counted (the admin is not a visitor). */
export const IGNORED_PATH_PREFIXES = ['/admin', '/api'] as const;

/** The admin Online page refreshes itself this often while it is visible. */
export const ADMIN_REFRESH_MS = 15_000;

/** The admin list shows at most this many visitors (the counts are exact). */
export const ADMIN_LIST_LIMIT = 300;

export type PresenceKind = 'hb' | 'bye';

/** What the browser sends. Field names are short on purpose (it is sent every minute by every visitor). */
export interface PresenceBeaconBody {
    /** visitor id */
    v: string;
    /** 'hb' = heartbeat (I am here), 'bye' = tab hidden or closed */
    k: PresenceKind;
    /** current pathname (no query string) */
    p: string;
    /** true when running as the installed PWA */
    a?: boolean;
}

/** One visitor as shown to the admin. */
export interface OnlineVisitor {
    id: string;
    /** Registered Gaming ID, or null for a guest. */
    gamingId: string | null;
    path: string;
    /** e.g. "Android · Chrome" */
    device: string;
    /** Installed PWA (standalone) or normal browser tab. */
    standalone: boolean;
    ip: string;
    /** ISO timestamps */
    firstSeen: string;
    lastSeen: string;
}

/** One point of the chart. */
export interface OnlineSample {
    /** ISO bucket start */
    t: string;
    online: number;
    registered: number;
    guests: number;
}

export type HistoryRangeHours = 1 | 6 | 24;
export const HISTORY_RANGES: HistoryRangeHours[] = [1, 6, 24];

/** Bucket width used for each chart range, in minutes. */
export function bucketMinutesFor(range: HistoryRangeHours): number {
    if (range === 1) return 1;
    if (range === 6) return 5;
    return 15;
}

export interface OnlineSnapshot {
    generatedAt: string;
    heartbeatMs: number;
    onlineWindowMs: number;
    /** Exact counts of visitors online right now. */
    total: number;
    registered: number;
    guests: number;
    standalone: number;
    /** The visitors themselves, newest heartbeat first, at most `listLimit`. */
    visitors: OnlineVisitor[];
    listLimit: number;
    /** Chart points for `historyHours`, oldest first, gaps filled with zeros. */
    history: OnlineSample[];
    historyHours: HistoryRangeHours;
    /** Peak of `history` (the highest bucket). */
    peak: number;
    /** True when the lookup could not run (not admin, DB error). */
    unavailable?: boolean;
}

export function emptySnapshot(range: HistoryRangeHours, unavailable = false): OnlineSnapshot {
    return {
        generatedAt: new Date().toISOString(),
        heartbeatMs: HEARTBEAT_MS,
        onlineWindowMs: ONLINE_WINDOW_MS,
        total: 0,
        registered: 0,
        guests: 0,
        standalone: 0,
        visitors: [],
        listLimit: ADMIN_LIST_LIMIT,
        history: [],
        historyHours: range,
        peak: 0,
        ...(unavailable ? { unavailable: true } : {}),
    };
}

/** True for a chart range the admin page is allowed to ask for. */
export function isHistoryRange(value: unknown): value is HistoryRangeHours {
    return value === 1 || value === 6 || value === 24;
}
