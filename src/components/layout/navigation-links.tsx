
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ShoppingCart, Download } from 'lucide-react';
import type { Notification, User } from '@/lib/definitions';
import NotificationBell from './notification-bell';
import { APK_DOWNLOAD_URL, buildGetAppUrl, getLandingParams, rememberLandingParams } from '@/lib/app-download';
import { buildChromeIntentUrl, isAndroidInAppBrowser } from '@/lib/in-app-browser';
import { getReferralCodeFromCookie } from '@/app/actions/handoff';


const navLinks = [
  { href: '/', label: 'Home' },
  { href: '/about', label: 'About' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'T&C' },
  { href: '/refund', label: 'Refund Policy' },
  { href: '/delivery-policy', label: 'Delivery' },
  { href: '/contact', label: 'Contact' },
  { href: '/support', label: 'Support' },
];

interface NavigationLinksProps {
  mobile?: boolean;
  onLinkClick?: () => void;
  notifications: Notification[];
  user: User | null;
  notificationKey: number;
  onNotificationRefresh: () => void;
}

export default function NavigationLinks({ mobile, onLinkClick, notifications = [], user, notificationKey, onNotificationRefresh }: NavigationLinksProps) {
  const pathname = usePathname();

  // Remember the landing URL's parameters (ref and the ad-click parameters) for the
  // Download App hand-off below. Harmless everywhere else: it only writes sessionStorage.
  useEffect(() => {
    rememberLandingParams(window.location.search);
  }, []);

  // Download App inside the Facebook / Instagram browser on Android: the installed app
  // runs inside Chrome, so Chrome must load this site with the referral code before the
  // APK downloads. The tap therefore opens Chrome on /get-app (carrying the remembered
  // parameters, or the referral cookie as a fallback), and that page starts the download.
  // Every other browser keeps the plain download link exactly as before.
  const handleDownloadClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isAndroidInAppBrowser(navigator.userAgent || '')) return;
    event.preventDefault();
    void (async () => {
      const params = getLandingParams();
      if (!params.get('ref')) {
        const fromCookie = await Promise.race([
          getReferralCodeFromCookie().catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        if (fromCookie) params.set('ref', fromCookie);
      }
      try {
        window.location.href = buildChromeIntentUrl(buildGetAppUrl(window.location.origin, params));
      } catch (e) {
        console.error('Download hand-off failed, downloading directly:', e);
        window.location.href = APK_DOWNLOAD_URL;
      }
    })();
  };

  if (mobile) {
    return (
      <>
        {navLinks.map(({ href, label }) => (
          <Link
            key={label}
            href={href}
            className={cn(
              'text-lg font-medium transition-colors hover:text-primary',
              pathname === href && 'text-primary'
            )}
            onClick={onLinkClick}
          >
            {label}
          </Link>
        ))}
         <a href={APK_DOWNLOAD_URL} download onClick={handleDownloadClick}>
            <Button variant="outline" className="w-full">
                <Download className="mr-2" /> Download App
            </Button>
        </a>
      </>
    );
  }

  return (
    <>
      {notifications.length > 0 && <NotificationBell key={notificationKey} notifications={notifications} onRefresh={onNotificationRefresh} />}
      <Button asChild className={cn(
        'bg-primary/10 hover:bg-primary/20 text-primary',
        pathname === '/order' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
      )}>
        <Link href="/order">
          Order
          <ShoppingCart className="h-4 w-4" />
        </Link>
      </Button>
      {navLinks.map(({ href, label }) => (
        <Link
          key={label}
          href={href}
          className={cn(
            'transition-colors hover:text-primary',
            pathname === href ? 'text-primary font-semibold border-b-2 border-primary' : ''
          )}
        >
          {label}
        </Link>
      ))}
    </>
  );
}
