// --- Ad Analytics: India-time helpers (pure, no imports from the app) ---
// Everything the admin picks ("today", a month, a from/to) is meant in India
// time. IST is a fixed UTC+5:30 with no daylight saving, so plain arithmetic is
// exact and no timezone library is needed.

import {
    AD_RANGE_PRESETS,
    DEFAULT_PRESET,
    MAX_RANGE_DAYS,
    type AdAnalyticsQuery,
    type AdBucket,
    type AdRangePreset,
    type AdSeriesPoint,
} from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const IST_OFFSET_MS = 330 * MINUTE;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

const pad = (value: number) => String(value).padStart(2, '0');

/** The calendar fields of an instant as seen on an Indian clock. */
export function istParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
    const shifted = new Date(date.getTime() + IST_OFFSET_MS);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
    };
}

/** An Indian clock reading -> the instant. */
export function istToUtc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
    return new Date(Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MS);
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' (IST) -> the instant, or null when malformed. */
export function parseIstLocal(value: string | undefined): Date | null {
    const match = (value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!match) return null;
    const [year, month, day, hour, minute] = [match[1], match[2], match[3], match[4] ?? '0', match[5] ?? '0'].map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const date = istToUtc(year, month, day, hour, minute);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** The instant -> a datetime-local value in IST ('YYYY-MM-DDTHH:mm'). */
export function toIstLocal(date: Date): string {
    const p = istParts(date);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function startOfIstDay(date: Date): Date {
    const p = istParts(date);
    return istToUtc(p.year, p.month, p.day);
}

function startOfIstMonth(date: Date, monthShift = 0): Date {
    const p = istParts(date);
    return istToUtc(p.year, p.month + monthShift, 1); // Date.UTC rolls months over correctly
}

function hour12(hour: number): string {
    const h = hour % 12 === 0 ? 12 : hour % 12;
    return `${h} ${hour < 12 ? 'am' : 'pm'}`;
}

/** '17 Sept 2026, 3:05 pm' */
export function formatIst(date: Date): string {
    const p = istParts(date);
    const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
    return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${h}:${pad(p.minute)} ${p.hour < 12 ? 'am' : 'pm'}`;
}

export interface ResolvedRange {
    start: Date;
    /** Exclusive. */
    end: Date;
    label: string;
    preset: AdRangePreset | null;
    month: string | null;
}

/** Turns what the admin chose into exact instants. Order: custom from/to, month, preset. */
export function resolveRange(query: AdAnalyticsQuery, now: Date): ResolvedRange | { error: string } {
    const from = parseIstLocal(query.from);
    const to = parseIstLocal(query.to);
    let range: ResolvedRange;

    if (query.from || query.to) {
        if (!from || !to) return { error: 'Choose both a start and an end for a custom period.' };
        const end = new Date(to.getTime() + MINUTE); // the chosen end minute is included
        range = { start: from, end, label: `${formatIst(from)} to ${formatIst(to)}`, preset: null, month: null };
    } else if (query.month) {
        const match = query.month.match(/^(\d{4})-(\d{2})$/);
        if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return { error: 'That month is not valid.' };
        const year = Number(match[1]);
        const month = Number(match[2]);
        range = { start: istToUtc(year, month, 1), end: istToUtc(year, month + 1, 1), label: `${MONTHS[month - 1]} ${year}`, preset: null, month: query.month };
    } else {
        const known = AD_RANGE_PRESETS.find((item) => item.value === query.preset);
        const preset = known ? known.value : DEFAULT_PRESET;
        const today = startOfIstDay(now);
        const tomorrow = new Date(today.getTime() + DAY);
        const ranges: Record<AdRangePreset, [Date, Date]> = {
            today: [today, tomorrow],
            yesterday: [new Date(today.getTime() - DAY), today],
            last7: [new Date(today.getTime() - 6 * DAY), tomorrow],
            last30: [new Date(today.getTime() - 29 * DAY), tomorrow],
            thisMonth: [startOfIstMonth(now), startOfIstMonth(now, 1)],
            lastMonth: [startOfIstMonth(now, -1), startOfIstMonth(now)],
        };
        const [start, end] = ranges[preset];
        range = { start, end, label: AD_RANGE_PRESETS.find((item) => item.value === preset)!.label, preset, month: null };
    }

    if (range.end.getTime() <= range.start.getTime()) return { error: 'The end must be after the start.' };
    if (range.end.getTime() - range.start.getTime() > MAX_RANGE_DAYS * DAY) return { error: `A period can cover at most ${MAX_RANGE_DAYS} days.` };
    return range;
}

/** Hours for up to two days, days for up to about three months, months beyond that. */
export function bucketFor(start: Date, end: Date): AdBucket {
    const span = end.getTime() - start.getTime();
    if (span <= 2 * DAY) return 'hour';
    if (span <= 92 * DAY) return 'day';
    return 'month';
}

/** MongoDB $dateToString format that produces the same keys as `emptySeries`. */
export function bucketFormat(bucket: AdBucket): string {
    if (bucket === 'hour') return '%Y-%m-%d %H';
    if (bucket === 'day') return '%Y-%m-%d';
    return '%Y-%m';
}

/** Every bucket of the period, in order, with zero views: the chart never has gaps. */
export function emptySeries(start: Date, end: Date, bucket: AdBucket): AdSeriesPoint[] {
    const points: AdSeriesPoint[] = [];
    const spansDays = end.getTime() - start.getTime() > DAY;

    if (bucket === 'month') {
        for (let cursor = startOfIstMonth(start); cursor.getTime() < end.getTime(); cursor = startOfIstMonth(cursor, 1)) {
            const p = istParts(cursor);
            const label = `${MONTHS[p.month - 1]} ${p.year}`;
            points.push({ key: `${p.year}-${pad(p.month)}`, label, fullLabel: label, watched: 0 });
        }
        return points;
    }

    const step = bucket === 'hour' ? HOUR : DAY;
    const p0 = istParts(start);
    const first = bucket === 'hour' ? istToUtc(p0.year, p0.month, p0.day, p0.hour) : istToUtc(p0.year, p0.month, p0.day);
    for (let cursor = first; cursor.getTime() < end.getTime(); cursor = new Date(cursor.getTime() + step)) {
        const p = istParts(cursor);
        const dayText = `${p.day} ${MONTHS[p.month - 1]}`;
        if (bucket === 'hour') {
            points.push({
                key: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}`,
                label: spansDays && p.hour === 0 ? dayText : hour12(p.hour),
                fullLabel: `${dayText} ${p.year}, ${hour12(p.hour)}`,
                watched: 0,
            });
        } else {
            points.push({ key: `${p.year}-${pad(p.month)}-${pad(p.day)}`, label: dayText, fullLabel: `${dayText} ${p.year}`, watched: 0 });
        }
    }
    return points;
}
