'use client';

// --- Ad Analytics: admin dashboard ---
// Period picker (presets, a month, or a custom from/to in India time), headline
// numbers, a chart of rewarded ads over the period, the top watchers and the
// most watched ads. Reads only through the admin action; changes nothing.

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { ChartColumn, CirclePlay, Coins, Loader2, Percent, RefreshCw, Search, Table2, Trophy, Users, X } from 'lucide-react';
import { getAdAnalytics } from '../actions';
import { isSafeHttpUrl } from '@/lib/media-urls';
import {
    AD_RANGE_PRESETS,
    TOP_LIMITS,
    type AdAnalyticsQuery,
    type AdAnalyticsResult,
    type AdSeriesPoint,
    type AdTopAd,
} from '@/lib/ad-analytics/types';

const IST = 'Asia/Kolkata';

// One series, so no legend: the card title names it. Colour validated for the
// light admin surface (3:1 or better against it).
const chartConfig = {
    watched: { label: 'Ads watched', color: '#059669' },
} satisfies ChartConfig;

function formatDateTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatNumber(value: number): string {
    return value.toLocaleString('en-IN');
}

/** The part of a query that chooses the period (kept when only the filter or the list size changes). */
type Period = Pick<AdAnalyticsQuery, 'preset' | 'month' | 'from' | 'to'>;

function periodOf(result: AdAnalyticsResult): Period {
    if (result.range.preset) return { preset: result.range.preset };
    if (result.range.month) return { month: result.range.month };
    return { from: result.range.fromLocal, to: result.range.toLocal };
}

function hostOf(url: string | null): string {
    if (!url) return '';
    try {
        return new URL(url).hostname.replace(/^www[.]/, '');
    } catch {
        return '';
    }
}

/**
 * One ad, shown the way a person recognises it: a preview of its video, then
 * its button text, where the button leads, its length and when it was added.
 * (Several ads can share the same button text and link, so the video is what
 * really tells them apart.)
 */
function AdIdentity({ ad }: { ad: AdTopAd }) {
    const video = isSafeHttpUrl(ad.videoUrl) ? ad.videoUrl : null;
    const link = isSafeHttpUrl(ad.ctaLink) ? ad.ctaLink : null;
    const details = [
        ad.durationSec ? `${ad.durationSec}s long` : '',
        ad.rewardAtSec ? `reward at ${ad.rewardAtSec}s` : '',
        ad.addedAt ? `added ${formatDateTime(ad.addedAt)}` : '',
    ].filter(Boolean);
    return (
        <div className="flex items-center gap-3">
            {video ? (
                <a
                    href={video}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Play this ad's video in a new tab"
                    className="relative block h-[54px] w-24 shrink-0 overflow-hidden rounded-md bg-black"
                >
                    {/* #t=0.5 shows a frame from half a second in, so the preview is not a black first frame. */}
                    <video src={`${video}#t=0.5`} preload="metadata" muted playsInline className="h-full w-full object-cover" />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                        <CirclePlay className="h-5 w-5 text-white" />
                    </span>
                </a>
            ) : (
                <div className="flex h-[54px] w-24 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] text-muted-foreground">no video</div>
            )}
            <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{ad.buttonText ? `Button: "${ad.buttonText}"` : 'Unknown ad'}</span>
                    {!ad.exists && (
                        <Badge variant="secondary" title="This ad is no longer in Custom Ad Management">
                            deleted
                        </Badge>
                    )}
                </div>
                {link && (
                    <a href={link} target="_blank" rel="noopener noreferrer" className="block max-w-[340px] truncate text-xs text-muted-foreground hover:underline" title={link}>
                        Opens: {hostOf(link) || link}
                    </a>
                )}
                {details.length > 0 && <p className="text-[11px] text-muted-foreground">{details.join(' · ')}</p>}
                {!ad.exists && !video && <p className="text-[11px] text-muted-foreground">Deleted before its details were being stored.</p>}
            </div>
        </div>
    );
}

