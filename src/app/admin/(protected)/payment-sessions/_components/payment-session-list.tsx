
'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, ZapOff, CheckCircle, Trash2, Copy, X } from 'lucide-react';
import { getPaymentSessions, forceExpireLock, approvePaymentManually, deletePaymentSessions, deletePaymentSessionsInRange } from '../actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import type { PaymentLock } from '@/lib/definitions';
import { useToast } from '@/hooks/use-toast';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';


interface PaymentSessionListProps {
    initialSessions: PaymentLock[];
    initialHasMore: boolean;
    totalSessions: number;
}

const FormattedDate = ({ dateString }: { dateString: string }) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;
    const date = new Date(dateString);
    return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

function calculateDuration(start: string, end: string): string {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffMs = endDate.getTime() - startDate.getTime();
    const diffSecs = Math.round(diffMs / 1000);

    if (diffSecs < 60) {
        return `${diffSecs}s`;
    }
    const diffMins = Math.floor(diffSecs / 60);
    const remainingSecs = diffSecs % 60;
    return `${diffMins}m ${remainingSecs}s`;
}

export default function PaymentSessionList({ initialSessions, initialHasMore, totalSessions }: PaymentSessionListProps) {
    const [sessions, setSessions] = useState<PaymentLock[]>(initialSessions);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(initialHasMore);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isPending, startTransition] = useTransition();
    const [isDeleting, startDeleting] = useTransition();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { toast } = useToast();

    const search = searchParams.get('search') || '';
    const activeStartDate = searchParams.get('startDate') || '';
    const activeEndDate = searchParams.get('endDate') || '';
    const hasFilter = Boolean(search || activeStartDate || activeEndDate);

    useEffect(() => {
        setSessions(initialSessions);
        setHasMore(initialHasMore);
        setPage(1);
        setSelectedIds(new Set());
    }, [initialSessions, initialHasMore]);

    const handleLoadMore = async () => {
        startTransition(async () => {
            const nextPage = page + 1;
            const { sessions: newSessions, hasMore: newHasMore } = await getPaymentSessions(nextPage, search, activeStartDate, activeEndDate);
            setSessions(prev => [...prev, ...newSessions]);
            setHasMore(newHasMore);
            setPage(nextPage);
        });
    };

    const handleFilter = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const params = new URLSearchParams(searchParams);
        const setOrDelete = (key: string, value: string) => {
            if (value) params.set(key, value);
            else params.delete(key);
        };
        setOrDelete('search', (formData.get('search') as string)?.trim() || '');
        setOrDelete('startDate', (formData.get('startDate') as string) || '');
        setOrDelete('endDate', (formData.get('endDate') as string) || '');
        params.delete('page');
        router.push(`${pathname}?${params.toString()}`);
    };

    const handleClearFilters = () => {
        const params = new URLSearchParams(searchParams);
        params.delete('search');
        params.delete('startDate');
        params.delete('endDate');
        params.delete('page');
        router.push(`${pathname}?${params.toString()}`);
    };

    const allLoadedSelected = sessions.length > 0 && sessions.every(s => selectedIds.has(s._id.toString()));

    const toggleSelectAll = (checked: boolean) => {
        if (checked) setSelectedIds(new Set(sessions.map(s => s._id.toString())));
        else setSelectedIds(new Set());
    };

    const toggleSelectOne = (id: string, checked: boolean) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    const handleBulkCopy = async () => {
        const ids = sessions.filter(s => selectedIds.has(s._id.toString())).map(s => s.gamingId);
        if (ids.length === 0) return;
        try {
            await navigator.clipboard.writeText(ids.join(','));
            toast({ title: 'Copied', description: `Copied ${ids.length} Gaming ID(s) to clipboard.` });
        } catch {
            toast({ variant: 'destructive', title: 'Error', description: 'Could not access the clipboard.' });
        }
    };

    const handleCopyCode = async (code: string) => {
        try {
            await navigator.clipboard.writeText(code);
            toast({ title: 'Copied', description: `Pay code ${code} copied.` });
        } catch {
            toast({ variant: 'destructive', title: 'Error', description: 'Could not access the clipboard.' });
        }
    };

    const handleDeleteOne = (id: string) => {
        startDeleting(async () => {
            const result = await deletePaymentSessions([id]);
            if (result.success) {
                toast({ title: 'Deleted', description: result.message });
                setSessions(prev => prev.filter(s => s._id.toString() !== id));
                setSelectedIds(prev => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    };

    const handleDeleteSelected = () => {
        const ids = Array.from(selectedIds);
        startDeleting(async () => {
            const result = await deletePaymentSessions(ids);
            if (result.success) {
                toast({ title: 'Deleted', description: result.message });
                setSessions(prev => prev.filter(s => !selectedIds.has(s._id.toString())));
                setSelectedIds(new Set());
                router.refresh();
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    };

    const handleDeleteAllInRange = () => {
        startDeleting(async () => {
            const result = await deletePaymentSessionsInRange(search, activeStartDate, activeEndDate);
            if (result.success) {
                toast({ title: 'Deleted', description: result.message });
                setSelectedIds(new Set());
                router.refresh();
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    };

    const handleForceExpire = async (lockId: string) => {
        startTransition(async () => {
            const result = await forceExpireLock(lockId);
            if(result.success) {
                toast({ title: 'Success', description: result.message });
                setSessions(prev => prev.map(s => s._id.toString() === lockId ? {...s, status: 'expired'} : s));
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    }

    const handleManualApprove = async (lockId: string) => {
        startTransition(async () => {
            const result = await approvePaymentManually(lockId);
             if(result.success) {
                toast({ title: 'Success', description: result.message });
                setSessions(prev => prev.map(s => s._id.toString() === lockId ? {...s, status: 'completed'} : s));
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    }

    const getStatusVariant = (status: PaymentLock['status']) => {
        switch (status) {
            case 'active': return 'default';
            case 'completed': return 'default';
            case 'expired': return 'secondary';
            default: return 'outline';
        }
    }
     const getStatusClass = (status: PaymentLock['status']) => {
        switch (status) {
            case 'active': return 'bg-yellow-500';
            case 'completed': return 'bg-green-500';
            case 'expired': return 'bg-gray-500';
            default: return 'bg-gray-300';
        }
    }


    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                        <CardTitle>Payment Sessions</CardTitle>
                        <Badge variant="secondary">{totalSessions}</Badge>
                    </div>
                    <form onSubmit={handleFilter} className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="search">Search</Label>
                                <Input id="search" name="search" placeholder="Gaming ID, Product or Pay code..." defaultValue={search} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="startDate">Created from (IST)</Label>
                                <Input id="startDate" name="startDate" type="datetime-local" defaultValue={activeStartDate} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="endDate">Created to (IST)</Label>
                                <Input id="endDate" name="endDate" type="datetime-local" defaultValue={activeEndDate} />
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button type="submit" variant="outline">
                                <Search className="mr-2 h-4 w-4" />
                                Apply Filter
                            </Button>
                            {hasFilter && (
                                <Button type="button" variant="ghost" onClick={handleClearFilters}>
                                    <X className="mr-2 h-4 w-4" />
                                    Clear
                                </Button>
                            )}
                        </div>
                    </form>
                </div>
                <CardDescription>
                    A log of every time a user has opened the payment QR code screen. You can manually approve payments here if needed. Time frame filtering uses Indian Standard Time (IST).
                </CardDescription>
            </CardHeader>
            <CardContent>
                {sessions.length === 0 ? (
                    <p className="text-muted-foreground text-center py-8">No payment sessions found.</p>
                ) : (
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                            <div className="flex items-center gap-2">
                                <Checkbox
                                    id="select-all-sessions"
                                    checked={allLoadedSelected}
                                    onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                                />
                                <Label htmlFor="select-all-sessions" className="cursor-pointer text-sm">
                                    Select all on this page
                                    {selectedIds.size > 0 ? ` (${selectedIds.size} selected)` : ''}
                                </Label>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {selectedIds.size > 0 && (
                                    <Button variant="outline" size="sm" onClick={handleBulkCopy}>
                                        <Copy className="mr-2 h-4 w-4" />
                                        Bulk Copy ({selectedIds.size})
                                    </Button>
                                )}
                                {selectedIds.size > 0 && (
                                    <AlertDialog>
                                        <AlertDialogTrigger asChild>
                                            <Button variant="destructive" size="sm" disabled={isDeleting}>
                                                {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                                                Delete Selected ({selectedIds.size})
                                            </Button>
                                        </AlertDialogTrigger>
                                        <AlertDialogContent>
                                            <AlertDialogHeader>
                                                <AlertDialogTitle>Delete selected sessions?</AlertDialogTitle>
                                                <AlertDialogDescription>
                                                    This permanently deletes the {selectedIds.size} selected payment session record(s). This action cannot be undone.
                                                </AlertDialogDescription>
                                            </AlertDialogHeader>
                                            <AlertDialogFooter>
                                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                <AlertDialogAction onClick={handleDeleteSelected}>Yes, Delete</AlertDialogAction>
                                            </AlertDialogFooter>
                                        </AlertDialogContent>
                                    </AlertDialog>
                                )}
                                {hasFilter && totalSessions > 0 && (
                                    <AlertDialog>
                                        <AlertDialogTrigger asChild>
                                            <Button variant="destructive" size="sm" disabled={isDeleting}>
                                                {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                                                Delete All in Filter ({totalSessions})
                                            </Button>
                                        </AlertDialogTrigger>
                                        <AlertDialogContent>
                                            <AlertDialogHeader>
                                                <AlertDialogTitle>Delete all {totalSessions} sessions in this filter?</AlertDialogTitle>
                                                <AlertDialogDescription>
                                                    This permanently deletes every payment session matching your current filter
                                                    {activeStartDate || activeEndDate ? ' (the selected IST time frame)' : ''}, including any not shown on this page. This action cannot be undone.
                                                </AlertDialogDescription>
                                            </AlertDialogHeader>
                                            <AlertDialogFooter>
                                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                <AlertDialogAction onClick={handleDeleteAllInRange}>Yes, Delete All</AlertDialogAction>
                                            </AlertDialogFooter>
                                        </AlertDialogContent>
                                    </AlertDialog>
                                )}
                            </div>
                        </div>
                        {sessions.map(session => (
                            <div key={session._id.toString()} className="border p-4 rounded-lg space-y-2">
                                <div className="flex justify-between items-start">
                                    <div className="flex items-start gap-3">
                                        <Checkbox
                                            className="mt-1"
                                            checked={selectedIds.has(session._id.toString())}
                                            onCheckedChange={(checked) => toggleSelectOne(session._id.toString(), Boolean(checked))}
                                            aria-label="Select session"
                                        />
                                        <div className="space-y-1">
                                            <p className="font-semibold">{session.productName}</p>
                                            <p className="text-sm font-mono text-muted-foreground">{session.gamingId}</p>
                                            {/* Pay code: leads the UPI note, so it is what the admin sees in
                                                their own UPI app for this payment. Click to copy. */}
                                            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                                                Pay code:
                                                {session.payCode ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleCopyCode(session.payCode as string)}
                                                        className="inline-flex items-center gap-1 font-mono font-semibold tracking-widest text-foreground hover:underline"
                                                        title={`UPI note: ${session.upiNote || session.payCode} (click to copy the code)`}
                                                    >
                                                        {session.payCode}
                                                        <Copy className="h-3 w-3 opacity-60" />
                                                    </button>
                                                ) : (
                                                    <span title="This session was created before pay codes existed">—</span>
                                                )}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {session.status !== 'completed' && (
                                            <Button 
                                                variant="outline" 
                                                size="sm" 
                                                disabled={isPending}
                                                onClick={() => handleManualApprove(session._id.toString())}
                                            >
                                                <CheckCircle className="mr-2 h-4 w-4"/>
                                                Approve Payment
                                            </Button>
                                        )}
                                         {session.status === 'active' && (
                                            <AlertDialog>
                                                <AlertDialogTrigger asChild>
                                                     <Button variant="destructive" size="sm" disabled={isPending}>
                                                        <ZapOff className="mr-2 h-4 w-4"/>
                                                        Force Expire
                                                    </Button>
                                                </AlertDialogTrigger>
                                                <AlertDialogContent>
                                                    <AlertDialogHeader>
                                                        <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                                                        <AlertDialogDescription>
                                                            This will manually expire the payment session for {session.gamingId}. This cannot be undone.
                                                        </AlertDialogDescription>
                                                    </AlertDialogHeader>
                                                    <AlertDialogFooter>
                                                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                        <AlertDialogAction onClick={() => handleForceExpire(session._id.toString())}>
                                                            Confirm
                                                        </AlertDialogAction>
                                                    </AlertDialogFooter>
                                                </AlertDialogContent>
                                            </AlertDialog>
                                         )}
                                         <Badge variant={getStatusVariant(session.status)} className={getStatusClass(session.status)}>
                                            {session.status}
                                        </Badge>
                                        <AlertDialog>
                                            <AlertDialogTrigger asChild>
                                                <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" disabled={isDeleting}>
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </AlertDialogTrigger>
                                            <AlertDialogContent>
                                                <AlertDialogHeader>
                                                    <AlertDialogTitle>Delete this session?</AlertDialogTitle>
                                                    <AlertDialogDescription>
                                                        This permanently deletes the payment session record for {session.gamingId} ({session.productName}). This action cannot be undone.
                                                    </AlertDialogDescription>
                                                </AlertDialogHeader>
                                                <AlertDialogFooter>
                                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                    <AlertDialogAction onClick={() => handleDeleteOne(session._id.toString())}>Yes, Delete</AlertDialogAction>
                                                </AlertDialogFooter>
                                            </AlertDialogContent>
                                        </AlertDialog>
                                    </div>
                                </div>
                                <div className="text-sm text-muted-foreground flex justify-between items-center border-t pt-2">
                                    <p>Amount: <span className="font-bold font-sans text-foreground">₹{session.amount.toFixed(2)}</span></p>
                                    <p>Duration: <span className="font-semibold text-foreground">{calculateDuration(String(session.createdAt), String(session.expiresAt))}</span></p>
                                    <p>Created: <FormattedDate dateString={String(session.createdAt)} /></p>
                                    <p>Expires: <FormattedDate dateString={String(session.expiresAt)} /></p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
             {hasMore && (
                <CardFooter className="justify-center">
                    <Button onClick={handleLoadMore} disabled={isPending}>
                        {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Load More
                    </Button>
                </CardFooter>
            )}
        </Card>
    );
}
