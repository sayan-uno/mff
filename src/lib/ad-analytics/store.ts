// --- Ad Analytics: permanent event log + report queries (server-only) ---
//
// Collection `ad_watch_events`, one document per ad session:
//   _id         the reward token (so a start and its reward meet in one document)
//   gamingId    who watched
//   adId        which ad
//   startedAt   when the ad started
//   rewardedAt  when the reward was paid (absent if the ad was never finished)
//   coins       coins paid for it
//
// Writing is best effort by design: `recordAdStart` and `recordAdReward` never
// throw, so nothing here can break or delay an ad reward. Reading happens only
// from the admin page.

import { connectToDatabase } from '@/lib/mongodb';
import { ObjectId } from 'mongodb';
import { bucketFor, bucketFormat, emptySeries, resolveRange, toIstLocal } from './ist';
import {
    AD_EVENTS_COLLECTION,
    AD_EVENT_RETENTION_DAYS,
    DEFAULT_TOP_LIMIT,
    TOP_ADS_LIMIT,
    TOP_LIMITS,
    type AdAnalyticsQuery,
    type AdAnalyticsResult,
    type AdTopAd,
    type AdTopWatcher,
} from './types';

interface AdWatchEvent {
    _id: string;
    gamingId: string;
    adId: string;
    startedAt: Date;
    rewardedAt?: Date;
    coins?: number;
    // Snapshot of what identified the ad when it was watched, so the report can
    // still show which ad it was after the ad is deleted.
    adVideoUrl?: string;
    adButtonText?: string;
    adCtaLink?: string;
}

const IST = 'Asia/Kolkata';
const MAX_GAMING_ID_FILTER_LENGTH = 64;

let indexesReady: Promise<void> | undefined;

async function events() {
    const db = await connectToDatabase();
    const collection = db.collection<AdWatchEvent>(AD_EVENTS_COLLECTION);
    if (!indexesReady) {
        indexesReady = Promise.all([
            collection.createIndex({ rewardedAt: 1 }, { name: 'rewardedAt' }),
            collection.createIndex({ gamingId: 1, rewardedAt: 1 }, { name: 'gamingId_rewardedAt' }),
            collection.createIndex({ startedAt: 1 }, { name: 'ttl_startedAt', expireAfterSeconds: AD_EVENT_RETENTION_DAYS * 24 * 60 * 60 }),
        ])
            .then(() => undefined)
            .catch((error) => {
                console.error('[ad-analytics] could not create indexes (continuing without them):', error?.message ?? error);
            });
    }
    await indexesReady;
    return { db, collection };
}

/** The ad's human-recognisable details, straight from Custom Ad Management (empty when the ad is gone). */
async function adSnapshot(db: Awaited<ReturnType<typeof connectToDatabase>>, adId: string): Promise<Pick<AdWatchEvent, 'adVideoUrl' | 'adButtonText' | 'adCtaLink'>> {
    if (!ObjectId.isValid(adId)) return {};
    const ad = await db.collection('custom_ads').findOne({ _id: new ObjectId(adId) }, { projection: { videoUrl: 1, ctaText: 1, ctaLink: 1 } });
    if (!ad) return {};
    return {
        ...(ad.videoUrl ? { adVideoUrl: String(ad.videoUrl).slice(0, 500) } : {}),
        ...(ad.ctaText ? { adButtonText: String(ad.ctaText).slice(0, 80) } : {}),
        ...(ad.ctaLink ? { adCtaLink: String(ad.ctaLink).slice(0, 500) } : {}),
    };
}

/** An ad started. Never throws. */
export async function recordAdStart(input: { token: string; gamingId: string; adId: string; startedAt: Date }): Promise<void> {
    try {
        const { db, collection } = await events();
        const snapshot = await adSnapshot(db, input.adId);
        await collection.updateOne(
            { _id: input.token },
            { $setOnInsert: { gamingId: input.gamingId, adId: input.adId, startedAt: input.startedAt, ...snapshot } },
            { upsert: true },
        );
    } catch (error) {
        console.error('[ad-analytics] could not record an ad start:', error);
    }
}

