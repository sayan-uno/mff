// --- Support Inbox: user order summary ---
// Shared, framework-agnostic types for the small "orders at a glance" block the
// admin sees in the green conversation header of the Support Inbox. This file
// deliberately contains ONLY types (no 'use server', no DB code) so it can be
// imported by both the server action that builds the summary and the client
// component that renders it.
//
// The whole feature is self-contained in its own files so none of the existing
// support-inbox behaviour is affected.

// A single recent order, trimmed down to what the header needs.
export interface SupportRecentOrder {
    id: string;
    productName: string;
    // Stored order status ('Processing' | 'Completed' | 'Failed'); kept as a
    // plain string so an unexpected legacy value still renders instead of
    // breaking the header.
    status: string;
    // ISO timestamp of when the order was placed.
    createdAt: string;
    finalPrice: number;
    // True for store-coin products (coin packs bought with money).
    isCoinProduct: boolean;
    paymentMethod: string;
}

export interface SupportUserOrderSummary {
    // The UID whose orders were counted (the ticket's current canonical gamingId).
    sourceUid: string;
    // Every order on this UID, regardless of status. Store-coin orders are
    // included in this number.
    totalOrders: number;
    // Breakdown of `totalOrders` by status.
    completed: number;
    processing: number;
    // Legacy 'Pending' status still present on older orders.
    pending: number;
    failed: number;
    // How many of `totalOrders` are store-coin orders (already included above).
    coinOrders: number;
    // The newest orders, newest first (at most `SUPPORT_RECENT_ORDER_LIMIT`).
    latestOrders: SupportRecentOrder[];
    // True when the lookup could not run (not signed in as admin, DB error).
    // The header then says "unavailable" instead of pretending the user has
    // zero orders.
    unavailable?: boolean;
}

export const SUPPORT_RECENT_ORDER_LIMIT = 2;