function StatTile({ label, value, caption, icon: Icon, accent = false }: { label: string; value: string; caption: string; icon: typeof Users; accent?: boolean }) {
    return (
        <Card className={accent ? 'border-emerald-300 bg-emerald-50/60' : undefined}>
            <CardContent className="p-4">
                <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                    <span>{label}</span>
                    <Icon className={`h-4 w-4 ${accent ? 'text-emerald-600' : ''}`} />
                </div>
                <div className={`mt-1 text-3xl font-bold tabular-nums ${accent ? 'text-emerald-700' : ''}`}>{value}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{caption}</div>
            </CardContent>
        </Card>
    );
}

function WatchedChart({ series }: { series: AdSeriesPoint[] }) {
    const byKey = useMemo(() => new Map(series.map((point) => [point.key, point])), [series]);
    return (
        <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
            <BarChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%">
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeWidth={1} />
                <XAxis
                    dataKey="key"
                    tickFormatter={(key: string) => byKey.get(key)?.label ?? ''}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={28}
                    tickMargin={6}
                />
                <YAxis allowDecimals={false} width={38} tickLine={false} axisLine={false} />
                <ChartTooltip
                    cursor={{ fill: 'hsl(var(--muted))' }}
                    content={<ChartTooltipContent indicator="line" labelFormatter={(label) => byKey.get(String(label))?.fullLabel ?? String(label)} />}
                />
                <Bar dataKey="watched" fill="var(--color-watched)" radius={[4, 4, 0, 0]} maxBarSize={34} isAnimationActive={false} />
            </BarChart>
        </ChartContainer>
    );
}

