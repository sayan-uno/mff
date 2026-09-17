'use client';

// --- Online visitors: admin dashboard ---
// Live count, a chart of the last 1/6/24 hours and the list of who is on
// which page. Refreshes itself every ADMIN_REFRESH_MS while this admin tab is
// visible, pauses while it is hidden. Reads only through the admin action.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
    ChartContainer,
    ChartLegend,
    ChartLegendContent,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from '@/components/ui/chart';
import { Loader2, RefreshCw, Users, UserCheck, User, Smartphone, Wifi, WifiOff, Table2, ExternalLink } from 'lucide-react';
import { getOnlineSnapshotForAdmin } from '../actions';
import {
    ADMIN_REFRESH_MS,
    HISTORY_RANGES,
    bucketMinutesFor,
    isSafeVisitorPath,
    type HistoryRangeHours,
    type OnlineSample,
    type OnlineSnapshot,
    type OnlineVisitor,
} from '@/lib/presence/types';

const IST = 'Asia/Kolkata';

// Two stacked series (registered + guests = online). Colours validated for the
// light admin surface: CVD-safe pair, >= 3:1 against the surface.
const chartConfig = {
    registered: { label: 'Registered', color: '#059669' },
    guests: { label: 'Guests', color: '#2563eb' },
} satisfies ChartConfig;

function formatTime(iso: string, withMinutes = true): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('en-IN', {
        timeZone: IST,
        hour: 'numeric',
        ...(withMinutes ? { minute: '2-digit' } : {}),
        hour12: true,
    });
}

function formatDateTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-IN', {
        timeZone: IST,
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
}

function ago(iso: string, now: number): string {
    const ms = now - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 1000) return 'just now';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function StatTile({
    label,
    value,
    caption,
    icon: Icon,
    accent = false,
}: {
    label: string;
    value: number;
    caption: string;
    icon: typeof Users;
    accent?: boolean;
}) {
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

function HistoryChart({ history, range }: { history: OnlineSample[]; range: HistoryRangeHours }) {
    const tick = (iso: string) => formatTime(iso, range !== 24);
    return (
        <ChartContainer config={chartConfig} className="aspect-auto h-60 w-full">
            <AreaChart data={history} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeWidth={1} />
                <XAxis dataKey="t" tickFormatter={tick} tickLine={false} axisLine={false} minTickGap={40} tickMargin={6} />
                <YAxis allowDecimals={false} width={34} tickLine={false} axisLine={false} />
                <ChartTooltip
                    cursor={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }}
                    content={
                        <ChartTooltipContent
                            indicator="line"
                            labelFormatter={(label, payload) => {
                                const point = (payload?.[0]?.payload ?? null) as OnlineSample | null;
                                const when = formatTime(point?.t ?? String(label));
                                return `${when} · ${point?.online ?? 0} online`;
                            }}
                        />
                    }
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Area
                    dataKey="registered"
                    stackId="online"
                    type="monotone"
                    stroke="var(--color-registered)"
                    fill="var(--color-registered)"
                    fillOpacity={0.12}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                    isAnimationActive={false}
                />
                <Area
                    dataKey="guests"
                    stackId="online"
                    type="monotone"
                    stroke="var(--color-guests)"
                    fill="var(--color-guests)"
                    fillOpacity={0.12}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }}
                    isAnimationActive={false}
                />
            </AreaChart>
        </ChartContainer>
    );
}

