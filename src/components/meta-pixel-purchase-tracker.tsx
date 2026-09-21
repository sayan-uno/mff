
'use client';

import { useEffect } from 'react';
import { getOrdersForUser, markOrderAsTracked } from '@/app/actions';
import type { User } from '@/lib/definitions';
import { trackGoogleAdsPurchase } from '@/lib/google-ads';

// Declare fbq for TypeScript
declare global {
  interface Window {
    fbq: (...args: any[]) => void;
  }
}

interface MetaPixelPurchaseTrackerProps {
  user: User;
}

export default function MetaPixelPurchaseTracker({ user }: MetaPixelPurchaseTrackerProps) {

  useEffect(() => {
    const checkOrdersAndTrack = async () => {
      if (!user || typeof window.fbq !== 'function') {
        return;
      }

      const orders = await getOrdersForUser();
      
      for (const order of orders) {
        // We only care about successful orders that haven't been tracked yet.
        if ((order.status === 'Completed' || order.status === 'Processing') && !order.isPurchaseTracked) {
          
          console.log(`Firing Meta Pixel 'Purchase' event for order: ${order._id}`);
          
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
            orderId: order._id.toString(),
            value: order.finalPrice,
            productId: order.productId,
            productName: order.productName,
          });

          // Mark the order as tracked in the database to prevent future duplicate events.
          await markOrderAsTracked(order._id.toString());
        }
      }
    };

    // Run the check shortly after the component mounts
    const timer = setTimeout(checkOrdersAndTrack, 3000); // 3-second delay to ensure fbq is ready

    return () => clearTimeout(timer);
  }, [user]);

  // This component does not render anything
  return null;
}
