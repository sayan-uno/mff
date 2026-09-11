
'use client';

import { useState, useTransition, useEffect, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, Search, ArrowUpDown, Trash2, Megaphone, Users, CheckCircle2, XCircle, Clock, Eye, EyeOff, Info, ChevronDown, ShieldX, Bell, BellOff, Smartphone, Copy, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getNotifications, deleteNotification, deleteNotifications, deleteNotificationsInRange, getBroadcastNotifications, deleteBroadcastNotification, getBroadcastDetails, searchBroadcastUser } from '../actions';
import type { Notification, BroadcastNotification } from '@/lib/definitions';
import type { BroadcastDetailUser, BroadcastDetails, BroadcastUserSearchResult } from '../actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import SmartImage from '@/components/smart-image';
import { isVideoUrl } from '@/lib/media-urls';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

interface NotificationListProps {
  initialNotifications: Notification[];
  initialHasMore: boolean;
  totalNotifications: number;
  initialBroadcasts: BroadcastNotification[];
  initialBroadcastHasMore: boolean;
  totalBroadcasts: number;
  initialTab: string;
}

const FormattedDate = ({ dateString }: { dateString: string }) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;
    return new Date(dateString).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric' });
}

const NotificationMedia = ({ src, alt }: { src: string; alt: string }) => {
  const isVideo = isVideoUrl(src);
  if (isVideo) return <video src={src} autoPlay loop muted playsInline className="w-full h-full object-cover" />;
  return <SmartImage src={src} alt={alt} fill className="object-cover" />;
};