function VisitorRow({ visitor, now }: { visitor: OnlineVisitor; now: number }) {
    return (
        <TableRow>
            <TableCell className="whitespace-nowrap">
                {visitor.gamingId ? (
                    <div className="flex items-center gap-2">
                        <Link
                            href={`/admin/all-orders?search=${encodeURIComponent(visitor.gamingId)}`}
                            className="font-mono font-semibold hover:underline"
                            title="Open this ID's orders"
                        >
                            {visitor.gamingId}
                        </Link>
                        <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100" variant="secondary">
                            Registered
                        </Badge>
                    </div>
                ) : (
                    <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground" title={`Visitor ${visitor.id}`}>
                            {visitor.id.slice(0, 8)}
                        </span>
                        <Badge variant="secondary">Guest</Badge>
                    </div>
                )}
            </TableCell>
            <TableCell className="max-w-[220px]">
                {/* Only a plain same-site path ever becomes a link (the API refuses
                    anything else, this is the second lock on the same door). */}
                {isSafeVisitorPath(visitor.path) ? (
                    <a
                        href={visitor.path}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1 font-mono text-xs hover:underline"
                        title={visitor.path}
                    >
                        <span className="truncate">{visitor.path}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                    </a>
                ) : (
                    <span className="block truncate font-mono text-xs text-muted-foreground" title="Not a valid page path, shown as text only">
                        {visitor.path.slice(0, 60)}
                    </span>
                )}
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs">
                <span className="inline-flex items-center gap-1.5">
                    {visitor.device}
                    {visitor.standalone && (
                        <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px]">
                            <Smartphone className="h-3 w-3" /> App
                        </Badge>
                    )}
                </span>
            </TableCell>
            <TableCell className="whitespace-nowrap font-mono text-xs">
                {visitor.ip !== 'unknown' ? (
                    <Link href={`/admin/ip-logger?ip=${encodeURIComponent(visitor.ip)}`} className="hover:underline" title="Open in User Security Logs">
                        {visitor.ip}
                    </Link>
                ) : (
                    'unknown'
                )}
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs" title={formatDateTime(visitor.firstSeen)}>
                {ago(visitor.firstSeen, now)}
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs" title={formatDateTime(visitor.lastSeen)}>
                {ago(visitor.lastSeen, now)}
            </TableCell>
        </TableRow>
    );
}

