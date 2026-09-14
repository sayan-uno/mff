'use client';

// --- Support Inbox: orders at a glance ---
// Fills the (previously blank) middle of the green conversation header with a
// first impression of the customer: how many orders the report's UID has (store
// coin orders included, broken down by status) and the newest two orders by
// name. On phones the header has no spare room, so the same block is rendered
// as a slim green row directly under the header instead.
//
// Purely additive: it reads through the new admin-only order-summary action and
// never touches any existing support behaviour. One fetch per opened report is
// shared by both the desktop and the phone placement via `useSupportUserOrders`.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, ShoppingBag, ExternalLink } from 'lucide-react';
import { getSupportUserOrderSummary } from '../order-actions';
import type { SupportRecentOrder, SupportUserOrderSummary } from '@/lib/support-orders-types';

export interface SupportUserOrdersState {
    loading: boolean;
    summary: SupportUserOrderSummary | null;
}

/**
 * Loads the order summary for the open report. Re-runs whenever a different
 * report is opened or the ticket's UID changes underneath it (e.g. after a
 * promotion), so the numbers are always the live ones.
 */
export function useSupportUserOrders(ticketId: string | null, sourceUid: string | null): SupportUserOrdersState {
    const [state, setState] = useState<SupportUserOrdersState>({ loading: false, summary: null });

    useEffect(() => {
        const uid = (sourceUid || '').trim();
        if (!ticketId || !uid) {
            setState({ loading: false, summary: null });
            return;
        }
        let cancelled = false;
        setState({ loading: true, summary: null });
        getSupportUserOrderSummary(uid)
            .then((result) => {
                if (!cancelled) setState({ loading: false, summary: result });
            })
            .catch(() => {
                if (!cancelled) {
                    setState({
                        loading: false,
                        summary: {
                            sourceUid: uid,
                            totalOrders: 0,
                            completed: 0,
                            processing: 0,
                            pending: 0,
                            failed: 0,
                            coinOrders: 0,
                            latestOrders: [],
                            unavailable: true,
                        },
                    });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [ticketId, sourceUid]);

    return state;
}

// Status dot colour on the green header background.
function statusDotClass(status: string): string {
    switch (status) {
        case 'Completed':
            return 'bg-[#25D366]';
        case 'Processing':
        case 'Pending':
            return 'bg-amber-400';
        case 'Failed':
            return 'bg-red-400';
        default:
            return 'bg-white/50';
    }
}

function formatPrice(value: number): string {
    if (!Number.isFinite(value)) return '₹0';
    return Number.isInteger(value) ? `₹${value}` : `₹${value.toFixed(2)}`;
}

function formatFullDate(iso: string): string {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

function timeAgo(iso: string): string {
    if (!iso) return '';
    const date = new Date(iso);
    const diff = Date.now() - date.getTime();
    if (!Number.isFinite(diff)) return '';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}

function breakdownText(summary: SupportUserOrderSummary): string {
    const parts: string[] = [`${summary.completed} completed`];
    if (summary.processing > 0) parts.push(`${summary.processing} processing`);
    if (summary.pending > 0) parts.push(`${summary.pending} pending`);
    if (summary.failed > 0) parts.push(`${summary.failed} failed`);
    if (summary.coinOrders > 0) parts.push(`incl. ${summary.coinOrders} coin`);
    return parts.join(' · ');
}

function RecentOrderRow({ order }: { order: SupportRecentOrder }) {
    const fullDate = formatFullDate(order.createdAt);
    const tooltip = [order.productName, order.status, formatPrice(order.finalPrice), order.paymentMethod, fullDate]
        .filter(Boolean)
        .join(' · ');
    return (
        <div className="flex items-center gap-1.5 min-w-0 text-[11px] leading-[15px]" title={tooltip}>
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDotClass(order.status)}`} aria-hidden="true" />
            <span className="truncate font-medium">{order.productName}</span>
            {order.isCoinProduct && (
                <span className="shrink-0 rounded bg-white/15 px-1 text-[9px] font-semibold uppercase tracking-wide">coin</span>
            )}
            <span className="shrink-0 text-white/75">{formatPrice(order.finalPrice)}</span>
            <span className="shrink-0 text-white/60">
                · {order.status || 'Unknown'}
                {order.createdAt ? ` · ${timeAgo(order.createdAt)}` : ''}
            </span>
        </div>
    );
}

interface Props extends SupportUserOrdersState {
    // Layout classes for the placement (e.g. `hidden md:flex flex-1 min-w-0`).
    className?: string;
}

/**
 * Presentational block. Designed for the green (#075E54) header: white text,
 * two short lines high so the header keeps its current height.
 */
export default function SupportUserOrdersSummary({ loading, summary, className = '' }: Props) {
    if (loading) {
        return (
            <div className={`items-center gap-1.5 text-[11px] text-white/70 ${className}`}>
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                Loading orders…
            </div>
        );
    }

    if (!summary) return null;

    if (summary.unavailable) {
        return (
            <div className={`items-center gap-1.5 text-[11px] text-white/70 ${className}`}>
                <ShoppingBag className="h-3.5 w-3.5 shrink-0" />
                Orders: unavailable
            </div>
        );
    }

    const hasOrders = summary.totalOrders > 0;
    const allOrdersHref = `/admin/all-orders?search=${encodeURIComponent(summary.sourceUid)}`;

    return (
        <div className={`items-center gap-3 ${className}`}>
            {/* Order count (all statuses, coin orders included) + status breakdown.
                Clicking opens the full order list for this UID in a new tab so
                the open conversation is not lost. */}
            <Link
                href={allOrdersHref}
                target="_blank"
                rel="noopener noreferrer"
                title="Open all orders for this ID (new tab)"
                className="shrink-0 leading-tight rounded-md px-1.5 py-0.5 -mx-1.5 hover:bg-white/10"
            >
                <div className="flex items-center gap-1 text-[13px] font-semibold">
                    <ShoppingBag className="h-3.5 w-3.5 shrink-0" />
                    {summary.totalOrders} {summary.totalOrders === 1 ? 'order' : 'orders'}
                    <ExternalLink className="h-3 w-3 opacity-60" />
                </div>
                <div className="text-[10px] text-white/75 whitespace-nowrap">
                    {hasOrders ? breakdownText(summary) : 'no orders on this ID yet'}
                </div>
            </Link>

            {/* Newest orders (name, price, status, when). */}
            {hasOrders && summary.latestOrders.length > 0 && (
                <div className="min-w-0 flex-1 border-l border-white/20 pl-3" title="Newest orders on this ID">
                    {summary.latestOrders.map((order) => (
                        <RecentOrderRow key={order.id} order={order} />
                    ))}
                </div>
            )}
        </div>
    );
}