const ClickableMessage = ({ message }: { message: string }) => {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = message.split(urlRegex);
  return (
    <p className="text-sm break-words">
      {parts.map((part, i) => part.match(urlRegex) ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all" onClick={e => e.stopPropagation()}>{part}</a> : part)}
    </p>
  );
};

const StatusBadge = ({ status }: { status: string }) => {
  if (status === 'completed') return <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle2 className="h-3 w-3 mr-1" />Completed</Badge>;
  if (status === 'sending') return <Badge className="bg-blue-600 hover:bg-blue-700 animate-pulse"><Clock className="h-3 w-3 mr-1" />Sending...</Badge>;
  if (status === 'failed') return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
};

function BroadcastInlineProgress({ broadcastId, onComplete }: { broadcastId: string; onComplete: () => void }) {
  const [progress, setProgress] = useState({ pushSent: 0, pushFailed: 0, pushTotal: 0, totalUsers: 0, status: 'sending', done: false });
  useEffect(() => {
    const es = new EventSource(`/api/broadcast-progress?id=${broadcastId}`);
    es.onmessage = (e) => { try { const d = JSON.parse(e.data); setProgress(d); if (d.done) { es.close(); onComplete(); } } catch {} };
    es.onerror = () => es.close();
    return () => es.close();
  }, [broadcastId, onComplete]);
  const total = progress.pushTotal || progress.totalUsers;
  const processed = progress.pushSent + progress.pushFailed;
  const pct = total > 0 ? Math.min(Math.round((processed / total) * 100), 100) : 0;
  return (
    <div className="space-y-2 pt-2 border-t">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1 animate-pulse"><Clock className="h-3 w-3" /> Sending push notifications...</span>
        <span>{pct}%</span>
      </div>
      <Progress value={pct} className="h-2" />
      <div className="flex items-center gap-3 text-xs">
        <span className="text-green-600">{progress.pushSent} sent</span>
        <span className="text-red-500">{progress.pushFailed} failed</span>
        <span className="text-muted-foreground">of {total} tokens</span>
      </div>
    </div>
  );
}

// --- User Search Result Card ---
function UserSearchResultCard({ result }: { result: BroadcastUserSearchResult }) {
  if (!result.hasNotification) {
    return <div className="p-4 rounded-lg border bg-muted/50 text-center"><p className="text-sm text-muted-foreground">User <span className="font-mono font-bold">{result.gamingId}</span> was not part of this broadcast.</p></div>;
  }
  return (
    <div className="p-4 rounded-lg border space-y-3">
      <p className="font-mono font-bold text-sm">{result.gamingId}</p>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col items-center gap-1 p-2 rounded-md bg-muted/50">
          {result.isRead ? <Eye className="h-4 w-4 text-green-600" /> : <EyeOff className="h-4 w-4 text-orange-500" />}
          <span className="text-xs font-medium">{result.isRead ? 'Read' : 'Unread'}</span>
        </div>
        <div className="flex flex-col items-center gap-1 p-2 rounded-md bg-muted/50">
          {result.pushDelivered ? <Smartphone className="h-4 w-4 text-green-600" /> : <BellOff className="h-4 w-4 text-orange-500" />}
          <span className="text-xs font-medium">{result.pushDelivered ? 'Push Sent' : 'In-App Only'}</span>
        </div>
        <div className="flex flex-col items-center gap-1 p-2 rounded-md bg-muted/50">
          {result.tokenRemoved ? <ShieldX className="h-4 w-4 text-red-500" /> : <CheckCircle2 className="h-4 w-4 text-green-600" />}
          <span className="text-xs font-medium">{result.tokenRemoved ? 'Token Removed' : 'Token OK'}</span>
        </div>
      </div>
    </div>
  );
}

// --- More Details Dialog ---
function BroadcastDetailsDialog({ broadcastId, isOpen, onClose }: { broadcastId: string; isOpen: boolean; onClose: () => void }) {
  const [details, setDetails] = useState<BroadcastDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [userPage, setUserPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailTab, setDetailTab] = useState('users');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<BroadcastUserSearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (isOpen && broadcastId) {
      setLoading(true); setUserPage(1); setDetails(null); setSearchResult(null); setSearchQuery('');
      getBroadcastDetails(broadcastId, 1).then(r => { if (r.success && r.details) setDetails(r.details); setLoading(false); });
    }
  }, [isOpen, broadcastId]);

  const handleLoadMore = async () => {
    if (!details) return;
    setLoadingMore(true);
    const next = userPage + 1;
    const r = await getBroadcastDetails(broadcastId, next);
    if (r.success && r.details) {
      setDetails(prev => prev ? { ...prev, users: [...prev.users, ...r.details!.users], hasMoreUsers: r.details!.hasMoreUsers } : r.details!);
      setUserPage(next);
    }
    setLoadingMore(false);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true); setSearchResult(null);
    const r = await searchBroadcastUser(broadcastId, searchQuery.trim());
    if (r.success && r.result) setSearchResult(r.result);
    setSearching(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Info className="h-5 w-5" /> Broadcast Details</DialogTitle>
          <DialogDescription>Search a user or browse delivery stats.</DialogDescription>
        </DialogHeader>

        {/* Search Bar */}
        <form onSubmit={handleSearch} className="flex items-center gap-2">
          <Input placeholder="Search Gaming ID..." value={searchQuery} onChange={e => { setSearchQuery(e.target.value); if (!e.target.value) setSearchResult(null); }} className="flex-1" />
          <Button type="submit" size="icon" variant="outline" disabled={searching}>
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </form>

        {searchResult && <UserSearchResultCard result={searchResult} />}

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : details ? (
          <div className="flex-1 min-h-0 space-y-4">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-3 text-center p-3 rounded-lg bg-muted/50">
              <div><div className="flex items-center justify-center gap-1"><Eye className="h-4 w-4 text-green-600" /><span className="text-xl font-bold text-green-600">{details.totalRead}</span></div><p className="text-xs text-muted-foreground">Read</p></div>
              <div><div className="flex items-center justify-center gap-1"><Smartphone className="h-4 w-4 text-blue-500" /><span className="text-xl font-bold text-blue-500">{details.totalPushDelivered}</span></div><p className="text-xs text-muted-foreground">Push Delivered</p></div>
              <div><div className="flex items-center justify-center gap-1"><ShieldX className="h-4 w-4 text-red-500" /><span className="text-xl font-bold text-red-500">{details.removedTokenGamingIds.length}</span></div><p className="text-xs text-muted-foreground">Tokens Removed</p></div>
            </div>

            <Tabs value={detailTab} onValueChange={setDetailTab} className="flex-1 min-h-0 flex flex-col">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="users" className="text-xs"><Users className="h-3.5 w-3.5 mr-1" />Users ({details.totalRead + details.totalUnread})</TabsTrigger>
                <TabsTrigger value="removed" className="text-xs"><ShieldX className="h-3.5 w-3.5 mr-1" />Removed ({details.removedTokenGamingIds.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="users" className="flex-1 min-h-0 mt-2">
                <ScrollArea className="h-[250px] rounded-md border">
                  <div className="p-3 space-y-1">
                    {details.users.map((user, idx) => {
                      const prev = idx > 0 ? details.users[idx - 1] : null;
                      const showPushSeparator = prev && prev.isRead && !user.isRead && user.pushDelivered;
                      const showInAppSeparator = prev && (prev.isRead || prev.pushDelivered) && !user.isRead && !user.pushDelivered;
                      return (
                        <div key={`${user.gamingId}-${idx}`}>
                          {showPushSeparator && <div className="flex items-center gap-2 py-2"><Separator className="flex-1" /><span className="text-xs text-muted-foreground whitespace-nowrap">Push Delivered (Unread)</span><Separator className="flex-1" /></div>}
                          {showInAppSeparator && <div className="flex items-center gap-2 py-2"><Separator className="flex-1" /><span className="text-xs text-muted-foreground whitespace-nowrap">In-App Only</span><Separator className="flex-1" /></div>}
                          <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50">
                            <span className="text-sm font-mono">{user.gamingId}</span>
                            <div className="flex items-center gap-1">
                              {user.isRead && <Badge variant="secondary" className="text-xs"><Eye className="h-3 w-3 mr-1" />Read</Badge>}
                              {user.pushDelivered && <Badge className="text-xs bg-blue-500 hover:bg-blue-600"><Smartphone className="h-3 w-3 mr-1" />Push</Badge>}
                              {!user.pushDelivered && !user.isRead && <Badge variant="outline" className="text-xs text-orange-500 border-orange-300"><BellOff className="h-3 w-3 mr-1" />In-App</Badge>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {details.hasMoreUsers && (
                      <div className="flex justify-center pt-2">
                        <Button variant="ghost" size="sm" onClick={handleLoadMore} disabled={loadingMore}>
                          {loadingMore ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />} Load more
                        </Button>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="removed" className="flex-1 min-h-0 mt-2">
                <ScrollArea className="h-[250px] rounded-md border">
                  <div className="p-3 space-y-1">
                    {details.removedTokenGamingIds.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-8">No tokens were removed.</p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground mb-2">These users had expired/invalid FCM tokens that were cleaned up.</p>
                        {details.removedTokenGamingIds.map((gid, i) => (
                          <div key={`${gid}-${i}`} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50">
                            <span className="text-sm font-mono">{gid}</span>
                            <Badge variant="destructive" className="text-xs"><ShieldX className="h-3 w-3 mr-1" />Removed</Badge>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        ) : <p className="text-muted-foreground text-center py-8">Failed to load details.</p>}
      </DialogContent>
    </Dialog>
  );
}


export default function NotificationList({ initialNotifications, initialHasMore, totalNotifications, initialBroadcasts, initialBroadcastHasMore, totalBroadcasts, initialTab }: NotificationListProps) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [broadcasts, setBroadcasts] = useState(initialBroadcasts);
  const [broadcastPage, setBroadcastPage] = useState(1);
  const [broadcastHasMore, setBroadcastHasMore] = useState(initialBroadcastHasMore);
  const [detailsBroadcastId, setDetailsBroadcastId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  const sort = searchParams.get('sort') || 'desc';
  const activeTab = searchParams.get('tab') || 'broadcasts';
  const activeStartDate = searchParams.get('startDate') || '';
  const activeEndDate = searchParams.get('endDate') || '';
  const hasFilter = Boolean(search || activeStartDate || activeEndDate);

  useEffect(() => { setNotifications(initialNotifications); setHasMore(initialHasMore); setPage(1); setSelectedIds(new Set()); }, [initialNotifications, initialHasMore]);
  useEffect(() => { setBroadcasts(initialBroadcasts); setBroadcastHasMore(initialBroadcastHasMore); setBroadcastPage(1); }, [initialBroadcasts, initialBroadcastHasMore]);

  const handleLoadMore = () => startTransition(async () => { const np = page + 1; const r = await getNotifications(np, search, sort, activeStartDate, activeEndDate); setNotifications(p => [...p, ...r.notifications]); setHasMore(r.hasMore); setPage(np); });
  const handleBroadcastLoadMore = () => startTransition(async () => { const np = broadcastPage + 1; const r = await getBroadcastNotifications(np, sort); setBroadcasts(p => [...p, ...r.broadcasts]); setBroadcastHasMore(r.hasMore); setBroadcastPage(np); });
  const handleSortToggle = () => { const p = new URLSearchParams(searchParams); p.set('sort', sort === 'desc' ? 'asc' : 'desc'); router.push(`${pathname}?${p.toString()}`); };
  const handleFilter = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const p = new URLSearchParams(searchParams);
    const setOrDelete = (key: string, value: string) => { if (value) p.set(key, value); else p.delete(key); };
    setOrDelete('search', (fd.get('search') as string)?.trim() || '');
    setOrDelete('startDate', (fd.get('startDate') as string) || '');
    setOrDelete('endDate', (fd.get('endDate') as string) || '');
    p.delete('page');
    router.push(`${pathname}?${p.toString()}`);
  };
  const handleClearFilters = () => { const p = new URLSearchParams(searchParams); p.delete('search'); p.delete('startDate'); p.delete('endDate'); p.delete('page'); router.push(`${pathname}?${p.toString()}`); };
  const handleTabChange = (v: string) => { const p = new URLSearchParams(searchParams); p.set('tab', v); router.push(`${pathname}?${p.toString()}`); };
  const handleDelete = (id: string) => startTransition(async () => { const r = await deleteNotification(id); if (r.success) { setNotifications(p => p.filter(n => n._id.toString() !== id)); setSelectedIds(prev => { const next = new Set(prev); next.delete(id); return next; }); toast({ title: 'Success', description: r.message }); } else toast({ variant: 'destructive', title: 'Error', description: r.message }); });

  const allLoadedSelected = notifications.length > 0 && notifications.every(n => selectedIds.has(n._id.toString()));
  const toggleSelectAll = (checked: boolean) => { if (checked) setSelectedIds(new Set(notifications.map(n => n._id.toString()))); else setSelectedIds(new Set()); };
  const toggleSelectOne = (id: string, checked: boolean) => { setSelectedIds(prev => { const next = new Set(prev); if (checked) next.add(id); else next.delete(id); return next; }); };
  const handleBulkCopy = async () => {
    const ids = notifications.filter(n => selectedIds.has(n._id.toString())).map(n => n.gamingId);
    if (ids.length === 0) return;
    try { await navigator.clipboard.writeText(ids.join(',')); toast({ title: 'Copied', description: `Copied ${ids.length} Gaming ID(s) to clipboard.` }); }
    catch { toast({ variant: 'destructive', title: 'Error', description: 'Could not access the clipboard.' }); }
  };
  const handleDeleteSelected = () => startDeleting(async () => {
    const ids = Array.from(selectedIds);
    const r = await deleteNotifications(ids);
    if (r.success) { setNotifications(p => p.filter(n => !selectedIds.has(n._id.toString()))); setSelectedIds(new Set()); toast({ title: 'Deleted', description: r.message }); router.refresh(); }
    else toast({ variant: 'destructive', title: 'Error', description: r.message });
  });
  const handleDeleteAllInRange = () => startDeleting(async () => {
    const r = await deleteNotificationsInRange(search, activeStartDate, activeEndDate);
    if (r.success) { setSelectedIds(new Set()); toast({ title: 'Deleted', description: r.message }); router.refresh(); }
    else toast({ variant: 'destructive', title: 'Error', description: r.message });
  });
  const handleDeleteBroadcast = (id: string) => startTransition(async () => { const r = await deleteBroadcastNotification(id); if (r.success) { setBroadcasts(p => p.filter(b => b._id.toString() !== id)); toast({ title: 'Success', description: r.message }); } else toast({ variant: 'destructive', title: 'Error', description: r.message }); });
  const handleBroadcastComplete = useCallback((id: string) => { setBroadcasts(p => p.map(b => b._id.toString() === id ? { ...b, status: 'completed' as const } : b)); router.refresh(); }, [router]);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <CardTitle>Users Notification</CardTitle>
            <Button variant="outline" onClick={handleSortToggle}><ArrowUpDown className="mr-2 h-4 w-4" />{sort === 'desc' ? 'Newest First' : 'Oldest First'}</Button>
          </div>
          <CardDescription>Manage broadcast and individual notifications sent to users.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="broadcasts" className="flex items-center gap-2"><Megaphone className="h-4 w-4" />Broadcasts<Badge variant="secondary" className="ml-1">{totalBroadcasts}</Badge></TabsTrigger>
              <TabsTrigger value="individual" className="flex items-center gap-2"><Users className="h-4 w-4" />Individual<Badge variant="secondary" className="ml-1">{totalNotifications}</Badge></TabsTrigger>
            </TabsList>

            <TabsContent value="broadcasts" className="space-y-4">
              {broadcasts.length === 0 ? <p className="text-muted-foreground text-center py-8">No broadcast notifications found.</p> : (
                <div className="space-y-4">
                  {broadcasts.map(b => (
                    <Card key={b._id.toString()} className="flex flex-col border-l-4 border-l-blue-500">
                      <CardHeader className="flex flex-row justify-between items-start pb-2">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2"><Megaphone className="h-4 w-4 text-blue-500" /><CardTitle className="text-base">Sent to All Users</CardTitle><StatusBadge status={b.status} /></div>
                          <CardDescription><FormattedDate dateString={b.createdAt as unknown as string} /></CardDescription>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <ClickableMessage message={b.message} />
                        {b.imageUrl && <div className="mt-2 relative aspect-video w-full max-w-sm rounded-md overflow-hidden"><NotificationMedia src={b.imageUrl} alt="Broadcast media" /></div>}
                        <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground pt-2 border-t">
                          <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{b.totalUsers} users</span>
                          {b.status === 'completed' && <><span className="flex items-center gap-1 text-green-600"><CheckCircle2 className="h-3.5 w-3.5" />{b.pushSent} push sent</span>{b.pushFailed > 0 && <span className="flex items-center gap-1 text-red-500"><XCircle className="h-3.5 w-3.5" />{b.pushFailed} failed</span>}</>}
                          {b.isPopup && <Badge variant="outline" className="text-xs">Popup</Badge>}
                        </div>
                        {b.status === 'sending' && <BroadcastInlineProgress broadcastId={b._id.toString()} onComplete={() => handleBroadcastComplete(b._id.toString())} />}
                      </CardContent>
                      <CardFooter className="flex justify-end gap-2 bg-muted/40 p-2">
                        {b.status === 'completed' && <Button variant="outline" size="sm" onClick={() => setDetailsBroadcastId(b._id.toString())}><Info className="h-4 w-4 mr-1" /> More Details</Button>}
                        <AlertDialog>
                          <AlertDialogTrigger asChild><Button variant="destructive" size="sm" disabled={isPending}><Trash2 className="h-4 w-4 mr-1" /> Delete from all accounts</Button></AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader><AlertDialogTitle>Delete this broadcast?</AlertDialogTitle><AlertDialogDescription>This will permanently delete this broadcast from <strong>every user's account</strong> ({b.totalUsers} users). Cannot be undone.</AlertDialogDescription></AlertDialogHeader>
                            <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => handleDeleteBroadcast(b._id.toString())}>Yes, Delete from All</AlertDialogAction></AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              )}
              {broadcastHasMore && <div className="flex justify-center pt-4"><Button onClick={handleBroadcastLoadMore} disabled={isPending}>{isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Load More</Button></div>}
            </TabsContent>

            <TabsContent value="individual" className="space-y-4">
              <form onSubmit={handleFilter} className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4 mb-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="search">Search Gaming ID</Label>
                    <Input id="search" name="search" placeholder="Gaming ID..." defaultValue={search} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="startDate">From (IST)</Label>
                    <Input id="startDate" name="startDate" type="datetime-local" defaultValue={activeStartDate} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="endDate">To (IST)</Label>
                    <Input id="endDate" name="endDate" type="datetime-local" defaultValue={activeEndDate} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="submit" variant="outline"><Search className="mr-2 h-4 w-4" />Apply Filter</Button>
                  {hasFilter && <Button type="button" variant="ghost" onClick={handleClearFilters}><X className="mr-2 h-4 w-4" />Clear</Button>}
                </div>
              </form>
              {notifications.length === 0 ? <p className="text-muted-foreground text-center py-8">No individual notifications found.</p> : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                    <div className="flex items-center gap-2">
                      <Checkbox id="select-all-notifications" checked={allLoadedSelected} onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))} />
                      <Label htmlFor="select-all-notifications" className="cursor-pointer text-sm">Select all on this page{selectedIds.size > 0 ? ` (${selectedIds.size} selected)` : ''}</Label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedIds.size > 0 && (
                        <Button variant="outline" size="sm" onClick={handleBulkCopy}><Copy className="mr-2 h-4 w-4" />Bulk Copy ({selectedIds.size})</Button>
                      )}
                      {selectedIds.size > 0 && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild><Button variant="destructive" size="sm" disabled={isDeleting}>{isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Delete Selected ({selectedIds.size})</Button></AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader><AlertDialogTitle>Delete selected notifications?</AlertDialogTitle><AlertDialogDescription>This permanently deletes the {selectedIds.size} selected notification(s). This action cannot be undone.</AlertDialogDescription></AlertDialogHeader>
                            <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={handleDeleteSelected}>Yes, Delete</AlertDialogAction></AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                      {hasFilter && totalNotifications > 0 && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild><Button variant="destructive" size="sm" disabled={isDeleting}>{isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Delete All in Filter ({totalNotifications})</Button></AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader><AlertDialogTitle>Delete all {totalNotifications} notifications in this filter?</AlertDialogTitle><AlertDialogDescription>This permanently deletes every individual notification matching your current filter{activeStartDate || activeEndDate ? ' (the selected IST time frame)' : ''}, including any not shown on this page. This action cannot be undone.</AlertDialogDescription></AlertDialogHeader>
                            <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={handleDeleteAllInRange}>Yes, Delete All</AlertDialogAction></AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                  {notifications.map(n => (
                    <Card key={n._id.toString()} className="flex flex-col">
                      <CardHeader className="flex flex-row justify-between items-start pb-2">
                        <div className="flex items-start gap-3">
                          <Checkbox className="mt-1" checked={selectedIds.has(n._id.toString())} onCheckedChange={(checked) => toggleSelectOne(n._id.toString(), Boolean(checked))} aria-label="Select notification" />
                          <div><CardTitle className="text-base font-mono">{n.gamingId}</CardTitle><CardDescription><FormattedDate dateString={n.createdAt as unknown as string} /></CardDescription></div>
                        </div>
                        <Badge variant={n.isRead ? "secondary" : "default"}>{n.isRead ? "Read" : "Unread"}</Badge>
                      </CardHeader>
                      <CardContent>
                        <ClickableMessage message={n.message} />
                        {n.imageUrl && <div className="mt-4 relative aspect-video w-full max-w-sm rounded-md overflow-hidden"><NotificationMedia src={n.imageUrl} alt="Notification media" /></div>}
                      </CardContent>
                      <CardFooter className="flex justify-end bg-muted/40 p-2">
                        <AlertDialog>
                          <AlertDialogTrigger asChild><Button variant="destructive" size="icon" disabled={isPending}><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader><AlertDialogTitle>Are you sure?</AlertDialogTitle><AlertDialogDescription>This will permanently delete this notification.</AlertDialogDescription></AlertDialogHeader>
                            <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => handleDelete(n._id.toString())}>Delete</AlertDialogAction></AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              )}
              {hasMore && <div className="flex justify-center pt-4"><Button onClick={handleLoadMore} disabled={isPending}>{isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Load More</Button></div>}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <BroadcastDetailsDialog broadcastId={detailsBroadcastId || ''} isOpen={!!detailsBroadcastId} onClose={() => setDetailsBroadcastId(null)} />
    </>
  );
}
