'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { Loader2, PackageX, BadgeCheck, RotateCcw } from 'lucide-react';
import {
  getUserFailedOrders,
  acceptRefundRequest,
  type AdminFailedOrder,
} from '@/app/actions/refund';

// --- "Refund accepted N days ago" helpers -----------------------------------
// Days are counted as calendar days in India time so the wording always agrees
// with the accepted date shown next to it (accepted yesterday at 11 pm reads
// "1 day ago", not "0 days ago").
const IST = 'Asia/Kolkata';

function istDayNumber(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const [y, m, d] = parts.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function daysAgoText(iso: string): string {
  const accepted = new Date(iso);
  if (Number.isNaN(accepted.getTime())) return '';
  const days = istDayNumber(new Date()) - istDayNumber(accepted);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function formatIstDate(iso: string, withTime = true): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit', hour12: true } : {}),
  });
}

// The note shown under an order whose refund is already running: how long ago
// it was accepted and on which date. The "re-accepting restarts the 14-day
// window" reminder lives in the hover text so the line stays short.
function RefundAcceptedNote({ acceptedAt, completeBy }: { acceptedAt?: string; completeBy?: string }) {
  const ago = acceptedAt ? daysAgoText(acceptedAt) : '';
  const date = acceptedAt ? formatIstDate(acceptedAt) : '';
  const hint = [
    date ? `Refund accepted on ${date}.` : 'Refund already in progress.',
    completeBy ? `Due to complete by ${formatIstDate(completeBy, false)}.` : '',
    'Re-accepting this order restarts the 14-day window.',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <p className="text-[11px] text-amber-600 font-medium flex items-center gap-1 mt-0.5" title={hint}>
      <RotateCcw className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {ago && date ? (
          <>
            Refund accepted {ago} · {date}
          </>
        ) : (
          'Refund already in progress'
        )}
      </span>
    </p>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  gamingId: string;
  visualGamingId?: string;
  onAccepted?: () => void;
}

export default function AcceptRefundDialog({
  open,
  onOpenChange,
  ticketId,
  gamingId,
  visualGamingId,
  onAccepted,
}: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [orders, setOrders] = useState<AdminFailedOrder[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getUserFailedOrders(gamingId);
    setOrders(data);
    setSelected({});
    setLoading(false);
  }, [gamingId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const toggle = (orderId: string) => {
    setSelected((prev) => ({ ...prev, [orderId]: !prev[orderId] }));
  };

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  const handleSubmit = async () => {
    if (selectedIds.length === 0) {
      toast({ variant: 'destructive', title: 'Nothing selected', description: 'Select at least one order.' });
      return;
    }
    setSubmitting(true);
    const result = await acceptRefundRequest(ticketId, selectedIds);
    setSubmitting(false);
    if (result.success) {
      toast({ title: 'Refund initiated', description: result.message });
      onOpenChange(false);
      onAccepted?.();
    } else {
      toast({ variant: 'destructive', title: 'Error', description: result.message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeCheck className="h-5 w-5 text-emerald-600" /> Accept Refund Request
          </DialogTitle>
          <DialogDescription>
            Select the order(s) of{' '}
            <span className="font-semibold">{visualGamingId || gamingId}</span> to refund.
            Each accepted refund completes within 14 days.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mb-2" />
            <p className="text-sm">Loading orders…</p>
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <PackageX className="h-10 w-10 mb-2 opacity-40" />
            <p className="text-sm">This user has no orders to refund.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[55vh] pr-3 -mr-3">
            <div className="space-y-2">
              {orders.map((o) => {
                const isChecked = !!selected[o.orderId];
                return (
                  <label
                    key={o.orderId}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      isChecked ? 'border-emerald-500 bg-emerald-50' : 'hover:bg-muted/50'
                    }`}
                  >
                    <Checkbox checked={isChecked} onCheckedChange={() => toggle(o.orderId)} />
                    <div className="relative h-12 w-12 shrink-0 rounded-md overflow-hidden bg-muted">
                      {o.productImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={o.productImageUrl} alt={o.productName} className="h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{o.productName}</p>
                        <span
                          className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                            o.orderStatus === 'Failed'
                              ? 'bg-red-100 text-red-700'
                              : o.orderStatus === 'Completed'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {o.orderStatus}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        ₹{o.amount} · {o.paymentMethod}
                        {o.utr ? ` · UTR ${o.utr}` : ''}
                      </p>
                      {o.alreadyRefunding && (
                        <RefundAcceptedNote acceptedAt={o.refundAcceptedAt} completeBy={o.refundCompleteBy} />
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || loading || selectedIds.length === 0}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <BadgeCheck className="h-4 w-4 mr-2" />
            )}
            Initiate Refund{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
