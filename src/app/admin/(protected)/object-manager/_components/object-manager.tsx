'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  ALLOWED_UPLOAD_ACCEPT,
  OBJECT_MANAGER_LIMITS,
  sanitizeFolderName,
  type ListResult,
  type ObjectFile,
  type ObjectFolder,
} from '@/lib/object-manager/types';
import { createFolder, deleteFolder, deleteObjects, listObjects, searchObjects } from '../actions';
import ObjectCard from './object-card';
import UploadPanel, { useUploader } from './upload-panel';
import { breadcrumbsFor, copyText, formatBytes, formatDate, shortenUrl } from './utils';
import {
  ChevronRight,
  CloudUpload,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  Loader2,
  MoreVertical,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

type SortMode = 'newest' | 'oldest' | 'name' | 'largest';

interface Props {
  initial: ListResult;
  bucket: string;
  publicBaseUrl: string;
  imageTransform: string;
}

export default function ObjectManager({ initial, bucket, publicBaseUrl, imageTransform }: Props) {
  const { toast } = useToast();

  // ----- listing state -----
  const [prefix, setPrefix] = useState(initial.prefix);
  const [folders, setFolders] = useState<ObjectFolder[]>(initial.folders);
  const [files, setFiles] = useState<ObjectFile[]>(initial.files);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestId = useRef(0);
  const prefixRef = useRef(prefix);
  useEffect(() => {
    prefixRef.current = prefix;
  }, [prefix]);

  // ----- search / sort / selection -----
  const [query, setQuery] = useState('');
  const [searchFiles, setSearchFiles] = useState<ObjectFile[] | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<SortMode>('newest');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // ----- dialogs -----
  const [preview, setPreview] = useState<ObjectFile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ObjectFile[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  // ----- uploads -----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const handleUploaded = useCallback((file: ObjectFile) => {
    if (file.folder !== prefixRef.current) return;
    setFiles((prev) => [file, ...prev.filter((f) => f.key !== file.key)]);
  }, []);
  const getFolder = useCallback(() => prefixRef.current, []);
  const uploader = useUploader({ getFolder, onUploaded: handleUploaded });

  // ---------------------------------------------------------------------------
  // Navigation and loading
  // ---------------------------------------------------------------------------

  const navigate = useCallback(
    async (target: string) => {
      const id = ++requestId.current;
      setLoading(true);
      setQuery('');
      setSearchFiles(null);
      setSelected(new Set());
      const res = await listObjects({ prefix: target });
      if (id !== requestId.current) return;
      if (res.success) {
        setPrefix(res.data.prefix);
        setFolders(res.data.folders);
        setFiles(res.data.files);
        setCursor(res.data.nextCursor);
      } else {
        toast({ variant: 'destructive', title: 'Could not open folder', description: res.message });
      }
      setLoading(false);
    },
    [toast]
  );

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const res = await listObjects({ prefix, cursor });
    if (res.success) {
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.key));
        return [...prev, ...res.data.files.filter((f) => !seen.has(f.key))];
      });
      setCursor(res.data.nextCursor);
    } else {
      toast({ variant: 'destructive', title: 'Could not load more', description: res.message });
    }
    setLoadingMore(false);
  };

  // Debounced search within the current folder (including sub-folders).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchFiles(null);
      setSearchTruncated(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      const res = await searchObjects({ prefix, query: q });
      if (id !== requestId.current) return;
      if (res.success) {
        setSearchFiles(res.data.files);
        setSearchTruncated(res.data.truncated);
      } else {
        setSearchFiles([]);
        toast({ variant: 'destructive', title: 'Search failed', description: res.message });
      }
      setSearching(false);
    }, 350);
    return () => clearTimeout(timer);
  }, [query, prefix, toast]);

  const visibleFiles = useMemo(() => {
    const list = [...(searchFiles ?? files)];
    switch (sort) {
      case 'newest':
        list.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
        break;
      case 'oldest':
        list.sort((a, b) => a.lastModified.localeCompare(b.lastModified));
        break;
      case 'name':
        list.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'largest':
        list.sort((a, b) => b.size - a.size);
        break;
    }
    return list;
  }, [files, searchFiles, sort]);

  const isSearching = searchFiles !== null;
  const crumbs = breadcrumbsFor(prefix);

  // ---------------------------------------------------------------------------
  // Selection and clipboard
  // ---------------------------------------------------------------------------

  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allSelected = visibleFiles.length > 0 && visibleFiles.every((f) => selected.has(f.key));
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(visibleFiles.map((f) => f.key)));
  const selectedFiles = visibleFiles.filter((f) => selected.has(f.key));

  const copyLink = async (file: ObjectFile, kind: 'optimized' | 'plain') => {
    const text = kind === 'optimized' ? file.optimizedUrl : file.url;
    const ok = await copyText(text);
    toast(
      ok
        ? { title: kind === 'optimized' ? 'Link copied' : 'Original link copied', description: shortenUrl(text) }
        : { variant: 'destructive', title: 'Copy failed', description: 'Your browser blocked clipboard access. Open the preview and copy manually.' }
    );
  };

  const copySelected = async (kind: 'optimized' | 'plain') => {
    if (selectedFiles.length === 0) return;
    const ok = await copyText(selectedFiles.map((f) => (kind === 'optimized' ? f.optimizedUrl : f.url)).join('\n'));
    toast(
      ok
        ? { title: `${selectedFiles.length} link${selectedFiles.length === 1 ? '' : 's'} copied`, description: 'One link per line.' }
        : { variant: 'destructive', title: 'Copy failed', description: 'Your browser blocked clipboard access.' }
    );
  };

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  const confirmDelete = async () => {
    if (!pendingDelete || pendingDelete.length === 0) return;
    setDeleting(true);
    const res = await deleteObjects(pendingDelete.map((f) => f.key));
    setDeleting(false);
    if (!res.success) {
      toast({ variant: 'destructive', title: 'Delete failed', description: res.message });
      return;
    }
    const gone = new Set(res.data.deleted);
    setFiles((prev) => prev.filter((f) => !gone.has(f.key)));
    setSearchFiles((prev) => (prev ? prev.filter((f) => !gone.has(f.key)) : prev));
    setSelected((prev) => new Set(Array.from(prev).filter((key) => !gone.has(key))));
    if (preview && gone.has(preview.key)) setPreview(null);
    setPendingDelete(null);
    if (res.data.failed.length > 0) {
      toast({ variant: 'destructive', title: `${res.data.failed.length} file(s) could not be deleted`, description: `${gone.size} deleted.` });
    } else {
      toast({ title: `${gone.size} file${gone.size === 1 ? '' : 's'} deleted` });
    }
  };

  const removeFolder = async (folder: ObjectFolder) => {
    const res = await deleteFolder(folder.prefix);
    if (res.success) {
      setFolders((prev) => prev.filter((f) => f.prefix !== folder.prefix));
      toast({ title: `Folder "${folder.name}" deleted` });
    } else {
      toast({ variant: 'destructive', title: 'Cannot delete folder', description: res.message });
    }
  };

  // ---------------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------------

  const cleanFolderName = sanitizeFolderName(folderName);
  const submitFolder = async () => {
    if (!cleanFolderName || creatingFolder) return;
    setCreatingFolder(true);
    const res = await createFolder({ prefix, name: cleanFolderName });
    setCreatingFolder(false);
    if (res.success) {
      setFolderDialog(false);
      setFolderName('');
      toast({ title: `Folder "${res.data.name}" created` });
      await navigate(res.data.prefix);
    } else {
      toast({ variant: 'destructive', title: 'Could not create folder', description: res.message });
    }
  };

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragDepth((d) => d + 1);
  };
  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragDepth((d) => Math.max(0, d - 1));
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragDepth(0);
    uploader.enqueue(event.dataTransfer.files);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="relative space-y-6" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5" /> Object Manager
            </CardTitle>
            <CardDescription>
              Bucket <span className="font-mono">{bucket}</span> served at <span className="font-mono">{publicBaseUrl}</span>. Copied links use{' '}
              <span className="font-mono">/cdn-cgi/image/{imageTransform}/</span> so Cloudflare serves AVIF or WebP per browser.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setFolderDialog(true)}>
              <FolderPlus className="mr-2 h-4 w-4" /> New folder
            </Button>
            <Button type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" /> Upload
            </Button>
            <Button type="button" variant="ghost" size="icon" onClick={() => navigate(prefix)} disabled={loading} aria-label="Refresh">
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Breadcrumbs + sort */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
              {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                  <span key={crumb.prefix} className="flex items-center gap-1">
                    {index > 0 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    {last ? (
                      <span className="font-semibold">{crumb.name}</span>
                    ) : (
                      <button type="button" className="text-muted-foreground hover:text-foreground hover:underline" onClick={() => navigate(crumb.prefix)}>
                        {crumb.name}
                      </button>
                    )}
                  </span>
                );
              })}
            </nav>
            <Select value={sort} onValueChange={(value) => setSort(value as SortMode)}>
              <SelectTrigger className="w-40" aria-label="Sort files">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                <SelectItem value="oldest">Oldest first</SelectItem>
                <SelectItem value="name">Name A → Z</SelectItem>
                <SelectItem value="largest">Largest first</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={prefix ? `Search in ${prefix} (includes sub-folders)…` : 'Search the whole bucket by file name…'}
              className="pl-9 pr-9"
              aria-label="Search files"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {isSearching && (
            <p className="text-xs text-muted-foreground">
              {searching ? 'Searching…' : `${visibleFiles.length} result${visibleFiles.length === 1 ? '' : 's'} for "${query.trim()}"`}
              {searchTruncated && ' (stopped early: narrow the search or open a folder first)'}
            </p>
          )}

          {/* Selection bar */}
          {visibleFiles.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} aria-label="Select all shown files" />
                <span>{selected.size > 0 ? `${selectedFiles.length} selected` : 'Select all'}</span>
              </label>
              {selectedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => copySelected('optimized')}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy {selectedFiles.length} link{selectedFiles.length === 1 ? '' : 's'}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => copySelected('plain')}>
                    <Link2 className="mr-1.5 h-3.5 w-3.5" /> Copy original links
                  </Button>
                  <Button type="button" size="sm" variant="destructive" onClick={() => setPendingDelete(selectedFiles)}>
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                </div>
              )}
            </div>
          )}

          <UploadPanel uploader={uploader} />

          {/* Folders */}
          {!isSearching && folders.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Folders</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {folders.map((folder) => (
                  <div key={folder.prefix} className="group flex items-center gap-1 rounded-lg border bg-card px-2 py-2 hover:bg-accent">
                    <button
                      type="button"
                      onClick={() => navigate(folder.prefix)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      title={folder.prefix}
                    >
                      <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                      <span className="truncate text-sm font-medium">{folder.name}</span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Actions for ${folder.name}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate(folder.prefix)}>
                          <FolderOpen className="mr-2 h-4 w-4" /> Open
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => removeFolder(folder)}>
                          <Trash2 className="mr-2 h-4 w-4" /> Delete empty folder
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files */}
          <div>
            {!isSearching && (
              <div className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Files {files.length > 0 && <Badge variant="secondary">{files.length}{cursor ? '+' : ''}</Badge>}
              </div>
            )}
            {loading ? (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                {Array.from({ length: 12 }, (_, i) => (
                  <Skeleton key={i} className="aspect-[16/14] rounded-lg" />
                ))}
              </div>
            ) : visibleFiles.length === 0 ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center text-muted-foreground hover:border-primary hover:text-foreground"
              >
                <CloudUpload className="h-8 w-8" />
                <span className="text-sm font-medium">{isSearching ? 'No files match your search' : 'No files in this folder yet'}</span>
                <span className="text-xs">Drag images or videos anywhere on this page, or click to choose files.</span>
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
                {visibleFiles.map((file) => (
                  <ObjectCard
                    key={file.key}
                    file={file}
                    selected={selected.has(file.key)}
                    showFolder={isSearching}
                    onToggleSelect={() => toggleSelect(file.key)}
                    onOpen={() => setPreview(file)}
                    onCopy={(kind) => copyLink(file, kind)}
                    onDelete={() => setPendingDelete([file])}
                  />
                ))}
              </div>
            )}
            {!isSearching && cursor && !loading && (
              <div className="mt-4 flex justify-center">
                <Button type="button" variant="outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Load more
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Drop overlay */}
      {dragDepth > 0 && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-[1px]">
          <div className="rounded-xl border-2 border-dashed border-primary bg-background px-8 py-6 text-center shadow-lg">
            <CloudUpload className="mx-auto mb-2 h-10 w-10 text-primary" />
            <p className="font-semibold">Drop to upload</p>
            <p className="text-sm text-muted-foreground">into {prefix || 'Root'}</p>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ALLOWED_UPLOAD_ACCEPT}
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) uploader.enqueue(event.target.files);
          event.target.value = '';
        }}
      />

      {/* New folder */}
      <Dialog open={folderDialog} onOpenChange={(open) => !creatingFolder && setFolderDialog(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Created inside {prefix || 'Root'}. Lowercase letters, numbers and dashes are kept.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-folder-name">Folder name</Label>
            <Input
              id="new-folder-name"
              autoFocus
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && submitFolder()}
              placeholder="e.g. products"
            />
            <p className="text-xs text-muted-foreground">
              {cleanFolderName ? `Will be created as ${prefix}${cleanFolderName}/` : 'Enter a name containing letters or numbers.'}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setFolderDialog(false)} disabled={creatingFolder}>
              Cancel
            </Button>
            <Button type="button" onClick={submitFolder} disabled={!cleanFolderName || creatingFolder}>
              {creatingFolder && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview */}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle className="truncate pr-6" title={preview.key}>
                  {preview.name}
                </DialogTitle>
                <DialogDescription>
                  {preview.folder || 'Root'} · {formatBytes(preview.size)} · {formatDate(preview.lastModified)}
                </DialogDescription>
              </DialogHeader>
              <div className="flex max-h-[55vh] items-center justify-center overflow-hidden rounded-md bg-muted">
                {preview.kind === 'video' ? (
                  <video src={preview.url} controls playsInline className="max-h-[55vh] max-w-full" />
                ) : preview.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview.optimizedUrl} alt={preview.name} className="max-h-[55vh] max-w-full object-contain" />
                ) : (
                  <p className="p-10 text-sm text-muted-foreground">No preview for this file type.</p>
                )}
              </div>
              {preview.kind === 'image' && (
                <div className="flex flex-wrap items-start gap-6 rounded-md border bg-muted/30 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Product card: 16:9, shown scaled to fit (edges outside the box are trimmed)</p>
                    <div className="relative aspect-video w-full max-w-sm overflow-hidden rounded-md border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview.optimizedUrl} alt="" className="h-full w-full object-cover" />
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Purchase popup: real size 96×96</p>
                    <div className="h-24 w-24 overflow-hidden rounded-md border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview.optimizedUrl} alt="" className="h-full w-full object-cover" />
                    </div>
                  </div>
                  <div className="w-full">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Home slider on desktop: real size 1232×250, shown scaled down to fit (top and bottom trimmed)</p>
                    <div className="relative aspect-[1232/250] w-full overflow-hidden rounded-md border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview.optimizedUrl} alt="" className="h-full w-full object-cover" />
                    </div>
                  </div>
                  <div className="w-full">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Home slider on phone: real size 328×180 (sides trimmed)</p>
                    <div className="relative aspect-[328/180] w-full max-w-[328px] overflow-hidden rounded-md border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={preview.optimizedUrl} alt="" className="h-full w-full object-cover" />
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-3">
                <LinkRow label={preview.kind === 'image' ? 'Optimized link (use this in admin forms)' : 'Link'} value={preview.optimizedUrl} onCopy={() => copyLink(preview, 'optimized')} />
                {preview.kind === 'image' && <LinkRow label="Original file link" value={preview.url} onCopy={() => copyLink(preview, 'plain')} />}
              </div>
              <DialogFooter className="gap-2 sm:justify-between">
                <Button type="button" variant="destructive" onClick={() => setPendingDelete([preview])}>
                  <Trash2 className="mr-2 h-4 w-4" /> Delete
                </Button>
                <Button type="button" onClick={() => copyLink(preview, 'optimized')}>
                  <Copy className="mr-2 h-4 w-4" /> Copy link
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && !deleting && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.length === 1 ? `"${pendingDelete[0].name}"` : `${pendingDelete?.length ?? 0} files`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The file is removed from the bucket permanently. Any product, slider or event still using its link will show a placeholder. Copies cached by
              Cloudflare or browsers may stay visible for a while.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LinkRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} onFocus={(event) => event.target.select()} className="font-mono text-xs" />
        <Button type="button" size="icon" variant="outline" onClick={onCopy} aria-label={`Copy ${label}`}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
