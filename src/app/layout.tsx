
'use client';

import * as React from 'react';
import './globals.css';
import { cn } from '@/lib/utils';
import { Toaster } from '@/components/ui/toaster';
import Header from '@/components/layout/header';
import Footer from '@/components/layout/footer';
import { useState, useEffect, useCallback } from 'react';
import LoadingScreen from '@/components/loading-screen';
import { getEvents, getNotificationsForUser, getUserData, markNotificationAsRead, saveFcmToken } from './actions';
import { logUserIp } from './actions/ip-logger';
import { logUserFingerprint } from './actions/fingerprint-logger';
import { checkAndBlockFingerprint, checkBlockStatus } from './actions/check-block-status';
import type { Event, Notification, User } from '@/lib/definitions';
import PopupNotification from '@/components/popup-notification';
import EventModal from '@/components/event-modal';
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';
import { app } from '@/lib/firebase/client';
import { RefreshProvider } from '@/context/RefreshContext';
import { usePathname, useRouter } from 'next/navigation';
import BannedNotice from '@/components/banned-notice';
import { useToast } from '@/hooks/use-toast';
import Script from 'next/script';
import MetaPixelPurchaseTracker from '@/components/meta-pixel-purchase-tracker';
import BrowserRedirect from '@/components/browser-redirect';
import PresenceBeacon from '@/components/presence/presence-beacon';


