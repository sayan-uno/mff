// Google Ads (gtag.js) integration.
//
// The Google tag itself is loaded in src/app/layout.tsx (right next to the Meta
// Pixel). This module only holds the IDs plus two tiny helpers that send the
// purchase / sign-up events. Every helper is a silent no-op when the tag is not
// available (ad blocker, offline, script not loaded yet, server side), so nothing
// else in the app can ever be affected by it.

/** The Google Ads tag ID (Google Ads > Tools > Google tag). */
export const GOOGLE_ADS_ID = 'AW-18464888558';

/**
 * Conversion labels. In Google Ads open Goals > Conversions > (the action) >
 * "Use Google tag"; the event snippet there contains
 *   'send_to': 'AW-18464888558/XXXXXXXXXXX'
 * and the part after the slash is the label. While a label is empty only the
 * standard `purchase` / `sign_up` events are sent to the Google tag; once it is
 * filled in, the matching Google Ads conversion action is fired as well.
 */
export const GOOGLE_ADS_PURCHASE_LABEL = 'ZCHQCN3A3_8cEO6t3-RE';
export const GOOGLE_ADS_SIGNUP_LABEL = 'uvqrCIis8_8cEO6t3-RE';

declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
    dataLayer?: unknown[];
  }
}

type GtagParams = Record<string, unknown>;

/** Calls window.gtag only if the Google tag stub exists. Never throws. */
function gtagSafe(event: string, params: GtagParams): boolean {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return false;
  try {
    window.gtag('event', event, params);
    return true;
  } catch (error) {
    console.error('Google Ads event failed:', error);
    return false;
  }
}

export interface GoogleAdsPurchase {
  orderId: string;
  value: number;
  productId: string;
  productName: string;
}

/**
 * Reports a paid order to Google Ads. The order id is sent as `transaction_id`,
 * which Google Ads also uses to discard duplicate conversions on its side.
 */
export function trackGoogleAdsPurchase(purchase: GoogleAdsPurchase): void {
  const value = Number.isFinite(purchase.value) ? purchase.value : 0;
  gtagSafe('purchase', {
    transaction_id: purchase.orderId,
    value,
    currency: 'INR',
    items: [{ item_id: purchase.productId, item_name: purchase.productName, price: value, quantity: 1 }],
  });
  if (GOOGLE_ADS_PURCHASE_LABEL) {
    gtagSafe('conversion', {
      send_to: `${GOOGLE_ADS_ID}/${GOOGLE_ADS_PURCHASE_LABEL}`,
      transaction_id: purchase.orderId,
      value,
      currency: 'INR',
    });
  }
}

/** Reports a brand-new account registration to Google Ads. */
export function trackGoogleAdsSignup(): void {
  gtagSafe('sign_up', { method: 'gaming_id' });
  if (GOOGLE_ADS_SIGNUP_LABEL) {
    // Same value/currency Google put in this action's event snippet.
    gtagSafe('conversion', { send_to: `${GOOGLE_ADS_ID}/${GOOGLE_ADS_SIGNUP_LABEL}`, value: 1.0, currency: 'INR' });
  }
}
