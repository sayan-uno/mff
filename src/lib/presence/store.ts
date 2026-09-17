// --- Online visitors: MongoDB store (server-only) ---
// Two small collections:
//
//   online_visitors  one document per browser (visitor id), updated by every
//                    heartbeat. `online: false` after a "bye". Auto-deleted
//                    30 minutes after the last heartbeat (TTL index).
//   online_samples   one document per minute: how many were online at that
//                    moment. Feeds the chart. Auto-deleted after 7 days.
//
// Nothing here touches any other collection. See src/lib/presence/types.ts for
// the overall design.

import { connectToDatabase } from '@/lib/mongodb';
import { describeDevice } from './device';
import {
    ADMIN_LIST_LIMIT,
    MAX_USER_AGENT_LENGTH,
    ONLINE_WINDOW_MS,
    SAMPLE_INTERVAL_MS,
    SAMPLE_TTL_SECONDS,
    VISITOR_TTL_SECONDS,
    bucketMinutesFor,
    emptySnapshot,
    type HistoryRangeHours,
    type OnlineSample,
    type OnlineSnapshot,
    type OnlineVisitor,
} from './types';

const VISITORS_COLLECTION = 'online_visitors';
const SAMPLES_COLLECTION = 'online_samples';
const USERS_COLLECTION = 'users';

interface VisitorDoc {
    _id: string; // visitor id made in the browser
    online: boolean;
    firstSeen: Date; // start of the current session ("online since")
    lastSeen: Date; // last heartbeat (TTL index)
    path: string;
    gamingId: string | null; // VERIFIED registered Gaming ID, or null for a guest
    claimedId: string | null; // raw gaming_id cookie value it was checked from (unsigned, never shown)
    ip: string;
    ua: string;
    device: string;
    standalone: boolean; // installed PWA
    heartbeats: number;
}

interface SampleDoc {
    _id: number; // minute bucket start, ms since epoch
    t: Date; // the same instant as a Date (TTL index)
    online: number;
    registered: number;
    guests: number;
}

export interface HeartbeatInput {
    visitorId: string;
    path: string;
    claimedGamingId: string | null; // raw, unverified gaming_id cookie value
    ip: string;
    userAgent: string;
    standalone: boolean;
}

let indexesReady: Promise<void> | undefined;

async function collections() {
    const db = await connectToDatabase();
    const visitors = db.collection<VisitorDoc>(VISITORS_COLLECTION);
    const samples = db.collection<SampleDoc>(SAMPLES_COLLECTION);
    if (!indexesReady) {
        // Best effort: the feature still works without the indexes, they only
        // make cleanup automatic and the admin query cheap.
        indexesReady = Promise.all([
            visitors.createIndex({ lastSeen: 1 }, { expireAfterSeconds: VISITOR_TTL_SECONDS, name: 'ttl_lastSeen' }),
            visitors.createIndex({ online: 1, lastSeen: -1 }, { name: 'online_lastSeen' }),
            samples.createIndex({ t: 1 }, { expireAfterSeconds: SAMPLE_TTL_SECONDS, name: 'ttl_t' }),
        ])
            .then(() => undefined)
            .catch((error) => {
                console.error('[presence] could not create indexes (continuing without them):', error?.message ?? error);
            });
    }
    await indexesReady;
    return { db, visitors, samples };
}

function onlineFilter(now: Date) {
    return { online: true, lastSeen: { $gte: new Date(now.getTime() - ONLINE_WINDOW_MS) } };
}