const FCM_TOKEN_KEY = 'fcm_token';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [standardNotifications, setStandardNotifications] = useState<Notification[]>([]);
  const [popupNotifications, setPopupNotifications] = useState<Notification[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [showEventModal, setShowEventModal] = useState(false);
  const [notificationKey, setNotificationKey] = useState(0);
  const [bannedInfo, setBannedInfo] = useState<{ message: string, id: string } | null>(null);
  const { toast } = useToast();


  const pathname = usePathname();
  const router = useRouter();
  const isAdPage = pathname === '/watch-ad';
  const isBlockedPage = pathname === '/blocked';


  const fetchInitialData = useCallback(async (isInitialLoad = false) => {
    if (isInitialLoad) {
      setIsLoading(true);
    }
    const userData = await getUserData();
    setUser(userData);
    
    // Log user IP in the background
    if (userData) {
      logUserIp();
    }

    if (userData?.isBanned) {
      setBannedInfo({ id: userData.visualGamingId || userData.gamingId, message: userData.banMessage || 'Your account has been suspended.'});
      setIsLoading(false);
      return;
    }
    
    const allEvents = await getEvents();
    if (typeof window !== 'undefined') {
        const eventsSeen = sessionStorage.getItem('eventsSeen');
        if (!eventsSeen) {
          setEvents(allEvents);
          if(userData && allEvents.length > 0) {
              setShowEventModal(true);
          }
        }
    }

    if (userData) {
      const allNotifications = await getNotificationsForUser();
      const standard = allNotifications.filter(n => !n.isPopup);
      const popups = allNotifications.filter(n => n.isPopup && !n.isRead);

      setStandardNotifications(standard);
      setPopupNotifications(popups);
    }
    if (isInitialLoad) {
      setIsLoading(false);
    }
  }, []);

  const handleNotificationRefresh = useCallback(async () => {
    if (user) {
        const allNotifications = await getNotificationsForUser();
        setStandardNotifications(allNotifications.filter(n => !n.isPopup));
    }
    setNotificationKey(prevKey => prevKey + 1);
  }, [user]);

  const onUserRegistered = useCallback(async () => {
    // Re-fetch all data when a user registers
    await fetchInitialData(true);
  }, [fetchInitialData]);


  const requestNotificationPermission = useCallback(async () => {
    try {
        const isFCMSupported = await isSupported();
        if (isFCMSupported && typeof window !== 'undefined' && 'serviceWorker' in navigator && 'Notification' in window) {
            const messaging = getMessaging(app);
            
            await navigator.serviceWorker.register('/firebase-messaging-sw.js');
            const swRegistration = await navigator.serviceWorker.ready;
            
            const permission = await Notification.requestPermission();
            
            if (permission === 'granted') {
              const currentToken = await getToken(messaging, { 
                  vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
                  serviceWorkerRegistration: swRegistration 
              });
              if (currentToken) {
                await saveFcmToken(currentToken);
                localStorage.setItem(FCM_TOKEN_KEY, currentToken);
                setUser(prevUser => prevUser ? { ...prevUser, fcmToken: currentToken } : null);
              }
            }
        }
    } catch (error) {
      console.error('An error occurred while setting up notifications. This might be an unsupported browser.', error);
    }
  }, []);

  useEffect(() => {
    // Run initial checks and data fetching
    const runInitialLoad = async () => {
        if (isBlockedPage) {
          setIsLoading(false);
          return;
        };

        const { isBlocked, reason } = await checkBlockStatus();
        if (isBlocked) {
          router.replace(`/blocked?reason=${encodeURIComponent(reason || 'Your access has been restricted.')}`);
          return;
        }

        fetchInitialData(true);

        // Set up foreground message listener
        isSupported().then(isFCMSupported => {
            if (isFCMSupported && typeof window !== 'undefined') {
                 try {
                    const messaging = getMessaging(app);
                    const unsubscribe = onMessage(messaging, (payload) => {
                        fetchInitialData(false);
                        if (payload.data) {
                             toast({
                                title: payload.data.title,
                                description: payload.data.body,
                            });
                        }
                    });
                    return () => unsubscribe();
                } catch (error) {
                    console.error("Firebase Messaging not initialized or failed to listen:", error);
                }
            }
        });
    };
    
    runInitialLoad();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quietly keep the notification bell in sync every 15s so the unread count and
  // the list reflect server changes WITHOUT the user having to close/re-open it.
  // In particular, when a support reply is marked seen the server deletes that
  // bell notification, and this poll makes it disappear (and the count drop) on
  // its own. We only update the standard notifications here — popups are left
  // untouched so a previously-closed popup never re-appears, and we never bump
  // notificationKey so an open bell sheet is not remounted/closed mid-view.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      try {
        const allNotifications = await getNotificationsForUser();
        setStandardNotifications(allNotifications.filter(n => !n.isPopup));
      } catch {
        /* transient fetch error — try again on the next tick */
      }
    }, 15000);
    return () => clearInterval(interval);
  }, [user]);

  useEffect(() => {
    if (user && typeof window !== 'undefined' && 'Notification' in window) {
        const localToken = localStorage.getItem(FCM_TOKEN_KEY);
        const permissionRevoked = Notification.permission !== 'granted' && user.fcmToken;
        const tokenMismatch = !user.fcmToken || localToken !== user.fcmToken;

        if (permissionRevoked || tokenMismatch) {
            requestNotificationPermission();
        }
    }
  }, [user, requestNotificationPermission]);


  const handlePopupClose = async (notificationId: string) => {
    await markNotificationAsRead(notificationId);
    setPopupNotifications(prev => prev.filter(n => n._id.toString() !== notificationId));
  };
  
  const handleEventClose = () => {
    const nextIndex = currentEventIndex + 1;
    if (nextIndex < events.length) {
      setCurrentEventIndex(nextIndex);
    } else {
      setShowEventModal(false);
      if (typeof window !== 'undefined') {
        sessionStorage.setItem('eventsSeen', 'true');
      }
    }
  };

  const handleFingerprint = useCallback(async () => {
    if ((window as any).FingerprintJS && !isBlockedPage) {
      try {
        const fp = await (window as any).FingerprintJS.load();
        const result = await fp.get();
        const visitorId = result.visitorId;

        // Log the fingerprint in the background
        logUserFingerprint(visitorId);
        
        // NOW, check if this fingerprint is blocked
        const { isBlocked, reason } = await checkAndBlockFingerprint(visitorId);
        if (isBlocked) {
          router.replace(`/blocked?reason=${encodeURIComponent(reason || 'Your access has been restricted.')}`);
        }

      } catch (error) {
        console.error('Error getting or logging fingerprint:', error);
      }
    }
  }, [isBlockedPage, router]);

  useEffect(() => {
    // This effect runs when the FingerprintJS script has loaded.
    handleFingerprint();
  }, [handleFingerprint]);

  const childrenWithProps = React.Children.map(children, child => {
    if (React.isValidElement(child)) {
      return React.cloneElement(child as React.ReactElement<any>, { onUserRegistered });
    }
    return child;
  });

  if (isBlockedPage) {
    return (
        <html lang="en" className="h-full">
            <body className={cn('font-body antialiased flex flex-col min-h-screen')}>
                {children}
            </body>
        </html>
    );
  }

  return (
    <html lang="en" className="h-full">
      <head>
        <meta charSet="UTF-8" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Noto+Sans:wght@400;700&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=PT+Sans:wght@400;700&display=swap" rel="stylesheet" />
        <link rel="manifest" href="/manifest.json" />
        <Script src="https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@3/dist/fp.min.js" strategy="afterInteractive" onLoad={handleFingerprint}></Script>
        <Script id="meta-pixel" strategy="afterInteractive">
          {`
            !function(f,b,e,v,n,t,s)
            {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
            n.callMethod.apply(n,arguments):n.queue.push(arguments)};
            if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
            n.queue=[];t=b.createElement(e);t.async=!0;
            t.src=v;s=b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t,s)}(window, document,'script',
            'https://connect.facebook.net/en_US/fbevents.js');
            fbq('init', '1888383185160715');
            fbq('track', 'PageView');
          `}
        </Script>
        <noscript>
          <img height="1" width="1" style={{display: 'none'}}
            src="https://www.facebook.com/tr?id=1888383185160715&ev=PageView&noscript=1"
          />
        </noscript>
      </head>
      <body className={cn('font-body antialiased flex flex-col min-h-screen')}>
        <BrowserRedirect />
        <PresenceBeacon />
        <RefreshProvider>
          {isLoading && <LoadingScreen />}
          <div className={cn('flex flex-col flex-1', isAdPage && 'h-screen')}>
            {!isAdPage && (
              <Header 
                user={user} 
                notifications={standardNotifications} 
                notificationKey={notificationKey}
                onNotificationRefresh={handleNotificationRefresh}
              />
            )}
            <main className={cn('flex-grow', isAdPage && 'h-full')}>{childrenWithProps}</main>
            {!isAdPage && <Footer />}
          </div>
          <Toaster />
          {popupNotifications.length > 0 && (
            <PopupNotification
              notification={popupNotifications[0]}
              onClose={() => handlePopupClose(popupNotifications[0]._id.toString())}
            />
          )}
          {showEventModal && events.length > 0 && (
              <EventModal event={events[currentEventIndex]} onClose={handleEventClose} />
          )}
          <BannedNotice 
            isOpen={!!bannedInfo}
            onOpenChange={(open) => !open && setBannedInfo(null)}
            gamingId={bannedInfo?.id || ''}
            banMessage={bannedInfo?.message || ''}
          />
        </RefreshProvider>
        {user && <MetaPixelPurchaseTracker user={user} />}
      </body>
    </html>
  );
}
