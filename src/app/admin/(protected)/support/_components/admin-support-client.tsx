'use client';

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Send,
  Loader2,
  ArrowLeft,
  Search,
  Inbox,
  CheckCheck,
  Lock,
  Unlock,
  X,
  ImagePlus,
  Trash2,
  MoreVertical,
  Ban,
  ShieldCheck,
  BadgeCheck,
  Copy,
  Paperclip,
  Image as ImageIcon,
  Film,
  FileText,
  HardDriveUpload,
  RotateCcw,
  Pencil,
  ImageOff,
  AlertTriangle,
  Mail,
  MessageSquarePlus,
} from 'lucide-react';
import AcceptRefundDialog from './accept-refund-dialog';
import AdminCreateReportDialog from './admin-create-report';
import SupportUserIdentityHeader from './support-user-identity-header';
import SupportUserOrdersSummary, { useSupportUserOrders } from './support-user-orders-summary';
import {
  getAllTicketsForAdmin,
  getTicketForAdmin,
  sendAdminReply,
  markTicketReadByAdmin,
  setTicketStatus,
  deleteTicket,
  deleteTickets,
  blockSupportUser,
  unblockSupportUser,
  getSupportBlockStatus,
} from '@/app/support/actions';
import {
  getUserUploadLimit,
  setUserUploadLimit,
  sendAdminFileMessage,
} from '@/app/support/file-actions';
import {
  adminEditMessage,
  adminDeleteMessage,
  adminDeleteMessageAttachments,
} from '@/app/support/admin-message-actions';
import {
  getBlockedGamingIds,
  setTicketEscalation,
  bulkSetEscalation,
  bulkUnblockSupportUsers,
  bulkDeleteReportAttachments,
} from '@/app/support/category-actions';
import { markTicketUnreadByAdmin } from '@/app/support/unread-actions';
import SupportCategoryBar, { type SupportCategory } from './support-category-bar';
import {
  uploadFileInChunks,
  FileAttachments,
  SystemNotice,
  isSystemMessage,
  formatBytes,
  DEFAULT_UPLOAD_LIMIT_BYTES,
  DeletedAttachmentTombstones,
} from '@/app/support/_components/support-attachments';
import type { SupportTicket, SupportMessage } from '@/lib/support-definitions';

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayLabel(dateString: string) {
  const d = new Date(dateString);
  const today = new Date();
  if (isSameDay(d, today)) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex justify-center my-2">
      <span className="text-[11px] bg-[#E1F2FB] text-gray-600 px-3 py-1 rounded-md shadow-sm">
        {dayLabel(date)}
      </span>
    </div>
  );
}

function ClosedNotice() {
  return (
    <div className="flex justify-center my-3">
      <div className="max-w-[85%] text-center bg-[#FCF4CB] text-gray-700 px-4 py-2 rounded-lg shadow-sm text-[12px] leading-relaxed">
        This chat has been closed. If you want to reopen it, just send a message again.
      </div>
    </div>
  );
}

// A photo staged for sending: the real File (uploaded to GridFS in chunks) plus
// a data-URI preview for the thumbnail strip and optimistic bubble.
type StagedPhoto = { file: File; preview: string };

// The little ⋮ control that appears on hover next to each message, giving the
// admin silent edit / delete-attachment / delete-message actions. Admin-only —
// this whole client is behind the admin gate.
function MessageAdminMenu({
  hasAttachment,
  onEdit,
  onDeleteAttachment,
  onDeleteMessage,
}: {
  hasAttachment: boolean;
  onEdit: () => void;
  onDeleteAttachment: () => void;
  onDeleteMessage: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0 self-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
          title="Message actions"
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="h-4 w-4 mr-2 text-blue-600" />
          Edit message
        </DropdownMenuItem>
        {hasAttachment && (
          <DropdownMenuItem onClick={onDeleteAttachment}>
            <ImageOff className="h-4 w-4 mr-2 text-amber-600" />
            Delete attachment
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onDeleteMessage} className="text-destructive focus:text-destructive">
          <Trash2 className="h-4 w-4 mr-2" />
          Delete message
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface Props {
  initialTickets: SupportTicket[];
}

// India Standard Time is a fixed UTC+05:30 offset. The datetime-local pickers
// give a wall-clock value with no timezone; the admin enters it in IST, so we
// pin the IST offset to get the correct UTC instant for comparison.
function istLocalToMs(local: string): number | null {
  if (!local) return null;
  const withSeconds = local.length === 16 ? `${local}:00` : local;
  const t = new Date(`${withSeconds}+05:30`).getTime();
  return isNaN(t) ? null : t;
}

// WhatsApp-style album of one or more images inside a chat bubble.
function ChatImages({
  images,
  onZoom,
  uploading = false,
  progress,
}: {
  images: { _id: string; url: string }[];
  onZoom: (url: string) => void;
  uploading?: boolean;
  progress?: { done: number; total: number } | null;
}) {
  if (!images || images.length === 0) return null;
  const isGrid = images.length > 1;
  return (
    <div
      className={`mb-1 ${isGrid ? 'grid grid-cols-2 gap-1' : ''}`}
      style={{ maxWidth: isGrid ? 260 : 240 }}
    >
      {images.map((img) => (
        <div
          key={img._id}
          className={`relative overflow-hidden rounded-md bg-black/5 ${isGrid ? 'aspect-square' : ''}`}
        >
          <button type="button" onClick={() => !uploading && onZoom(img.url)} className="block h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.url}
              alt="attachment"
              className={`${isGrid ? 'h-full w-full object-cover' : 'max-h-72 w-full object-cover rounded-md'} ${uploading ? 'blur-[1px]' : ''}`}
            />
          </button>
          {uploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
              <Loader2 className="h-7 w-7 text-white animate-spin" />
            </div>
          )}
        </div>
      ))}
      {uploading && progress && (
        <div className="col-span-2 text-[11px] text-gray-600 mt-0.5 flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Uploading {progress.done}/{progress.total}…
        </div>
      )}
    </div>
  );
}

function MessageTime({ date }: { date: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <>
      {new Date(date).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })}
    </>
  );
}