/** An ad was watched to the end and its reward was paid. Never throws. */
export async function recordAdReward(input: {
    token: string;
    gamingId: string;
    adId: string;
    startedAt: Date;
    rewardedAt: Date;
    coins: number;
}): Promise<void> {
    try {
        const { db, collection } = await events();
        const written = await collection.updateOne(
            { _id: input.token },
            {
                $set: { rewardedAt: input.rewardedAt, coins: input.coins },
                // Covers a session that began before this feature was deployed.
                $setOnInsert: { gamingId: input.gamingId, adId: input.adId, startedAt: input.startedAt },
            },
            { upsert: true },
        );
        // Only when the start was never recorded: add the ad's details now.
        if (written.upsertedCount === 1) {
            const snapshot = await adSnapshot(db, input.adId);
            if (Object.keys(snapshot).length > 0) await collection.updateOne({ _id: input.token }, { $set: snapshot });
        }
    } catch (error) {
        console.error('[ad-analytics] could not record an ad reward:', error);
    }
}

function cleanTop(value: number | undefined): number {
    return TOP_LIMITS.includes(value as (typeof TOP_LIMITS)[number]) ? (value as number) : DEFAULT_TOP_LIMIT;
}

function cleanGamingId(value: string | undefined): string {
    return String(value ?? '').trim().slice(0, MAX_GAMING_ID_FILTER_LENGTH);
}

function emptyResult(query: AdAnalyticsQuery, now: Date, error: string): AdAnalyticsResult {
    const fallback = resolveRange({}, now);
    const range = 'error' in fallback ? { start: now, end: now, label: '', preset: null, month: null } : fallback;
    return {
        generatedAt: now.toISOString(),
        range: {
            startIso: range.start.toISOString(),
            endIso: range.end.toISOString(),
            label: range.label,
            fromLocal: toIstLocal(range.start),
            toLocal: toIstLocal(new Date(range.end.getTime() - 60_000)),
            preset: range.preset,
            month: range.month,
        },
        bucket: 'day',
        totals: { watched: 0, watchers: 0, coins: 0, started: 0, completionRate: null, avgPerWatcher: 0 },
        series: [],
        topWatchers: [],
        topAds: [],
        gamingId: cleanGamingId(query.gamingId),
        top: cleanTop(query.top),
        trackingSince: null,
        error,
    };
}

