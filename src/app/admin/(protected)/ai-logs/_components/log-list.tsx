
'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Loader2, Search, Trash2, ArrowUpDown, Copy } from 'lucide-react';
import { getAiLogs, deleteAiLog, deleteAiLogs, deleteAiLogsInRange } from '@/app/actions';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { type AiLog } from '@/lib/definitions';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import Image from 'next/image';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from '@/components/ui/dialog';
import { X } from 'lucide-react';


interface LogListProps {
    initialLogs: AiLog[];
    initialHasMore: boolean;
    totalLogs: number;
}

const FormattedDate = ({ dateString }: { dateString: string }) => {
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);
    if (!mounted) return null;
    const date = new Date(dateString);
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
}

export default function LogList({ initialLogs, initialHasMore, totalLogs }: LogListProps) {
    const [logs, setLogs] = useState<AiLog[]>(initialLogs);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(initialHasMore);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [isPending, startTransition] = useTransition();
    const [isDeleting, startDeleting] = useTransition();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const [zoomedImage, setZoomedImage] = useState<string | null>(null);


    const search = searchParams.get('search') || '';
    const sort = searchParams.get('sort') || 'desc';
    const activeStartDate = searchParams.get('startDate') || '';
    const activeEndDate = searchParams.get('endDate') || '';
    const hasFilter = Boolean(search || activeStartDate || activeEndDate);

    useEffect(() => {
        setLogs(initialLogs);
        setHasMore(initialHasMore);
        setPage(1);
        setSelectedIds(new Set());
    }, [initialLogs, initialHasMore]);

    const handleLoadMore = async () => {
        startTransition(async () => {
            const nextPage = page + 1;
            const { logs: newLogs, hasMore: newHasMore } = await getAiLogs(nextPage, search, sort, activeStartDate, activeEndDate);
            setLogs(prev => [...prev, ...newLogs]);
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

    const handleSortToggle = () => {
        const newSort = sort === 'desc' ? 'asc' : 'desc';
        const params = new URLSearchParams(searchParams);
        params.set('sort', newSort);
        router.push(`${pathname}?${params.toString()}`);
    };

    const allLoadedSelected = logs.length > 0 && logs.every(log => selectedIds.has(log._id.toString()));

    const toggleSelectAll = (checked: boolean) => {
        if (checked) setSelectedIds(new Set(logs.map(log => log._id.toString())));
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
        const ids = logs.filter(log => selectedIds.has(log._id.toString())).map(log => log.gamingId);
        if (ids.length === 0) return;
        try {
            await navigator.clipboard.writeText(ids.join(','));
            toast({ title: 'Copied', description: `Copied ${ids.length} Gaming ID(s) to clipboard.` });
        } catch {
            toast({ variant: 'destructive', title: 'Error', description: 'Could not access the clipboard.' });
        }
    };

    const handleDelete = async (logId: string) => {
        startDeleting(async () => {
            const result = await deleteAiLog(logId);
            if (result.success) {
                setLogs(prev => prev.filter(log => log._id.toString() !== logId));
                setSelectedIds(prev => {
                    const next = new Set(prev);
                    next.delete(logId);
                    return next;
                });
                toast({ title: 'Success', description: result.message });
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    };

    const handleDeleteSelected = () => {
        const ids = Array.from(selectedIds);
        startDeleting(async () => {
            const result = await deleteAiLogs(ids);
            if (result.success) {
                toast({ title: 'Deleted', description: result.message });
                setLogs(prev => prev.filter(log => !selectedIds.has(log._id.toString())));
                setSelectedIds(new Set());
                router.refresh();
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    };

    const handleDeleteAllInRange = () => {
        startDeleting(async () => {
            const result = await deleteAiLogsInRange(search, activeStartDate, activeEndDate);
            if (result.success) {
                toast({ title: 'Deleted', description: result.message });
                setSelectedIds(new Set());
                router.refresh();
            } else {
                toast({ variant: 'destructive', title: 'Error', description: result.message });
            }
        });
    };

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <div className="flex flex-col gap-4">
                         <div className="flex items-center gap-2">
                           <CardTitle>AI Conversation Logs</CardTitle>
                           <Badge variant="secondary" className="text-sm">{totalLogs} Messages</Badge>
                        </div>
                        <form onSubmit={handleFilter} className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-4">
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
                                <Button type="button" variant="outline" onClick={handleSortToggle}>
                                    <ArrowUpDown className="mr-2 h-4 w-4" />
                                    {sort === 'desc' ? 'Newest First' : 'Oldest First'}
                                </Button>
                            </div>
                        </form>
                    </div>
                     <CardDescription>View the conversations users are having with the FAQ chatbot. Time frame filtering uses Indian Standard Time (IST).</CardDescription>
                </CardHeader>
                <CardContent>
                    {logs.length === 0 ? (
                        <p className="text-muted-foreground text-center py-8">No AI logs to display.</p>
                    ) : (
                       <div className="space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                                <div className="flex items-center gap-2">
                                    <Checkbox
                                        id="select-all-ai-logs"
                                        checked={allLoadedSelected}
                                        onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                                    />
                                    <Label htmlFor="select-all-ai-logs" className="cursor-pointer text-sm">
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
                                                    <AlertDialogTitle>Delete selected logs?</AlertDialogTitle>
                                                    <AlertDialogDescription>
                                                        This permanently deletes the {selectedIds.size} selected message exchange(s). This action cannot be undone.
                                                    </AlertDialogDescription>
                                                </AlertDialogHeader>
                                                <AlertDialogFooter>
                                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                    <AlertDialogAction onClick={handleDeleteSelected}>Yes, Delete</AlertDialogAction>
                                                </AlertDialogFooter>
                                            </AlertDialogContent>
                                        </AlertDialog>
                                    )}
                                    {hasFilter && totalLogs > 0 && (
                                        <AlertDialog>
                                            <AlertDialogTrigger asChild>
                                                <Button variant="destructive" size="sm" disabled={isDeleting}>
                                                    {isDeleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                                                    Delete All in Filter ({totalLogs})
                                                </Button>
                                            </AlertDialogTrigger>
                                            <AlertDialogContent>
                                                <AlertDialogHeader>
                                                    <AlertDialogTitle>Delete all {totalLogs} logs in this filter?</AlertDialogTitle>
                                                    <AlertDialogDescription>
                                                        This permanently deletes every AI log matching your current filter
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
                            {logs.map(log => (
                                <Card key={log._id.toString()} className="relative group">
                                     <CardHeader className="pb-2">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-3">
                                                <Checkbox
                                                    checked={selectedIds.has(log._id.toString())}
                                                    onCheckedChange={(checked) => toggleSelectOne(log._id.toString(), Boolean(checked))}
                                                    aria-label="Select log"
                                                />
                                                <CardTitle className="text-sm font-mono flex flex-wrap items-center gap-2">
                                                    {log.gamingId}
                                                    {log.ip && (
                                                        <a href={`/admin/ip-logger?ip=${encodeURIComponent(log.ip)}`} className="text-xs font-normal text-muted-foreground hover:underline" title="Search this IP in User Security Logs">
                                                            IP {log.ip}
                                                        </a>
                                                    )}
                                                </CardTitle>
                                            </div>
                                            <CardDescription className="text-xs">
                                                <FormattedDate dateString={log.createdAt as unknown as string} />
                                            </CardDescription>
                                        </div>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                                            <p className="font-semibold text-blue-800">User:</p>
                                            {log.mediaDataUri && (
                                                <div 
                                                    className="relative w-full aspect-square mb-2 rounded-lg overflow-hidden cursor-pointer max-w-[200px]"
                                                    onClick={() => setZoomedImage(log.mediaDataUri!)}
                                                >
                                                    <Image src={log.mediaDataUri} alt="User upload" layout="fill" className="object-cover" />
                                                </div>
                                            )}
                                            <p>{log.question}</p>
                                        </div>
                                        <div className="p-3 mt-2 rounded-lg bg-gray-50 border">
                                            <p className="font-semibold text-gray-800">Assistant:</p>
                                            <p>{log.answer}</p>
                                        </div>
                                    </CardContent>
                                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <AlertDialog>
                                            <AlertDialogTrigger asChild>
                                                <Button variant="destructive" size="icon" className="h-7 w-7">
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </AlertDialogTrigger>
                                            <AlertDialogContent>
                                                <AlertDialogHeader>
                                                    <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                                                    <AlertDialogDescription>
                                                        This action will permanently delete this message exchange. This cannot be undone.
                                                    </AlertDialogDescription>
                                                </AlertDialogHeader>
                                                <AlertDialogFooter>
                                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                                    <AlertDialogAction onClick={() => handleDelete(log._id.toString())}>
                                                        Delete
                                                    </AlertDialogAction>
                                                </AlertDialogFooter>
                                            </AlertDialogContent>
                                        </AlertDialog>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {hasMore && (
                <div className="text-center">
                    <Button onClick={handleLoadMore} disabled={isPending}>
                        {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Load More
                    </Button>
                </div>
            )}
            
            <Dialog open={!!zoomedImage} onOpenChange={() => setZoomedImage(null)}>
                <DialogContent className="max-w-3xl w-full p-0 bg-transparent border-none shadow-none" hideCloseButton={true}>
                    <DialogHeader>
                        <DialogTitle className="sr-only">Zoomed Image</DialogTitle>
                    </DialogHeader>
                    <div className="relative flex items-center justify-center">
                         <DialogClose asChild>
                            <button
                                type="button"
                                className="absolute -top-2 -right-2 z-10 rounded-full p-1.5 bg-white text-black transition-opacity hover:opacity-80 focus:outline-none"
                                aria-label="Close"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </DialogClose>
                        {zoomedImage && (
                          <Image src={zoomedImage} alt="Zoomed media" width={1200} height={800} className="max-w-full max-h-[90vh] object-contain rounded-lg" />
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