export default function AdminSupportClient({ initialTickets }: Props) {
  const { toast } = useToast();
  const [tickets, setTickets] = useState<SupportTicket[]>(initialTickets);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTicket, setActiveTicket] = useState<SupportTicket | null>(null);
  const [reply, setReply] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  // Inbox category + the set of currently-blocked gaming IDs (for the Blocked view).
  const [category, setCategory] = useState<SupportCategory>('all');
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const [isCategoryActing, setIsCategoryActing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [stagedImages, setStagedImages] = useState<StagedPhoto[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [activeBlocked, setActiveBlocked] = useState(false);
  // Orders at a glance for the open report's UID: total count (store coin
  // orders included) and the newest two orders. Fetched once per opened
  // report and shown in the green header (desktop) or just under it (phone).
  const { loading: ordersLoading, summary: orderSummary } = useSupportUserOrders(
    activeTicket ? activeTicket._id.toString() : null,
    activeTicket ? activeTicket.gamingId : null,
  );
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showRefundDialog, setShowRefundDialog] = useState(false);
  // Admin-initiated "New report" dialog (search a UID, open a report for them).
  const [showCreateReport, setShowCreateReport] = useState(false);
  // The open user's video/file upload limit (10MB default, up to 250MB granted).
  const [uploadLimitBytes, setUploadLimitBytes] = useState<number>(DEFAULT_UPLOAD_LIMIT_BYTES);
  const [isSettingLimit, setIsSettingLimit] = useState(false);
  // Progress (0..1) of an in-flight admin video/file upload.
  const [fileProgress, setFileProgress] = useState<number | null>(null);
  // Per-message admin editing / deletion state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ messageId: string; mode: 'message' | 'attachment' } | null>(null);
  const [isDeletingMsg, setIsDeletingMsg] = useState(false);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  // Reply box: auto-grows as the admin types (WhatsApp-style).
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  // Guards the poll from clobbering an in-flight optimistic send.
  const sendingRef = useRef(false);

  // Scroll only the inner messages box, never the whole admin page.
  const scrollToBottom = useCallback((smooth = true) => {
    const el = messagesContainerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    }
  }, []);

  useEffect(() => {
    if (activeTicket) {
      requestAnimationFrame(() => scrollToBottom(false));
    }
  }, [activeTicket?.messages.length, scrollToBottom]);

  // WhatsApp-style auto-growing reply box: it grows one line at a time as the
  // admin types and caps at ~7 lines, after which it scrolls internally so a
  // long reply can be reviewed (by scrolling up within the box) before sending.
  const REPLY_INPUT_MAX_HEIGHT = 160; // ~7 visible lines, then it starts scrolling
  const autoResizeReplyInput = useCallback(() => {
    const el = replyTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto'; // reset so shrinking works when text is deleted
    const next = Math.min(el.scrollHeight, REPLY_INPUT_MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > REPLY_INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);

  // Keep the box sized correctly as the value changes (typing, sending/clearing,
  // or first opening a ticket).
  useEffect(() => {
    autoResizeReplyInput();
  }, [reply, activeId, autoResizeReplyInput]);

  const refreshList = useCallback(async () => {
    const fresh = await getAllTicketsForAdmin();
    setTickets(fresh);
  }, []);

  // Keep the set of blocked gaming IDs current (drives the "Blocked" category).
  const refreshBlocked = useCallback(async () => {
    try {
      const ids = await getBlockedGamingIds();
      setBlockedIds(new Set(ids));
    } catch {
      /* leave as-is on failure */
    }
  }, []);

  useEffect(() => {
    refreshBlocked();
  }, [refreshBlocked]);

  // Poll the open ticket + the list so new user messages show up live.
  useEffect(() => {
    if (activeId) {
      pollRef.current = setInterval(async () => {
        if (sendingRef.current) return; // don't clobber an in-flight send
        const fresh = await getTicketForAdmin(activeId);
        if (sendingRef.current) return;
        if (fresh) {
          setActiveTicket(fresh);
          if (fresh.adminUnread > 0) markTicketReadByAdmin(activeId);
        }
        refreshList();
      }, 5000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeId, refreshList]);

  const openTicket = async (ticket: SupportTicket) => {
    const id = ticket._id.toString();
    setActiveId(id);
    setStagedImages([]);
    setReply('');
    const fresh = await getTicketForAdmin(id);
    setActiveTicket(fresh || ticket);
    const gid = (fresh || ticket).gamingId;
    setActiveBlocked(await getSupportBlockStatus(gid));
    getUserUploadLimit(gid).then((r) => setUploadLimitBytes(r.limitBytes)).catch(() => {});
    if ((fresh || ticket).adminUnread > 0) {
      await markTicketReadByAdmin(id);
      setTickets((prev) => prev.map((t) => (t._id.toString() === id ? { ...t, adminUnread: 0 } : t)));
    }
  };

  const handleDelete = async () => {
    if (!activeTicket) return;
    setIsDeleting(true);
    const result = await deleteTicket(activeTicket._id.toString());
    setIsDeleting(false);
    setShowDeleteDialog(false);
    if (result.success) {
      toast({ title: 'Deleted', description: result.message });
      const id = activeTicket._id.toString();
      setActiveId(null);
      setActiveTicket(null);
      setTickets((prev) => prev.filter((t) => t._id.toString() !== id));
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: result.message });
    }
  };

  const handleToggleBlock = async () => {
    if (!activeTicket) return;
    const gamingId = activeTicket.gamingId;
    if (activeBlocked) {
      const result = await unblockSupportUser(gamingId);
      if (result.success) {
        setActiveBlocked(false);
        toast({ title: 'Unblocked', description: result.message });
        refreshBlocked();
      }
    } else {
      const result = await blockSupportUser(gamingId);
      if (result.success) {
        setActiveBlocked(true);
        toast({ title: 'Blocked', description: result.message });
        refreshBlocked();
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;

    // Photos now go through GridFS (no 8MB inline cap); admins aren't size-limited
    // beyond the global 250MB ceiling enforced server-side.
    const accepted: StagedPhoto[] = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        accepted.push({ file, preview: await fileToDataUri(file) });
      } catch {
        /* ignore */
      }
    }
    if (accepted.length > 0) {
      setStagedImages((prev) => [...prev, ...accepted]);
    }
  };

  const removeStagedImage = (index: number) => {
    setStagedImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleReply = async () => {
    if (!activeTicket) return;
    const id = activeTicket._id.toString();
    const text = reply.trim();
    const imagesToSend = [...stagedImages];

    if (!text && imagesToSend.length === 0) return;

    setIsSending(true);
    sendingRef.current = true;

    // --- Send photos (if any) — uploaded to GridFS in chunks ---
    if (imagesToSend.length > 0) {
      const optimistic: SupportTicket = {
        ...activeTicket,
        messages: [
          ...activeTicket.messages,
          {
            _id: `temp-${Date.now()}` as any,
            sender: 'admin',
            text,
            images: imagesToSend.map((p, i) => ({ _id: `temp-img-${i}`, url: p.preview })),
            uploading: true,
            createdAt: new Date().toISOString() as any,
          } as SupportMessage,
        ],
        lastSenderRole: 'admin',
      };
      setActiveTicket(optimistic);
      setReply('');
      setStagedImages([]);
      setUploadProgress({ done: 0, total: imagesToSend.length });

      const uploadedIds: string[] = [];
      for (const photo of imagesToSend) {
        const up = await uploadFileInChunks(photo.file, id);
        if (up.success && up.fileId) {
          uploadedIds.push(up.fileId);
          setUploadProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
        } else {
          toast({ variant: 'destructive', title: 'Could not send photo', description: up.message || 'Upload failed.' });
          break;
        }
      }

      if (uploadedIds.length > 0) {
        await sendAdminFileMessage(id, uploadedIds, text);
      }

      const fresh = await getTicketForAdmin(id);
      if (fresh) setActiveTicket(fresh);
      setUploadProgress(null);
      refreshList();
      sendingRef.current = false;
      setIsSending(false);
      return;
    }

    // --- Text-only reply ---
    const optimistic: SupportTicket = {
      ...activeTicket,
      messages: [
        ...activeTicket.messages,
        {
          _id: `temp-${Date.now()}` as any,
          sender: 'admin',
          text,
          createdAt: new Date().toISOString() as any,
        } as SupportMessage,
      ],
      lastSenderRole: 'admin',
    };
    setActiveTicket(optimistic);
    setReply('');

    const result = await sendAdminReply(id, text);

    if (result.success) {
      const fresh = await getTicketForAdmin(id);
      if (fresh) setActiveTicket(fresh);
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: result.message });
    }
    sendingRef.current = false;
    setIsSending(false);
  };

  // Grant the open user the 250MB tier (or reset them back to 10MB). Posts the
  // "limit granted" system notice + notifies the user when granting.
  const handleSetUploadLimit = async (grant: boolean) => {
    if (!activeTicket) return;
    const id = activeTicket._id.toString();
    setIsSettingLimit(true);
    const result = await setUserUploadLimit(id, activeTicket.gamingId, grant);
    setIsSettingLimit(false);
    if (result.success) {
      toast({ title: grant ? 'Limit increased' : 'Limit reset', description: result.message });
      const r = await getUserUploadLimit(activeTicket.gamingId);
      setUploadLimitBytes(r.limitBytes);
      const fresh = await getTicketForAdmin(id);
      if (fresh) setActiveTicket(fresh);
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: result.message });
    }
  };

  // Admin sends a single video/document (no per-user cap; server caps at 250MB).
  const handleSendFile = async (file: File, kind: 'video' | 'file') => {
    if (!activeTicket) return;
    const id = activeTicket._id.toString();

    setIsSending(true);
    sendingRef.current = true;
    setFileProgress(0);

    const tempId = `temp-${Date.now()}`;
    const optimistic: SupportTicket = {
      ...activeTicket,
      messages: [
        ...activeTicket.messages,
        {
          _id: tempId as any,
          sender: 'admin',
          text: '',
          files: [{ _id: 'temp-file', filename: file.name, contentType: file.type, size: file.size, kind }],
          uploading: true,
          createdAt: new Date().toISOString() as any,
        } as SupportMessage,
      ],
      lastSenderRole: 'admin',
    };
    setActiveTicket(optimistic);

    const up = await uploadFileInChunks(file, id, (f) => setFileProgress(f));
    if (up.success && up.fileId) {
      await sendAdminFileMessage(id, [up.fileId], '');
    } else {
      toast({ variant: 'destructive', title: 'Could not send', description: up.message || 'Upload failed.' });
    }

    const fresh = await getTicketForAdmin(id);
    if (fresh) setActiveTicket(fresh);
    setFileProgress(null);
    refreshList();
    sendingRef.current = false;
    setIsSending(false);
  };

  const handleMediaSelect = async (e: React.ChangeEvent<HTMLInputElement>, kind: 'video' | 'file') => {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    await handleSendFile(file, kind);
  };

  // --- Admin per-message edit / delete ---
  const startEdit = (msg: SupportMessage) => {
    setEditingId(msg._id?.toString() || null);
    setEditingText(msg.text || '');
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditingText('');
  };
  const saveEdit = async () => {
    if (!activeTicket || !editingId) return;
    const ticketId = activeTicket._id.toString();
    setIsSavingEdit(true);
    sendingRef.current = true; // keep the 5s poll from clobbering mid-save
    const res = await adminEditMessage(ticketId, editingId, editingText);
    setIsSavingEdit(false);
    sendingRef.current = false;
    if (res.success) {
      const fresh = await getTicketForAdmin(ticketId);
      if (fresh) setActiveTicket(fresh);
      refreshList();
      cancelEdit();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: res.message });
    }
  };

  const confirmDelete = async () => {
    if (!activeTicket || !pendingDelete) return;
    const ticketId = activeTicket._id.toString();
    setIsDeletingMsg(true);
    sendingRef.current = true;
    const res =
      pendingDelete.mode === 'attachment'
        ? await adminDeleteMessageAttachments(ticketId, pendingDelete.messageId)
        : await adminDeleteMessage(ticketId, pendingDelete.messageId);
    setIsDeletingMsg(false);
    sendingRef.current = false;
    setPendingDelete(null);
    if (res.success) {
      toast({ title: 'Done', description: res.message });
      const fresh = await getTicketForAdmin(ticketId);
      if (fresh) setActiveTicket(fresh);
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: res.message });
    }
  };

  const handleToggleStatus = async () => {
    if (!activeTicket) return;
    const id = activeTicket._id.toString();
    const next = activeTicket.status === 'open' ? 'closed' : 'open';
    await setTicketStatus(id, next);
    const fresh = await getTicketForAdmin(id);
    if (fresh) setActiveTicket(fresh);
    refreshList();
  };

  const startMs = istLocalToMs(fromDate);
  const endMs = istLocalToMs(toDate);
  const hasFilter = Boolean(search || fromDate || toDate);

  // True if a report still has at least one live (non-tombstoned) attachment.
  const ticketHasAttachment = useCallback((t: SupportTicket) => {
    return (t.messages || []).some(
      (m) => (m.imageIds?.length || 0) + (m.fileIds?.length || 0) > 0
    );
  }, []);

  // Does a ticket belong to the given category? ('all' matches everything.)
  const matchesCategory = useCallback(
    (t: SupportTicket, cat: SupportCategory) => {
      switch (cat) {
        case 'unread': return (t.adminUnread || 0) > 0;
        // Read by the admin (adminUnread cleared on open) but the latest message
        // is still the user's — i.e. opened but not yet replied to.
        case 'unreplied': return (t.adminUnread || 0) === 0 && t.lastSenderRole === 'user';
        case 'escalation': return !!t.escalated;
        case 'blocked': return blockedIds.has(t.gamingId);
        case 'closed': return t.status === 'closed';
        case 'attachments': return ticketHasAttachment(t);
        default: return true;
      }
    },
    [blockedIds, ticketHasAttachment]
  );

  // Search + time-frame filter (shared by every category and the chip counts).
  const timeSearchFiltered = tickets.filter((t) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !q ||
      t.subject.toLowerCase().includes(q) ||
      t.gamingId.toLowerCase().includes(q) ||
      (t.visualGamingId || '').toLowerCase().includes(q);
    if (!matchesSearch) return false;

    // Time frame filters on when the report was created (IST).
    if (startMs !== null || endMs !== null) {
      const created = new Date(t.createdAt as unknown as string).getTime();
      if (startMs !== null && created < startMs) return false;
      if (endMs !== null && created > endMs) return false;
    }
    return true;
  });

  // The list shown for the active category (time/search already applied).
  const categoryFiltered = timeSearchFiltered.filter((t) => matchesCategory(t, category));

  // In the Unread queue, show the oldest waiting report at the top and newer
  // ones below, so the admin works the backlog FIFO (oldest-first) and replies
  // in order. Every other category keeps the default newest-first order.
  const filtered =
    category === 'unread'
      ? [...categoryFiltered].sort(
          (a, b) =>
            new Date(a.updatedAt as unknown as string).getTime() -
            new Date(b.updatedAt as unknown as string).getTime()
        )
      : categoryFiltered;

  // Live chip counts, scoped to the current time/search filter.
  const categoryCounts: Record<SupportCategory, number> = {
    all: timeSearchFiltered.length,
    unread: timeSearchFiltered.filter((t) => matchesCategory(t, 'unread')).length,
    unreplied: timeSearchFiltered.filter((t) => matchesCategory(t, 'unreplied')).length,
    escalation: timeSearchFiltered.filter((t) => matchesCategory(t, 'escalation')).length,
    blocked: timeSearchFiltered.filter((t) => matchesCategory(t, 'blocked')).length,
    closed: timeSearchFiltered.filter((t) => matchesCategory(t, 'closed')).length,
    attachments: timeSearchFiltered.filter((t) => matchesCategory(t, 'attachments')).length,
  };

  const totalUnread = tickets.reduce((sum, t) => sum + (t.adminUnread || 0), 0);

  const allFilteredSelected = filtered.length > 0 && filtered.every((t) => selectedIds.has(t._id.toString()));

  const toggleSelectAll = (checked: boolean) => {
    if (checked) setSelectedIds(new Set(filtered.map((t) => t._id.toString())));
    else setSelectedIds(new Set());
  };

  const toggleSelectOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const clearFilters = () => {
    setSearch('');
    setFromDate('');
    setToDate('');
  };

  const handleBulkCopy = async () => {
    // Copy the Gaming IDs of the selected reports, in the order shown.
    const ids = filtered
      .filter((t) => selectedIds.has(t._id.toString()))
      .map((t) => t.gamingId);
    if (ids.length === 0) return;
    try {
      await navigator.clipboard.writeText(ids.join(','));
      toast({ title: 'Copied', description: `Copied ${ids.length} Gaming ID(s) to clipboard.` });
    } catch {
      toast({ variant: 'destructive', title: 'Error', description: 'Could not access the clipboard.' });
    }
  };

  const deleteManyTickets = async (ids: string[]) => {
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    const result = await deleteTickets(ids);
    setIsBulkDeleting(false);
    if (result.success) {
      toast({ title: 'Deleted', description: result.message });
      const idSet = new Set(ids);
      setTickets((prev) => prev.filter((t) => !idSet.has(t._id.toString())));
      // If the open report was deleted, close the conversation pane.
      if (activeId && idSet.has(activeId)) {
        setActiveId(null);
        setActiveTicket(null);
      }
      setSelectedIds(new Set());
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: result.message });
    }
  };

  // The selected report ids, limited to what's actually visible in the category.
  const selectedFilteredIds = () =>
    filtered.filter((t) => selectedIds.has(t._id.toString())).map((t) => t._id.toString());

  // --- Single-report escalation toggle (3-dot menu in the open conversation) ---
  const handleToggleEscalation = async () => {
    if (!activeTicket) return;
    const id = activeTicket._id.toString();
    const next = !activeTicket.escalated;
    const result = await setTicketEscalation(id, next);
    if (result.success) {
      toast({ title: next ? 'Escalated' : 'De-escalated', description: result.message });
      const fresh = await getTicketForAdmin(id);
      if (fresh) setActiveTicket(fresh);
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: result.message });
    }
  };

  // --- Mark the open report unread again (3-dot menu) ---
  // Opening a report auto-clears its unread flag; this puts it back so a report
  // opened by mistake returns to the Unread list. We close the conversation
  // without re-reading it: the conversation pane is dismissed first (which stops
  // the 5s poll that auto-marks read), then we flag it unread on the server.
  const handleMarkUnread = async () => {
    if (!activeTicket) return;
    const id = activeTicket._id.toString();
    // Guard the in-flight poll from re-marking the ticket as read.
    sendingRef.current = true;
    setActiveId(null);
    setActiveTicket(null);
    setStagedImages([]);
    setReply('');
    const result = await markTicketUnreadByAdmin(id);
    sendingRef.current = false;
    if (result.success) {
      // Reflect it immediately in the list, then refresh from the server.
      setTickets((prev) =>
        prev.map((t) =>
          t._id.toString() === id ? { ...t, adminUnread: Math.max(1, t.adminUnread || 0) } : t
        )
      );
      toast({ title: 'Marked as unread', description: 'Moved back to the Unread list.' });
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: result.message });
    }
  };

  // --- Category bulk actions over the current selection ---
  const handleBulkRemoveEscalation = async () => {
    const ids = selectedFilteredIds();
    if (ids.length === 0) return;
    setIsCategoryActing(true);
    const res = await bulkSetEscalation(ids, false);
    setIsCategoryActing(false);
    if (res.success) {
      toast({ title: 'Done', description: res.message });
      setSelectedIds(new Set());
      refreshList();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: res.message });
    }
  };

  const handleBulkUnblock = async () => {
    const gamingIds = filtered
      .filter((t) => selectedIds.has(t._id.toString()))
      .map((t) => t.gamingId);
    if (gamingIds.length === 0) return;
    setIsCategoryActing(true);
    const res = await bulkUnblockSupportUsers(gamingIds);
    setIsCategoryActing(false);
    if (res.success) {
      toast({ title: 'Done', description: res.message });
      setSelectedIds(new Set());
      await refreshBlocked();
      if (activeTicket) setActiveBlocked(await getSupportBlockStatus(activeTicket.gamingId));
    } else {
      toast({ variant: 'destructive', title: 'Error', description: res.message });
    }
  };

  const handleBulkDeleteAttachments = async () => {
    const ids = selectedFilteredIds();
    if (ids.length === 0) return;
    setIsCategoryActing(true);
    const res = await bulkDeleteReportAttachments(ids);
    setIsCategoryActing(false);
    if (res.success) {
      toast({ title: 'Done', description: res.message });
      setSelectedIds(new Set());
      refreshList();
      if (activeId) {
        const fresh = await getTicketForAdmin(activeId);
        if (fresh) setActiveTicket(fresh);
      }
    } else {
      toast({ variant: 'destructive', title: 'Error', description: res.message });
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Inbox className="h-6 w-6" /> Support Inbox
            {totalUnread > 0 && (
              <span className="h-6 min-w-6 px-2 rounded-full bg-destructive text-destructive-foreground text-sm flex items-center justify-center">
                {totalUnread}
              </span>
            )}
          </h1>
          <p className="text-muted-foreground text-sm">User reports and live chat. Replies appear to the user instantly.</p>
        </div>
        <Button onClick={() => setShowCreateReport(true)} className="shrink-0">
          <MessageSquarePlus className="h-4 w-4 mr-2" />
          New report
        </Button>
      </div>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-[340px_1fr] h-[75vh] min-h-0">
          {/* Ticket list */}
          <div className={`border-r flex-col min-h-0 overflow-hidden ${activeId ? 'hidden md:flex' : 'flex'}`}>
            {/* Category selector — time/search filters compose with the chosen category. */}
            <SupportCategoryBar
              category={category}
              counts={categoryCounts}
              onChange={(c) => { setCategory(c); setSelectedIds(new Set()); }}
            />
            <div className="p-3 border-b space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search subject or Gaming ID"
                  className="pl-8"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="support-from" className="text-[11px] text-muted-foreground">From (IST)</Label>
                  <Input id="support-from" type="datetime-local" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 text-xs" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="support-to" className="text-[11px] text-muted-foreground">To (IST)</Label>
                  <Input id="support-to" type="datetime-local" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 text-xs" />
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="support-select-all"
                    checked={allFilteredSelected}
                    onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                  />
                  <Label htmlFor="support-select-all" className="cursor-pointer text-xs">
                    Select all{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                  </Label>
                </div>
                {hasFilter && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clearFilters}>
                    <X className="h-3.5 w-3.5 mr-1" /> Clear
                  </Button>
                )}
              </div>
              {(selectedIds.size > 0 || hasFilter) && (
                <div className="flex flex-wrap items-center gap-2">
                  {selectedIds.size > 0 && (
                    <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleBulkCopy}>
                      <Copy className="h-3.5 w-3.5 mr-1" /> Bulk Copy ({selectedIds.size})
                    </Button>
                  )}
                  {/* Category-specific bulk action (besides full delete below). */}
                  {selectedIds.size > 0 && category === 'escalation' && (
                    <Button variant="outline" size="sm" className="h-8 text-xs" disabled={isCategoryActing} onClick={handleBulkRemoveEscalation}>
                      {isCategoryActing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5 mr-1" />}
                      Remove from escalation ({selectedIds.size})
                    </Button>
                  )}
                  {selectedIds.size > 0 && category === 'blocked' && (
                    <Button variant="outline" size="sm" className="h-8 text-xs" disabled={isCategoryActing} onClick={handleBulkUnblock}>
                      {isCategoryActing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />}
                      Unblock ({selectedIds.size})
                    </Button>
                  )}
                  {selectedIds.size > 0 && category === 'attachments' && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={isCategoryActing}>
                          {isCategoryActing ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <ImageOff className="h-3.5 w-3.5 mr-1" />}
                          Delete attachments ({selectedIds.size})
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete attachments from {selectedIds.size} report(s)?</AlertDialogTitle>
                          <AlertDialogDescription>
                            The files are permanently removed from the database to free space; the reports and their
                            messages stay, with a small placeholder icon where each attachment was. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={(e) => { e.preventDefault(); handleBulkDeleteAttachments(); }}
                          >
                            Delete attachments
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {selectedIds.size > 0 && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" size="sm" className="h-8 text-xs" disabled={isBulkDeleting}>
                          {isBulkDeleting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
                          Delete ({selectedIds.size})
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete selected reports?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently deletes the {selectedIds.size} selected report(s) and their images. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={(e) => { e.preventDefault(); deleteManyTickets(Array.from(selectedIds)); }}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                  {hasFilter && filtered.length > 0 && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="destructive" size="sm" className="h-8 text-xs" disabled={isBulkDeleting}>
                          {isBulkDeleting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
                          Delete All in Filter ({filtered.length})
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete all {filtered.length} reports in this filter?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently deletes every report matching your current filter
                            {fromDate || toDate ? ' (the selected IST time frame)' : ''} and their images. This cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={(e) => { e.preventDefault(); deleteManyTickets(filtered.map((t) => t._id.toString())); }}
                          >
                            Delete All
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
              {filtered.length === 0 ? (
                <div className="text-center text-muted-foreground py-16 text-sm">No reports found.</div>
              ) : (
                filtered.map((ticket) => {
                  const id = ticket._id.toString();
                  const last = ticket.messages[ticket.messages.length - 1];
                  return (
                    <div
                      key={id}
                      className={`flex items-center gap-1 border-b ${activeId === id ? 'bg-muted' : ''}`}
                    >
                    <div className="pl-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(id)}
                        onCheckedChange={(checked) => toggleSelectOne(id, Boolean(checked))}
                        aria-label="Select report"
                      />
                    </div>
                    <button
                      onClick={() => openTicket(ticket)}
                      className="flex-1 min-w-0 text-left flex items-center gap-3 p-3 hover:bg-muted/60 transition-colors"
                    >
                      <div className="relative h-10 w-10 rounded-full bg-[#075E54] flex items-center justify-center overflow-hidden shrink-0">
                        <Image src="/img/garena.png" alt="" width={24} height={24} className="object-contain" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-semibold truncate text-sm flex items-center gap-1">
                            {ticket.escalated && (
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-orange-500" aria-label="Escalated" />
                            )}
                            {ticket.subject}
                          </span>
                          {ticket.adminUnread > 0 && (
                            <span className="shrink-0 h-5 min-w-5 px-1.5 rounded-full bg-[#25D366] text-white text-xs font-bold flex items-center justify-center">
                              {ticket.adminUnread}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {ticket.visualGamingId || ticket.gamingId}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {!last
                            ? ''
                            : (last as any).kind === 'system'
                            ? last.text
                            : `${last.sender === 'admin' ? 'You: ' : ''}${
                                last.text ||
                                (last.imageIds && last.imageIds.length > 0
                                  ? '📷 Photo'
                                  : last.fileIds && last.fileIds.length > 0
                                  ? '📎 Attachment'
                                  : '')
                              }`}
                        </p>
                      </div>
                    </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Conversation */}
          <div className={`flex-col min-h-0 overflow-hidden ${activeId ? 'flex' : 'hidden md:flex'}`}>
            {!activeTicket ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <Inbox className="h-12 w-12 mx-auto mb-2 opacity-40" />
                  <p>Select a report to view the conversation.</p>
                </div>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-center gap-3 bg-[#075E54] text-white px-3 py-2.5">
                  <button
                    onClick={() => { setActiveId(null); setActiveTicket(null); setStagedImages([]); setReply(''); }}
                    className="md:hidden p-1 -ml-1 rounded-full hover:bg-white/10"
                    aria-label="Back"
                  >
                    <ArrowLeft className="h-5 w-5" />
                  </button>
                  <div className="relative h-10 w-10 rounded-full bg-white flex items-center justify-center overflow-hidden">
                    <Image src="/img/garena.png" alt="" width={30} height={30} className="object-contain" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-[15px] truncate flex items-center gap-1.5">
                      {activeTicket.subject}
                      {activeTicket.escalated && (
                        <span className="text-[10px] font-normal bg-orange-500 text-white px-1.5 py-0.5 rounded flex items-center gap-0.5">
                          <AlertTriangle className="h-3 w-3" /> Escalated
                        </span>
                      )}
                      {activeBlocked && (
                        <span className="text-[10px] font-normal bg-red-600 text-white px-1.5 py-0.5 rounded">
                          Blocked
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-white/80 truncate">
                      {activeTicket.visualGamingId || activeTicket.gamingId} · {activeTicket.status}
                    </div>
                  </div>
                  {/* Orders at a glance (wide screens, 1440px+): fills the middle of
                      the header with the UID's order count + newest two orders. */}
                  <SupportUserOrdersSummary
                    loading={ordersLoading}
                    summary={orderSummary}
                    className="hidden min-[1440px]:flex flex-[3_1_0%] min-w-0 max-w-[560px]"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleToggleStatus}
                    className="h-8"
                  >
                    {activeTicket.status === 'open' ? (
                      <><Lock className="h-3.5 w-3.5 mr-1" /> Close</>
                    ) : (
                      <><Unlock className="h-3.5 w-3.5 mr-1" /> Reopen</>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setShowDeleteDialog(true)}
                    className="h-8"
                    title="Delete report"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-white hover:bg-white/10">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setShowRefundDialog(true)}>
                        <BadgeCheck className="h-4 w-4 mr-2 text-emerald-600" />
                        Accept refund request
                      </DropdownMenuItem>
                      {/* Mark unread: put a report opened by mistake back into the
                          Unread list, dismissing the conversation without reading it. */}
                      <DropdownMenuItem onClick={handleMarkUnread}>
                        <Mail className="h-4 w-4 mr-2 text-[#25D366]" />
                        Mark as unread
                      </DropdownMenuItem>
                      {/* Escalation: move this report to the technical-team list (or back). */}
                      <DropdownMenuItem onClick={handleToggleEscalation}>
                        <AlertTriangle className={`h-4 w-4 mr-2 ${activeTicket.escalated ? 'text-muted-foreground' : 'text-orange-600'}`} />
                        {activeTicket.escalated ? 'Remove from escalation list' : 'Move to escalation list'}
                      </DropdownMenuItem>
                      {/* Upload limit control. Shows the user's current limit and
                          lets the admin grant 250MB (or reset to the 10MB default). */}
                      {uploadLimitBytes >= 250 * 1024 * 1024 ? (
                        <DropdownMenuItem onClick={() => handleSetUploadLimit(false)} disabled={isSettingLimit}>
                          <RotateCcw className="h-4 w-4 mr-2 text-amber-600" />
                          Reset upload limit to 10 MB
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => handleSetUploadLimit(true)} disabled={isSettingLimit}>
                          <HardDriveUpload className="h-4 w-4 mr-2 text-blue-600" />
                          Increase upload limit to 250 MB
                          <span className="ml-auto pl-3 text-[10px] text-muted-foreground">
                            now {formatBytes(uploadLimitBytes)}
                          </span>
                        </DropdownMenuItem>
                      )}
                      {activeBlocked ? (
                        <DropdownMenuItem onClick={handleToggleBlock}>
                          <ShieldCheck className="h-4 w-4 mr-2 text-green-600" />
                          Unblock from support
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={handleToggleBlock} className="text-destructive focus:text-destructive">
                          <Ban className="h-4 w-4 mr-2" />
                          Block from support
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Orders at a glance (below 1440px): the header has no spare room
                    on laptops, tablets and phones, so the same block sits in a slim
                    green row directly under it, where the names fit in full. */}
                {(ordersLoading || orderSummary) && (
                  <div className="min-[1440px]:hidden bg-[#075E54] text-white px-3 pb-2 -mt-px">
                    <SupportUserOrdersSummary loading={ordersLoading} summary={orderSummary} className="flex min-w-0" />
                  </div>
                )}

                {/* Live user-identity strip: who the report's UID really is
                    (Visual / Promoted old / Promoted new / not found). Keyed by
                    ticket id so it re-resolves freshly each time a report opens. */}
                <SupportUserIdentityHeader
                  key={activeTicket._id.toString()}
                  ticketId={activeTicket._id.toString()}
                  sourceUid={activeTicket.gamingId}
                />

                {/* Messages */}
                <div
                  ref={messagesContainerRef}
                  className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-4 space-y-1.5"
                  style={{ backgroundColor: '#ECE5DD' }}
                >
                  {activeTicket.messages.map((msg, idx) => {
                    const isAdmin = msg.sender === 'admin';
                    const prev = idx > 0 ? activeTicket.messages[idx - 1] : null;
                    const showDate =
                      !prev || !isSameDay(new Date(prev.createdAt as any), new Date(msg.createdAt as any));

                    // System notices (limit requested / granted) render centered so
                    // the admin clearly sees the request — and the inbox preview/badge
                    // already flagged it as a new message.
                    if (isSystemMessage(msg)) {
                      return (
                        <Fragment key={msg._id?.toString() || idx}>
                          {showDate && <DateSeparator date={msg.createdAt as any} />}
                          <SystemNotice message={msg.text} type={(msg as any).systemType} />
                        </Fragment>
                      );
                    }
                    // Image-kind GridFS files render as a zoomable album; only
                    // videos/documents go to FileAttachments.
                    const imageFiles = (msg.files || [])
                      .filter((f) => f.kind === 'image')
                      .map((f) => ({ _id: f._id, url: `/api/support/file/${f._id}` }));
                    const docFiles = (msg.files || []).filter((f) => f.kind !== 'image');

                    // Admin per-message controls only make sense on a real, saved
                    // message (not an in-flight optimistic one).
                    const msgId = msg._id?.toString() || '';
                    const isReal = /^[a-f\d]{24}$/i.test(msgId) && !(msg as any).uploading;
                    const hasAttachment =
                      (msg.images?.length || 0) + (msg.files?.length || 0) +
                      (msg.imageIds?.length || 0) + (msg.fileIds?.length || 0) > 0;
                    const isEditing = editingId === msgId;
                    return (
                      <Fragment key={msg._id?.toString() || idx}>
                        {showDate && <DateSeparator date={msg.createdAt as any} />}
                        <div className={`group flex items-center gap-1 ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                          {isAdmin && isReal && !isEditing && (
                            <MessageAdminMenu
                              hasAttachment={hasAttachment}
                              onEdit={() => startEdit(msg)}
                              onDeleteAttachment={() => setPendingDelete({ messageId: msgId, mode: 'attachment' })}
                              onDeleteMessage={() => setPendingDelete({ messageId: msgId, mode: 'message' })}
                            />
                          )}
                          <div
                            className={`relative max-w-[75%] p-1 rounded-lg shadow-sm text-[14px] leading-snug ${
                              isAdmin ? 'bg-[#DCF8C6] rounded-tr-none' : 'bg-white rounded-tl-none'
                            }`}
                          >
                            {/* Sender label always on top, above any image */}
                            <div className="px-1.5 pt-0.5">
                              <span className={`block text-[12px] font-semibold mb-0.5 ${isAdmin ? 'text-[#075E54]' : 'text-blue-700'}`}>
                                {isAdmin ? 'You (Garena)' : (activeTicket.visualGamingId || activeTicket.gamingId)}
                              </span>
                            </div>
                            {msg.images && msg.images.length > 0 && (
                              <ChatImages
                                images={msg.images}
                                onZoom={(url) => setZoomedImage(url)}
                                uploading={(msg as any).uploading}
                                progress={(msg as any).uploading ? uploadProgress : null}
                              />
                            )}
                            {imageFiles.length > 0 && (
                              <ChatImages images={imageFiles} onZoom={(url) => setZoomedImage(url)} />
                            )}
                            {docFiles.length > 0 && (
                              <FileAttachments
                                files={docFiles}
                                uploading={(msg as any).uploading}
                                progress={(msg as any).uploading ? fileProgress : null}
                              />
                            )}
                            {msg.deletedAttachmentKinds && msg.deletedAttachmentKinds.length > 0 && (
                              <DeletedAttachmentTombstones kinds={msg.deletedAttachmentKinds} />
                            )}
                            <div className="px-1.5 pb-1">
                              {isEditing ? (
                                <div className="space-y-1.5 py-0.5">
                                  <Textarea
                                    value={editingText}
                                    onChange={(e) => setEditingText(e.target.value)}
                                    rows={2}
                                    autoFocus
                                    className="resize-none bg-white text-[14px] min-h-[40px]"
                                  />
                                  <div className="flex justify-end gap-1.5">
                                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={cancelEdit} disabled={isSavingEdit}>
                                      Cancel
                                    </Button>
                                    <Button size="sm" className="h-7 text-xs" onClick={saveEdit} disabled={isSavingEdit}>
                                      {isSavingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  {msg.html ? (
                                    // Rich, server-generated HTML bubble (e.g. refund-accepted
                                    // card). Trusted content built on the server; constrained so
                                    // it stays inside the chat bubble.
                                    <div
                                      className="max-w-full overflow-hidden [&_img]:max-w-full"
                                      dangerouslySetInnerHTML={{ __html: msg.html }}
                                    />
                                  ) : (
                                    msg.text && <span className="whitespace-pre-wrap break-words">{msg.text}</span>
                                  )}
                                  <span className="float-right ml-2 mt-1 text-[10px] text-gray-500 flex items-center gap-0.5">
                                    <MessageTime date={msg.createdAt as any} />
                                    {isAdmin &&
                                      (activeTicket.userLastReadAt &&
                                      new Date(activeTicket.userLastReadAt).getTime() >=
                                        new Date(msg.createdAt as any).getTime() ? (
                                        // The user genuinely viewed the chat after this reply → seen.
                                        <CheckCheck className="h-3 w-3 text-[#34B7F1]" />
                                      ) : (
                                        // Delivered, but the user hasn't opened it yet → grey double tick.
                                        <CheckCheck className="h-3 w-3 text-gray-400" />
                                      ))}
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          {!isAdmin && isReal && !isEditing && (
                            <MessageAdminMenu
                              hasAttachment={hasAttachment}
                              onEdit={() => startEdit(msg)}
                              onDeleteAttachment={() => setPendingDelete({ messageId: msgId, mode: 'attachment' })}
                              onDeleteMessage={() => setPendingDelete({ messageId: msgId, mode: 'message' })}
                            />
                          )}
                        </div>
                      </Fragment>
                    );
                  })}

                  {activeTicket.status === 'closed' && <ClosedNotice />}
                </div>

                {/* Staged image previews (before sending) */}
                {stagedImages.length > 0 && (
                  <div className="bg-[#F0F0F0] border-t px-2.5 pt-2.5 flex gap-2 overflow-x-auto">
                    {stagedImages.map((photo, i) => (
                      <div key={i} className="relative shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={photo.preview} alt="preview" className="h-16 w-16 object-cover rounded-md border" />
                        <button
                          onClick={() => removeStagedImage(i)}
                          className="absolute -top-1.5 -right-1.5 bg-black/70 text-white rounded-full p-0.5"
                          aria-label="Remove image"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reply bar */}
                <div className="flex items-end gap-2 bg-[#F0F0F0] px-2.5 py-2 border-t">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => handleMediaSelect(e, 'video')}
                  />
                  <input
                    ref={docInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => handleMediaSelect(e, 'file')}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Attach"
                        disabled={isSending}
                        className="h-11 w-11 rounded-full shrink-0 text-[#075E54] hover:bg-black/5"
                      >
                        <Paperclip className="h-5 w-5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" side="top" className="mb-1">
                      <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                        <ImageIcon className="h-4 w-4 mr-2 text-violet-600" />
                        Photos
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => videoInputRef.current?.click()}>
                        <Film className="h-4 w-4 mr-2 text-rose-600" />
                        Videos
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => docInputRef.current?.click()}>
                        <FileText className="h-4 w-4 mr-2 text-sky-600" />
                        Files
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Textarea
                    ref={replyTextareaRef}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Type your reply..."
                    rows={1}
                    className="flex-1 resize-none bg-white rounded-2xl px-4 py-2.5 min-h-[44px] border-0 focus-visible:ring-0 text-[14px] leading-snug shadow-sm"
                  />
                  <Button
                    onClick={handleReply}
                    disabled={isSending || (!reply.trim() && stagedImages.length === 0)}
                    size="icon"
                    className="h-11 w-11 rounded-full bg-[#075E54] hover:bg-[#0a7d6f] shrink-0"
                  >
                    {isSending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* Full-screen image viewer */}
      {zoomedImage && (
        <div
          className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setZoomedImage(null)}
        >
          <button
            className="absolute top-4 right-4 text-white p-2"
            onClick={() => setZoomedImage(null)}
            aria-label="Close"
          >
            <X className="h-7 w-7" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomedImage} alt="attachment" className="max-h-full max-w-full object-contain rounded" />
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this report?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the whole report and its images from the database. It will also
              disappear from the user&apos;s support page. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDelete(); }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Per-message delete confirmation (delete attachment vs whole message) */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.mode === 'attachment' ? 'Delete this attachment?' : 'Delete this message?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.mode === 'attachment'
                ? 'The file will be permanently removed from the database to free space. A small placeholder icon will remain in the chat so the history shows an attachment was here. This cannot be undone.'
                : 'This permanently removes the message (and any attached files) from the conversation for both you and the user. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingMsg}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmDelete(); }}
              disabled={isDeletingMsg}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeletingMsg ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Admin-initiated "New report" dialog: search a UID and open a report
          addressed to that user. Self-contained; refreshes the list and opens
          the new report once it's created. */}
      <AdminCreateReportDialog
        open={showCreateReport}
        onOpenChange={setShowCreateReport}
        onCreated={async (ticketId) => {
          await refreshList();
          const fresh = await getTicketForAdmin(ticketId);
          if (fresh) {
            setActiveId(ticketId);
            setActiveTicket(fresh);
          }
        }}
        onOpenTicket={(ticket) => { setShowCreateReport(false); openTicket(ticket); }}
      />

      {/* Accept refund request dialog */}
      {activeTicket && (
        <AcceptRefundDialog
          open={showRefundDialog}
          onOpenChange={setShowRefundDialog}
          ticketId={activeTicket._id.toString()}
          gamingId={activeTicket.gamingId}
          visualGamingId={activeTicket.visualGamingId}
          onAccepted={async () => {
            const fresh = await getTicketForAdmin(activeTicket._id.toString());
            if (fresh) setActiveTicket(fresh);
            refreshList();
          }}
        />
      )}
    </div>
  );
}