export default function OnlineDashboard({ initial }: { initial: OnlineSnapshot }) {
    const [snapshot, setSnapshot] = useState<OnlineSnapshot>(initial);
    const [range, setRange] = useState<HistoryRangeHours>(initial.historyHours);
    const [refreshing, setRefreshing] = useState(false);
    const [paused, setPaused] = useState(false);
    // Starts at the snapshot's own timestamp so the server-rendered HTML and the
    // browser's first render print identical "x ago" texts (no hydration
    // mismatch); the real clock takes over right after mount.
    const [now, setNow] = useState(() => new Date(initial.generatedAt).getTime());
    const [showTable, setShowTable] = useState(false);
    const rangeRef = useRef(range);

    const refresh = useCallback(async (nextRange?: HistoryRangeHours) => {
        const wanted = nextRange ?? rangeRef.current;
        setRefreshing(true);
        try {
            const fresh = await getOnlineSnapshotForAdmin(wanted);
            // Ignore a late answer for a range the admin has already left.
            if (fresh.historyHours === rangeRef.current) setSnapshot(fresh);
        } catch {
            /* keep showing the last good snapshot */
        } finally {
            setRefreshing(false);
        }
    }, []);

    const changeRange = (next: HistoryRangeHours) => {
        rangeRef.current = next;
        setRange(next);
        void refresh(next);
    };

    // Auto-refresh while this tab is visible; pause while hidden.
    useEffect(() => {
        const tick = () => {
            if (document.visibilityState === 'visible') void refresh();
        };
        const onVisibility = () => {
            const hidden = document.visibilityState !== 'visible';
            setPaused(hidden);
            if (!hidden) void refresh();
        };
        const interval = window.setInterval(tick, ADMIN_REFRESH_MS);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.clearInterval(interval);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [refresh]);

    // Keeps the "x seconds ago" texts moving between refreshes.
    useEffect(() => {
        setNow(Date.now());
        const interval = window.setInterval(() => setNow(Date.now()), 5000);
        return () => window.clearInterval(interval);
    }, []);

    const windowSeconds = Math.round(snapshot.onlineWindowMs / 1000);
    const heartbeatSeconds = Math.round(snapshot.heartbeatMs / 1000);
    const bucketMinutes = bucketMinutesFor(range);
    const tableRows = [...snapshot.history].reverse();

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <CardTitle className="flex items-center gap-2">
                                <Wifi className="h-5 w-5 text-emerald-600" /> Online Now
                            </CardTitle>
                            <CardDescription className="mt-1">
                                Visitors whose page sent a heartbeat in the last {windowSeconds} seconds. Pages ping every{' '}
                                {heartbeatSeconds} seconds while visible; hidden tabs, minimised browsers and offline devices
                                drop out. Guests count too.
                            </CardDescription>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {paused ? (
                                <span className="inline-flex items-center gap-1">
                                    <WifiOff className="h-3.5 w-3.5" /> Auto-refresh paused
                                </span>
                            ) : (
                                <span title={formatDateTime(snapshot.generatedAt)}>Updated {ago(snapshot.generatedAt, now)}</span>
                            )}
                            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing} className="h-8">
                                {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                <span className="ml-1.5">Refresh</span>
                            </Button>
                        </div>
                    </div>
                    {snapshot.unavailable && (
                        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                            Presence data could not be loaded. Check the server logs and the MongoDB connection.
                        </p>
                    )}
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <StatTile label="Online now" value={snapshot.total} caption="every device on the site" icon={Users} accent />
                        <StatTile label="Registered" value={snapshot.registered} caption="with a Gaming ID" icon={UserCheck} />
                        <StatTile label="Guests" value={snapshot.guests} caption="not registered yet" icon={User} />
                        <StatTile label="Installed app" value={snapshot.standalone} caption="using the PWA" icon={Smartphone} />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <CardTitle className="text-base">Online over time</CardTitle>
                            <CardDescription>
                                Peak {snapshot.peak} in the last {range}h · one point per {bucketMinutes} min · times in IST
                            </CardDescription>
                        </div>
                        <div className="flex items-center gap-1">
                            {HISTORY_RANGES.map((hours) => (
                                <Button
                                    key={hours}
                                    size="sm"
                                    variant={range === hours ? 'secondary' : 'ghost'}
                                    className="h-8 px-3"
                                    onClick={() => changeRange(hours)}
                                >
                                    {hours}h
                                </Button>
                            ))}
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <HistoryChart history={snapshot.history} range={range} />
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
                                            <TableHead>Time (IST)</TableHead>
                                            <TableHead className="text-right">Online</TableHead>
                                            <TableHead className="text-right">Registered</TableHead>
                                            <TableHead className="text-right">Guests</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {tableRows.map((point) => (
                                            <TableRow key={point.t}>
                                                <TableCell className="text-xs">{formatDateTime(point.t)}</TableCell>
                                                <TableCell className="text-right text-xs tabular-nums">{point.online}</TableCell>
                                                <TableCell className="text-right text-xs tabular-nums">{point.registered}</TableCell>
                                                <TableCell className="text-right text-xs tabular-nums">{point.guests}</TableCell>
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
                    <CardTitle className="text-base">Visitors ({snapshot.total})</CardTitle>
                    <CardDescription>
                        {snapshot.total > snapshot.listLimit
                            ? `Showing the ${snapshot.listLimit} most recent heartbeats of ${snapshot.total}.`
                            : 'Newest heartbeat first.'}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {snapshot.visitors.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                            <WifiOff className="mb-2 h-8 w-8 opacity-40" />
                            <p className="text-sm">No one is online right now.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Visitor</TableHead>
                                        <TableHead>Page</TableHead>
                                        <TableHead>Device</TableHead>
                                        <TableHead>IP</TableHead>
                                        <TableHead>Online since</TableHead>
                                        <TableHead>Last ping</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {snapshot.visitors.map((visitor) => (
                                        <VisitorRow key={visitor.id} visitor={visitor} now={now} />
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
