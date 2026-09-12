'use client';

import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ALLOWED_UPLOADS, OBJECT_MANAGER_LIMITS, extensionOf, type ObjectFile } from '@/lib/object-manager/types';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { formatBytes } from './utils';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  id: string;
  file: File;
  /** Folder the file is uploaded into (fixed when queued, so navigating away is safe). */
  folder: string;
  progress: number;
  status: UploadStatus;
  message?: string;
  result?: ObjectFile;
}

interface UploaderOptions {
  /** Returns the folder currently open in the manager. */
  getFolder: () => string;
  onUploaded: (file: ObjectFile) => void;
}

/**
 * Upload queue: validates files in the browser, uploads a few at a time with
 * progress (XMLHttpRequest, because fetch has no upload progress events), and
 * reports each finished file back so the grid can show it immediately.
 */
export function useUploader({ getFolder, onUploaded }: UploaderOptions) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]);
  const active = useRef(0);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  const getFolderRef = useRef(getFolder);
  getFolderRef.current = getFolder;

  const update = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const uploadOne = useCallback(
    (item: UploadItem) =>
      new Promise<void>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/admin/object-manager/upload');
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            update(item.id, { status: 'uploading', progress: Math.round((event.loaded / event.total) * 100) });
          }
        };
        xhr.onload = () => {
          let body: { success?: boolean; message?: string; file?: ObjectFile } = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // non-JSON response, handled below
          }
          if (xhr.status === 200 && body.success && body.file) {
            update(item.id, { status: 'done', progress: 100, result: body.file });
            onUploadedRef.current(body.file);
          } else {
            update(item.id, { status: 'error', message: body.message ?? `Upload failed (HTTP ${xhr.status}).` });
          }
          resolve();
        };
        xhr.onerror = () => {
          update(item.id, { status: 'error', message: 'Network error during upload.' });
          resolve();
        };
        const form = new FormData();
        form.append('folder', item.folder);
        form.append('file', item.file, item.file.name);
        update(item.id, { status: 'uploading', progress: 0 });
        xhr.send(form);
      }),
    [update]
  );

  const pump = useCallback(() => {
    while (active.current < OBJECT_MANAGER_LIMITS.uploadConcurrency && queue.current.length > 0) {
      const next = queue.current.shift()!;
      active.current++;
      uploadOne(next).finally(() => {
        active.current--;
        pump();
      });
    }
  }, [uploadOne]);

  const enqueue = useCallback(
    (list: FileList | File[]) => {
      const folder = getFolderRef.current();
      const fresh: UploadItem[] = Array.from(list).map((file) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const base = { id, file, folder, progress: 0 };
        const ext = extensionOf(file.name);
        if (!(ext in ALLOWED_UPLOADS)) {
          return { ...base, status: 'error', message: 'Type not allowed (png, jpg, webp, gif, avif, mp4, webm).' };
        }
        if (file.size === 0) return { ...base, status: 'error', message: 'Empty file.' };
        if (file.size > OBJECT_MANAGER_LIMITS.maxUploadBytes) {
          return { ...base, status: 'error', message: `Larger than ${formatBytes(OBJECT_MANAGER_LIMITS.maxUploadBytes)}.` };
        }
        return { ...base, status: 'queued' };
      });
      setItems((prev) => [...fresh, ...prev]);
      queue.current.push(...fresh.filter((item) => item.status === 'queued'));
      pump();
    },
    [pump]
  );

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((item) => item.status === 'queued' || item.status === 'uploading'));
  }, []);

  const busy = items.some((item) => item.status === 'queued' || item.status === 'uploading');
  return { items, enqueue, clearFinished, busy };
}

export type Uploader = ReturnType<typeof useUploader>;

export default function UploadPanel({ uploader }: { uploader: Uploader }) {
  const { items, clearFinished, busy } = uploader;
  if (items.length === 0) return null;

  const done = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'error').length;

  return (
    <div className="rounded-lg border bg-muted/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {busy ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Uploading… {done} of {items.length} done
            </span>
          ) : (
            <span>
              Uploads finished: {done} succeeded{failed > 0 ? `, ${failed} failed` : ''}
            </span>
          )}
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={clearFinished} disabled={done + failed === 0}>
          Clear finished
        </Button>
      </div>
      <ul className="max-h-56 space-y-2 overflow-y-auto pr-1">
        {items.map((item) => (
          <li key={item.id} className="rounded-md bg-background p-2 text-sm">
            <div className="flex items-center gap-2">
              <StatusIcon status={item.status} />
              <span className="min-w-0 flex-1 truncate" title={item.file.name}>
                {item.result?.name ?? item.file.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(item.file.size)}</span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">→ {item.folder || 'Root'}</span>
            </div>
            {item.status === 'uploading' && <Progress value={item.progress} className="mt-2 h-1.5" />}
            {item.status === 'error' && <p className="mt-1 text-xs text-destructive">{item.message}</p>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Names are cleaned to lowercase-with-dashes. If a name already exists the new file gets -2, -3, … so existing links never change.
      </p>
    </div>
  );
}

function StatusIcon({ status }: { status: UploadStatus }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-label="Uploaded" />;
  if (status === 'error') return <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-label="Failed" />;
  if (status === 'uploading') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-label="Uploading" />;
  return <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Queued" />;
}
