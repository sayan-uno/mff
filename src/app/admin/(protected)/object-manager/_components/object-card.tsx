'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ObjectFile } from '@/lib/object-manager/types';
import { Copy, ExternalLink, File as FileIcon, Film, ImageOff, Link2, MoreVertical, Trash2 } from 'lucide-react';
import { formatBytes, formatDate } from './utils';

interface Props {
  file: ObjectFile;
  selected: boolean;
  /** Show the folder path under the name (used for search results). */
  showFolder?: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onCopy: (kind: 'optimized' | 'plain') => void;
  onDelete: () => void;
}

export default function ObjectCard({ file, selected, showFolder, onToggleSelect, onOpen, onCopy, onDelete }: Props) {
  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md',
        selected && 'ring-2 ring-primary'
      )}
    >
      <div
        className={cn(
          'absolute left-2 top-2 z-10 rounded bg-background/90 p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
          selected && 'opacity-100'
        )}
      >
        <Checkbox checked={selected} onCheckedChange={onToggleSelect} aria-label={`Select ${file.name}`} />
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="relative aspect-video w-full overflow-hidden bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Preview ${file.name}`}
      >
        <Thumbnail file={file} />
      </button>

      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm font-medium" title={file.key}>
          {file.name}
        </p>
        {showFolder && (
          <p className="truncate text-xs text-muted-foreground" title={file.folder || 'Root'}>
            {file.folder || 'Root'}
          </p>
        )}
        <p className="truncate text-xs text-muted-foreground">
          {formatBytes(file.size)}
          <FormattedDate iso={file.lastModified} />
        </p>
        <div className="mt-1 flex items-center gap-1">
          <Button type="button" size="sm" variant="secondary" className="h-8 flex-1" onClick={() => onCopy('optimized')}>
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy link
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="More actions">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onCopy('plain')}>
                <Link2 className="mr-2 h-4 w-4" /> Copy original link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.open(file.url, '_blank', 'noopener,noreferrer')}>
                <ExternalLink className="mr-2 h-4 w-4" /> Open in new tab
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/** Thumbnail with a fallback chain: small transformed preview → original file → icon. */
function Thumbnail({ file }: { file: ObjectFile }) {
  const [stage, setStage] = useState<'thumb' | 'full' | 'failed'>(file.thumbnailUrl ? 'thumb' : 'full');

  if (file.kind === 'video') {
    return (
      <div className="relative h-full w-full">
        <video src={file.url} muted preload="metadata" playsInline className="h-full w-full object-cover" />
        <Film className="absolute bottom-2 right-2 h-5 w-5 text-white drop-shadow" aria-hidden="true" />
      </div>
    );
  }

  if (file.kind !== 'image' || stage === 'failed') {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        {file.kind === 'image' ? <ImageOff className="h-8 w-8" /> : <FileIcon className="h-8 w-8" />}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={stage === 'thumb' ? file.thumbnailUrl! : file.url}
      alt={file.name}
      loading="lazy"
      decoding="async"
      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
      onError={() => setStage((current) => (current === 'thumb' ? 'full' : 'failed'))}
    />
  );
}

/** Rendered after mount so server and browser time zones cannot disagree. */
function FormattedDate({ iso }: { iso: string }) {
  const [text, setText] = useState('');
  useEffect(() => setText(formatDate(iso)), [iso]);
  return text ? <span> · {text}</span> : null;
}