function toIso(value: Date | undefined, fallback: Date): string {
    const date = value instanceof Date ? value : fallback;
    return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

/**
 * The gaming_id cookie is not signed, so a visitor can send any value in it.
 * Only call someone "registered" when that Gaming ID really exists.
 */
async function verifyGamingId(db: Awaited<ReturnType<typeof connectToDatabase>>, claimed: string | null): Promise<string | null> {
    if (!claimed) return null;
    const user = await db.collection(USERS_COLLECTION).findOne({ gamingId: claimed }, { projection: { _id: 1 } });
    return user ? claimed : null;
}

/** A heartbeat: the visitor is on `path` right now. */
export async function recordHeartbeat(input: HeartbeatInput): Promise<void> {
    const { db, visitors } = await collections();
    const now = new Date();
    const ua = (input.userAgent || '').slice(0, MAX_USER_AGENT_LENGTH);
    const claimedId = input.claimedGamingId;
    const fields = {
        online: true,
        lastSeen: now,
        path: input.path,
        ip: input.ip,
        ua,
        device: describeDevice(ua),
        standalone: input.standalone,
    };

    // Hot path (almost every heartbeat): already online and the cookie is the
    // same as last time. One write, no lookup, "online since" kept.
    const kept = await visitors.updateOne(
        { _id: input.visitorId, ...onlineFilter(now), claimedId },
        { $set: fields, $inc: { heartbeats: 1 } },
    );
    if (kept.matchedCount === 0) {
        // A new session, or the cookie changed (registered, logged out): check it once.
        const gamingId = await verifyGamingId(db, claimedId);
        const identity = { ...fields, claimedId, gamingId };
        const stillOnline = await visitors.updateOne(
            { _id: input.visitorId, ...onlineFilter(now) },
            { $set: identity, $inc: { heartbeats: 1 } },
        );
        if (stillOnline.matchedCount === 0) {
            // New visitor, or one who was away: this heartbeat starts a fresh session.
            await visitors.updateOne(
                { _id: input.visitorId },
                { $set: { ...identity, firstSeen: now, heartbeats: 1 } },
                { upsert: true },
            );
        }
    }

    await sampleIfDue();
}

/** A "bye": the tab was hidden, closed or navigated away. Unknown ids create nothing. */
export async function recordLeave(visitorId: string): Promise<void> {
    const { visitors } = await collections();
    await visitors.updateOne({ _id: visitorId, online: true }, { $set: { online: false, lastSeen: new Date() } });
}

let lastSampledBucket = 0;

/**
 * Writes the "how many are online" point for the current minute, once per
 * minute per server process. Called from every heartbeat and from the admin
 * page, so quiet minutes while the admin watches are recorded as zero.
 */
export async function sampleIfDue(): Promise<void> {
    const bucket = Math.floor(Date.now() / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;
    if (bucket === lastSampledBucket) return;
    lastSampledBucket = bucket;
    try {
        const { visitors, samples } = await collections();
        const filter = onlineFilter(new Date());
        const [online, registered] = await Promise.all([
            visitors.countDocuments(filter),
            visitors.countDocuments({ ...filter, gamingId: { $ne: null } }),
        ]);
        // $max keeps the highest reading if the minute is sampled more than once.
        await samples.updateOne(
            { _id: bucket },
            { $max: { online, registered, guests: online - registered }, $setOnInsert: { t: new Date(bucket) } },
            { upsert: true },
        );
    } catch (error) {
        lastSampledBucket = 0; // try again on the next call
        console.error('[presence] could not write history sample:', error);
    }
}

/** Chart points for the last `range` hours, oldest first, every bucket present. */
async function loadHistory(
    samples: Awaited<ReturnType<typeof collections>>['samples'],
    range: HistoryRangeHours,
    now: Date,
): Promise<OnlineSample[]> {
    const bucketMs = bucketMinutesFor(range) * 60_000;
    const start = Math.floor((now.getTime() - range * 3_600_000) / bucketMs) * bucketMs;
    const docs = await samples
        .find({ t: { $gte: new Date(start) } }, { projection: { _id: 1, online: 1, registered: 1, guests: 1 } })
        .sort({ _id: 1 })
        .toArray();

    // Peak within each bucket (a 15-minute bucket holds up to 15 one-minute samples).
    const byBucket = new Map<number, OnlineSample>();
    for (const doc of docs) {
        const bucket = Math.floor(doc._id / bucketMs) * bucketMs;
        const current = byBucket.get(bucket);
        if (!current || doc.online > current.online) {
            byBucket.set(bucket, {
                t: new Date(bucket).toISOString(),
                online: doc.online,
                registered: doc.registered,
                guests: doc.guests,
            });
        }
    }

    const points: OnlineSample[] = [];
    for (let bucket = start; bucket <= now.getTime(); bucket += bucketMs) {
        points.push(byBucket.get(bucket) ?? { t: new Date(bucket).toISOString(), online: 0, registered: 0, guests: 0 });
    }
    return points;
}

/** Everything the admin Online page shows. */
export async function getOnlineSnapshot(range: HistoryRangeHours): Promise<OnlineSnapshot> {
    const { visitors, samples } = await collections();
    const now = new Date();
    const filter = onlineFilter(now);

    const [total, registered, standalone, docs, history] = await Promise.all([
        visitors.countDocuments(filter),
        visitors.countDocuments({ ...filter, gamingId: { $ne: null } }),
        visitors.countDocuments({ ...filter, standalone: true }),
        visitors
            .find(filter, { projection: { ua: 0, heartbeats: 0, claimedId: 0 } })
            .sort({ lastSeen: -1 })
            .limit(ADMIN_LIST_LIMIT)
            .toArray(),
        loadHistory(samples, range, now),
    ]);

    const list: OnlineVisitor[] = docs.map((doc) => ({
        id: doc._id,
        gamingId: doc.gamingId ?? null,
        path: doc.path || '/',
        device: doc.device || 'Unknown device',
        standalone: doc.standalone === true,
        ip: doc.ip || 'unknown',
        firstSeen: toIso(doc.firstSeen, now),
        lastSeen: toIso(doc.lastSeen, now),
    }));

    return {
        ...emptySnapshot(range),
        generatedAt: now.toISOString(),
        total,
        registered,
        guests: total - registered,
        standalone,
        visitors: list,
        history,
        peak: history.reduce((max, point) => Math.max(max, point.online), 0),
    };
}