/** The whole report for one period. */
export async function getAdAnalyticsReport(query: AdAnalyticsQuery): Promise<AdAnalyticsResult> {
    const now = new Date();
    const resolved = resolveRange(query, now);
    if ('error' in resolved) return emptyResult(query, now, resolved.error);

    const { start, end } = resolved;
    const gamingId = cleanGamingId(query.gamingId);
    const top = cleanTop(query.top);
    const bucket = bucketFor(start, end);
    const { db, collection } = await events();

    const who = gamingId ? { gamingId } : {};
    const rewarded = { rewardedAt: { $gte: start, $lt: end }, ...who };
    const startedInPeriod = { startedAt: { $gte: start, $lt: end }, ...who };

    const [seriesRows, watcherFacet, adRows, started, startedAndRewarded, firstEvent] = await Promise.all([
        collection
            .aggregate<{ _id: string; watched: number }>([
                { $match: rewarded },
                { $group: { _id: { $dateToString: { date: '$rewardedAt', format: bucketFormat(bucket), timezone: IST } }, watched: { $sum: 1 } } },
            ])
            .toArray(),
        collection
            .aggregate<{
                top: { _id: string; watched: number; coins: number; firstAt: Date; lastAt: Date }[];
                count: { n: number }[];
                totals: { watched: number; coins: number }[];
            }>([
                { $match: rewarded },
                {
                    $group: {
                        _id: '$gamingId',
                        watched: { $sum: 1 },
                        coins: { $sum: { $ifNull: ['$coins', 0] } },
                        firstAt: { $min: '$rewardedAt' },
                        lastAt: { $max: '$rewardedAt' },
                    },
                },
                { $sort: { watched: -1, lastAt: -1, _id: 1 } },
                {
                    $facet: {
                        top: [{ $limit: top }],
                        count: [{ $count: 'n' }],
                        totals: [{ $group: { _id: null, watched: { $sum: '$watched' }, coins: { $sum: '$coins' } } }],
                    },
                },
            ])
            .toArray(),
        collection
            .aggregate<{ _id: string; watched: number; watchers: number; videoUrl: string | null; buttonText: string | null; ctaLink: string | null }>([
                { $match: rewarded },
                { $group: { _id: { adId: '$adId', gamingId: '$gamingId' }, views: { $sum: 1 }, videoUrl: { $max: '$adVideoUrl' }, buttonText: { $max: '$adButtonText' }, ctaLink: { $max: '$adCtaLink' } } },
                { $group: { _id: '$_id.adId', watched: { $sum: '$views' }, watchers: { $sum: 1 }, videoUrl: { $max: '$videoUrl' }, buttonText: { $max: '$buttonText' }, ctaLink: { $max: '$ctaLink' } } },
                { $sort: { watched: -1, _id: 1 } },
                { $limit: TOP_ADS_LIMIT },
            ])
            .toArray(),
        collection.countDocuments(startedInPeriod),
        collection.countDocuments({ ...startedInPeriod, rewardedAt: { $exists: true } }),
        collection.find({}, { projection: { startedAt: 1 } }).sort({ startedAt: 1 }).limit(1).next(),
    ]);

    // Chart: every bucket of the period, zeros where nothing was watched.
    const series = emptySeries(start, end, bucket);
    const byKey = new Map(seriesRows.map((row) => [row._id, row.watched]));
    for (const point of series) point.watched = byKey.get(point.key) ?? 0;

    const facet = watcherFacet[0];
    const watched = facet?.totals[0]?.watched ?? 0;
    const coins = facet?.totals[0]?.coins ?? 0;
    const watchers = facet?.count[0]?.n ?? 0;
    const topWatchers: AdTopWatcher[] = (facet?.top ?? []).map((row) => ({
        gamingId: String(row._id),
        watched: row.watched,
        coins: row.coins,
        firstAt: new Date(row.firstAt).toISOString(),
        lastAt: new Date(row.lastAt).toISOString(),
    }));

    // Which ad is which: ads have no title and may share a button text, so the row
    // carries the video, the link, the length and the date added. Live details win;
    // a deleted ad falls back to the snapshot stored with its views.
    const adIds = adRows.map((row) => row._id).filter((id) => ObjectId.isValid(id));
    const ads = adIds.length
        ? await db
              .collection('custom_ads')
              .find({ _id: { $in: adIds.map((id) => new ObjectId(id)) } }, { projection: { ctaText: 1, videoUrl: 1, ctaLink: 1, totalDuration: 1, rewardTime: 1, createdAt: 1 } })
              .toArray()
        : [];
    const adById = new Map(ads.map((ad) => [ad._id.toString(), ad]));
    const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);
    const topAds: AdTopAd[] = adRows.map((row) => {
        const ad = adById.get(row._id);
        return {
            adId: row._id,
            buttonText: String(ad?.ctaText ?? row.buttonText ?? ''),
            videoUrl: ad?.videoUrl ? String(ad.videoUrl) : row.videoUrl ? String(row.videoUrl) : null,
            ctaLink: ad?.ctaLink ? String(ad.ctaLink) : row.ctaLink ? String(row.ctaLink) : null,
            durationSec: numberOrNull(ad?.totalDuration),
            rewardAtSec: numberOrNull(ad?.rewardTime),
            addedAt: ad?.createdAt ? new Date(ad.createdAt).toISOString() : null,
            exists: !!ad,
            watched: row.watched,
            watchers: row.watchers,
        };
    });

    return {
        generatedAt: now.toISOString(),
        range: {
            startIso: start.toISOString(),
            endIso: end.toISOString(),
            label: resolved.label,
            fromLocal: toIstLocal(start),
            toLocal: toIstLocal(new Date(end.getTime() - 60_000)),
            preset: resolved.preset,
            month: resolved.month,
        },
        bucket,
        totals: {
            watched,
            watchers,
            coins,
            started,
            completionRate: started > 0 ? startedAndRewarded / started : null,
            avgPerWatcher: watchers > 0 ? watched / watchers : 0,
        },
        series,
        topWatchers,
        topAds,
        gamingId,
        top,
        trackingSince: firstEvent?.startedAt ? new Date(firstEvent.startedAt).toISOString() : null,
    };
}

export { emptyResult as emptyAdAnalyticsResult };