export default function AdAnalyticsDashboard({ initial }: { initial: AdAnalyticsResult }) {
    const [result, setResult] = useState<AdAnalyticsResult>(initial);
    const [loading, setLoading] = useState(false);
    const [fromInput, setFromInput] = useState(initial.range.fromLocal);
    const [toInput, setToInput] = useState(initial.range.toLocal);
    const [monthInput, setMonthInput] = useState(initial.range.month ?? '');
    const [gamingInput, setGamingInput] = useState(initial.gamingId);
    const [showTable, setShowTable] = useState(false);

    const run = useCallback(async (query: AdAnalyticsQuery) => {
        setLoading(true);
        try {
            const next = await getAdAnalytics(query);
            setResult(next);
            if (!next.error) {
                setFromInput(next.range.fromLocal);
                setToInput(next.range.toLocal);
                setMonthInput(next.range.month ?? '');
                setGamingInput(next.gamingId);
            }
        } catch {
            setResult((current) => ({ ...current, error: 'The report could not be loaded. Please try again.' }));
        } finally {
            setLoading(false);
        }
    }, []);

    const keep = { gamingId: result.gamingId, top: result.top };
    const applyCustom = (event: FormEvent) => {
        event.preventDefault();
        void run({ from: fromInput, to: toInput, ...keep });
    };
    const applyFilter = (event: FormEvent) => {
        event.preventDefault();
        void run({ ...periodOf(result), gamingId: gamingInput.trim(), top: result.top });
    };

    const { totals } = result;
    const bucketWord = result.bucket === 'hour' ? 'hour' : result.bucket === 'day' ? 'day' : 'month';
    const peak = result.series.reduce<AdSeriesPoint | null>((best, point) => (!best || point.watched > best.watched ? point : best), null);
    const tableRows = [...result.series].reverse();

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <CardTitle className="flex items-center gap-2">
                                <ChartColumn className="h-5 w-5 text-emerald-600" /> Ad Analytics
                            </CardTitle>
                            <CardDescription className="mt-1">
                                Rewarded ads: how many were watched, when, and by whom. All times are India time (IST).{' '}
                                {result.trackingSince
                                    ? `Recording started on ${formatDateTime(result.trackingSince)}; nothing older exists.`
                                    : 'Recording starts with the first ad watched from now on. Earlier views were never stored.'}
                            </CardDescription>
                        </div>
                        <Button size="sm" variant="outline" className="h-8 shrink-0" disabled={loading} onClick={() => void run({ ...periodOf(result), ...keep })}>
                            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            <span className="ml-1.5">Refresh</span>
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Period: presets, a month, or an exact from/to. */}
                    <div className="flex flex-wrap items-center gap-1.5">
                        {AD_RANGE_PRESETS.map((preset) => (
                            <Button
                                key={preset.value}
                                size="sm"
                                variant={result.range.preset === preset.value ? 'secondary' : 'ghost'}
                                className="h-8 px-3"
                                disabled={loading}
                                onClick={() => void run({ preset: preset.value, ...keep })}
                            >
                                {preset.label}
                            </Button>
                        ))}
                    </div>
                    <div className="grid gap-3 lg:grid-cols-[auto_1fr]">
                        <div className="space-y-1.5">
                            <Label htmlFor="ad-month" className="text-xs">A whole month</Label>
                            <Input
                                id="ad-month"
                                type="month"
                                value={monthInput}
                                disabled={loading}
                                className="h-9 w-44"
                                onChange={(event) => {
                                    setMonthInput(event.target.value);
                                    if (event.target.value) void run({ month: event.target.value, ...keep });
                                }}
                            />
                        </div>
                        <form onSubmit={applyCustom} className="flex flex-wrap items-end gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="ad-from" className="text-xs">From (IST)</Label>
                                <Input id="ad-from" type="datetime-local" value={fromInput} onChange={(event) => setFromInput(event.target.value)} className="h-9 w-56" />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="ad-to" className="text-xs">To (IST)</Label>
                                <Input id="ad-to" type="datetime-local" value={toInput} onChange={(event) => setToInput(event.target.value)} className="h-9 w-56" />
                            </div>
                            <Button type="submit" size="sm" className="h-9" disabled={loading || !fromInput || !toInput}>
                                Apply period
                            </Button>
                        </form>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Showing: <span className="font-semibold text-foreground">{result.range.label}</span>
                        {result.gamingId && (
                            <>
                                {' '}· only Gaming ID <span className="font-mono font-semibold text-foreground">{result.gamingId}</span>
                            </>
                        )}
                    </p>
                    {result.error && (
                        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{result.error}</p>
                    )}

                    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                        <StatTile label="Ads watched" value={formatNumber(totals.watched)} caption="rewarded views" icon={CirclePlay} accent />
                        <StatTile label="Watchers" value={formatNumber(totals.watchers)} caption="different Gaming IDs" icon={Users} />
                        <StatTile label="Coins given" value={formatNumber(totals.coins)} caption="paid as ad rewards" icon={Coins} />
                        <StatTile
                            label="Finished"
                            value={totals.completionRate === null ? '—' : `${Math.round(totals.completionRate * 100)}%`}
                            caption={`of ${formatNumber(totals.started)} ads started`}
                            icon={Percent}
                        />
                        <StatTile label="Per watcher" value={totals.avgPerWatcher ? totals.avgPerWatcher.toFixed(1) : '0'} caption="average ads each" icon={Trophy} />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Ads watched per {bucketWord}</CardTitle>
                    <CardDescription>
                        {peak && peak.watched > 0 ? `Busiest ${bucketWord}: ${peak.fullLabel} with ${formatNumber(peak.watched)}` : `No rewarded ads in this period`} · times in IST
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <WatchedChart series={result.series} />
                    <Collapsible open={showTable} onOpenChange={setShowTable} className="mt-3">
                        <CollapsibleTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground">
                                <Table2 className="mr-1.5 h-3.5 w-3.5" />
                                {showTable ? 'Hide table' : 'Show as table'}
                            </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                            <div className="mt-2 max-h-64 overflow-auto rounded-md border">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>{bucketWord === 'hour' ? 'Hour' : bucketWord === 'day' ? 'Day' : 'Month'} (IST)</TableHead>
                                            <TableHead className="text-right">Ads watched</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {tableRows.map((point) => (
                                            <TableRow key={point.key}>
                                                <TableCell className="text-xs">{point.fullLabel}</TableCell>
                                                <TableCell className="text-right text-xs tabular-nums">{formatNumber(point.watched)}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </CollapsibleContent>
                    </Collapsible>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Trophy className="h-4 w-4 text-amber-500" /> Top watchers
                            </CardTitle>
                            <CardDescription>
                                {totals.watchers > result.topWatchers.length
                                    ? `The ${result.topWatchers.length} who watched the most, out of ${formatNumber(totals.watchers)} watchers.`
                                    : 'Everyone who watched a rewarded ad in this period, most first.'}
                            </CardDescription>
                        </div>
                        <div className="flex flex-wrap items-end gap-2">
                            <form onSubmit={applyFilter} className="flex items-end gap-2">
                                <div className="space-y-1.5">
                                    <Label htmlFor="ad-gaming-id" className="text-xs">Only one Gaming ID</Label>
                                    <Input id="ad-gaming-id" value={gamingInput} onChange={(event) => setGamingInput(event.target.value)} placeholder="Gaming ID" className="h-9 w-44" />
                                </div>
                                <Button type="submit" size="sm" variant="outline" className="h-9" disabled={loading}>
                                    <Search className="mr-1.5 h-3.5 w-3.5" /> Filter
                                </Button>
                                {result.gamingId && (
                                    <Button type="button" size="sm" variant="ghost" className="h-9" disabled={loading} onClick={() => void run({ ...periodOf(result), gamingId: '', top: result.top })}>
                                        <X className="mr-1 h-3.5 w-3.5" /> Clear
                                    </Button>
                                )}
                            </form>
                            <div className="space-y-1.5">
                                <Label htmlFor="ad-top" className="text-xs">List size</Label>
                                <select
                                    id="ad-top"
                                    value={result.top}
                                    disabled={loading}
                                    onChange={(event) => void run({ ...periodOf(result), gamingId: result.gamingId, top: Number(event.target.value) })}
                                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                                >
                                    {TOP_LIMITS.map((limit) => (
                                        <option key={limit} value={limit}>
                                            Top {limit}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {result.topWatchers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                            <CirclePlay className="mb-2 h-8 w-8 opacity-40" />
                            <p className="text-sm">No rewarded ads in this period.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-12">#</TableHead>
                                        <TableHead>Gaming ID</TableHead>
                                        <TableHead className="text-right">Ads watched</TableHead>
                                        <TableHead className="text-right">Share</TableHead>
                                        <TableHead className="text-right">Coins earned</TableHead>
                                        <TableHead>First in period</TableHead>
                                        <TableHead>Last in period</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {result.topWatchers.map((watcher, index) => (
                                        <TableRow key={watcher.gamingId}>
                                            <TableCell className="text-xs tabular-nums text-muted-foreground">{index + 1}</TableCell>
                                            <TableCell className="whitespace-nowrap">
                                                <Link
                                                    href={`/admin/all-orders?search=${encodeURIComponent(watcher.gamingId)}`}
                                                    className="font-mono font-semibold hover:underline"
                                                    title="Open this ID's orders"
                                                >
                                                    {watcher.gamingId}
                                                </Link>
                                            </TableCell>
                                            <TableCell className="text-right font-semibold tabular-nums">{formatNumber(watcher.watched)}</TableCell>
                                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                                                {totals.watched > 0 ? `${((watcher.watched / totals.watched) * 100).toFixed(1)}%` : '—'}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">{formatNumber(watcher.coins)}</TableCell>
                                            <TableCell className="whitespace-nowrap text-xs">{formatDateTime(watcher.firstAt)}</TableCell>
                                            <TableCell className="whitespace-nowrap text-xs">{formatDateTime(watcher.lastAt)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Most watched ads</CardTitle>
                    <CardDescription>
                        Which of your ads were watched the most in this period (up to ten). Each ad is shown with a preview of its video, its button
                        text and the link it opens, the same details you enter in{' '}
                        <Link href="/admin/custom-ads" className="underline hover:text-foreground">
                            Custom Ad Management
                        </Link>
                        . Click a preview to play that video.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {result.topAds.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">No rewarded ads in this period.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-12">#</TableHead>
                                        <TableHead>Ad</TableHead>
                                        <TableHead className="text-right">Times watched</TableHead>
                                        <TableHead className="text-right">Share</TableHead>
                                        <TableHead className="text-right">Watchers</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {result.topAds.map((ad, index) => (
                                        <TableRow key={ad.adId}>
                                            <TableCell className="text-xs tabular-nums text-muted-foreground">{index + 1}</TableCell>
                                            <TableCell>
                                                <AdIdentity ad={ad} />
                                            </TableCell>
                                            <TableCell className="text-right font-semibold tabular-nums">{formatNumber(ad.watched)}</TableCell>
                                            <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                                                {totals.watched > 0 ? `${((ad.watched / totals.watched) * 100).toFixed(1)}%` : '—'}
                                            </TableCell>
                                            <TableCell className="text-right tabular-nums">{formatNumber(ad.watchers)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
