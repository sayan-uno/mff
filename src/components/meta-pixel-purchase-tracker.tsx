
'use client';

import { useCallback, useEffect, useRef } from 'react';
import { getOrdersForUser, markOrderAsTracked } from '@/app/actions';
import type { User } from '@/lib/definitions';
import { trackGoogleAdsPurchase } from '@/lib/google-ads';
import { useOptionalRefresh } from '@/context/RefreshContext';

// Declare fbq for TypeScript
declare global {
  interface Window {
    fbq: (...args: any[]) => void;
  }
}

interface MetaPixelPurchaseTrackerProps {
  user: User;
}

// Paid orders are created on the server (bank-SMS webhook, redeem-code submit, admin
// approval), so the browser has to *look* for them. Besides the original one-off check
// after load, the tracker re-checks at every moment a paid order can newly appear:
//   - the purchase modal reports a confirmed payment (it bumps RefreshContext's refreshKey),
//   - the page becomes visible again (buyer comes back from the UPI app, tab switch,
//     bfcache restore),
//   - a light periodic safety net while the page stays visible (late bank SMS, manual
//     admin approval while the buyer is still on the site).
// Every check goes through one single-flight guard and the same once-per-order rules
// (DB flag `isPurchaseTracked` + an in-memory set for this page), so an order can never
// be reported twice.
const INITIAL_CHECK_DELAY_MS = 3000; // unchanged: gives fbq / gtag time to initialise after load
const TRIGGER_CHECK_DELAY_MS = 1000; // after a payment-success / visibility trigger
const PERIODIC_CHECK_MS = 60 * 1000; // safety net while the page is visible

export default function MetaPixelPurchaseTracker({ user }: MetaPixelPurchaseTrackerProps) {
  // Optional on purpose: the tracker keeps working (minus the success trigger) even if it
  // is ever rendered outside the RefreshProvider.
  const refresh = useOptionalRefresh();
  const refreshKey = refresh?.refreshKey ?? 0;

  const userRef = useRef(user);
  userRef.current = user;
  const firedOrderIds = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);
  const rerunRequested = useRef(false);
  const triggerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkOrdersAndTrack = useCallback(async (reason: string) => {
    if (!userRef.current || typeof window === 'undefined' || typeof window.fbq !== 'function') {
      return;
    }
    // Single flight: if a check is already running, ask it to go round once more when it
    // finishes so no trigger is lost, but never let two checks race on the same order.
    if (inFlight.current) {
      rerunRequested.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        rerunRequested.current = false;
        const orders = await getOrdersForUser();

        for (const order of orders) {
          const orderId = order._id.toString();
          // We only care about successful orders that haven't been tracked yet.
          if (
            (order.status === 'Completed' || order.status === 'Processing') &&
            !order.isPurchaseTracked &&
            !firedOrderIds.current.has(orderId)
          ) {
            firedOrderIds.current.add(orderId);
            console.log(`Firing Meta Pixel 'Purchase' event for order: ${orderId} (trigger: ${reason})`);

            // Fire the Meta Pixel event
            window.fbq('track', 'Purchase', {
              value: order.finalPrice,
              currency: 'INR',
              content_name: order.productName,
              content_ids: [order.productId],
              content_type: 'product',
            });

            // Same order, same once-only guard: also report it to Google Ads
            // (silent no-op when the Google tag is unavailable).
            trackGoogleAdsPurchase({
              orderId,
              value: order.finalPrice,
              productId: order.productId,
              productName: order.productName,
            });

            // Mark the order as tracked in the database to prevent future duplicate events.
            await markOrderAsTracked(orderId);
          }
        }
      } while (rerunRequested.current);
    } catch (error) {
      console.error('Purchase tracking check failed:', error);
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Coalesces a burst of triggers (e.g. visibilitychange + pageshow on resume) into one check.
  const scheduleCheck = useCallback(
    (delayMs: number, reason: string) => {
      if (triggerTimer.current) clearTimeout(triggerTimer.current);
      triggerTimer.current = setTimeout(() => {
        triggerTimer.current = null;
        void checkOrdersAndTrack(reason);
      }, delayMs);
    },
    [checkOrdersAndTrack]
  );

  // 1. Original behaviour: one check shortly after mount (and whenever the layout hands
  //    over a new user object). It has its own timer so the triggers below can never
  //    cancel or shorten it.
  useEffect(() => {
    const timer = setTimeout(() => void checkOrdersAndTrack('load'), INITIAL_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [user, checkOrdersAndTrack]);

  // 2. The purchase modal bumps refreshKey when a UPI payment is confirmed or a redeem-code
  //    order is placed. The order already exists in the DB at that moment, so report it now.
  useEffect(() => {
    if (refreshKey > 0) scheduleCheck(TRIGGER_CHECK_DELAY_MS, 'refresh');
  }, [refreshKey, scheduleCheck]);

  // 3. Buyer comes back to the page (UPI app -> browser / PWA, tab switch, bfcache restore),
  //    plus the periodic safety net while the page stays visible.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleCheck(TRIGGER_CHECK_DELAY_MS, 'visible');
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) scheduleCheck(TRIGGER_CHECK_DELAY_MS, 'pageshow');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void checkOrdersAndTrack('periodic');
    }, PERIODIC_CHECK_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      clearInterval(interval);
      if (triggerTimer.current) {
        clearTimeout(triggerTimer.current);
        triggerTimer.current = null;
      }
    };
  }, [scheduleCheck, checkOrdersAndTrack]);

  // This component does not render anything
  return null;
}
