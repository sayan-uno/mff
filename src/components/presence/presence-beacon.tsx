'use client';

// --- Online visitors: browser beacon ---
// Renders nothing. Mounted once in the root layout, it tells the server "I am
// here" for the page the visitor is looking at:
//
//   - once when a page opens, then every HEARTBEAT_MS while the tab is visible
//     and the device is online;
//   - "bye" the moment the tab is hidden (another tab, minimised browser,
//     switched app, screen off) or closed, so the visitor drops out at once;
//   - nothing while hidden or offline; a heartbeat again when the tab is shown
//     or the connection returns.
//
// One id per browser lives in localStorage, so several tabs of the same person
// count once. When one tab says "bye" while another tab of the same browser is
// still visible, that tab re-asserts presence a moment later (via the storage
// event), so switching between two tabs of the site never shows the person as
// offline.
//
// Admin pages are never counted. Everything is fire-and-forget: a failed ping
// is simply dropped and nothing else on the site notices.

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import {
    HEARTBEAT_MS,
    IGNORED_PATH_PREFIXES,
    MAX_PATH_LENGTH,
    PRESENCE_ENDPOINT,
    PRESENCE_STORAGE_KEY,
    PRESENCE_SYNC_KEY,
    VISITOR_ID_PATTERN,
    type PresenceBeaconBody,
    type PresenceKind,
} from '@/lib/presence/types';

const PATH_CHANGE_MIN_GAP_MS = 10_000; // a quick hop between pages does not send an extra ping
const REASSERT_DELAY_MS = 1_500; // let a sibling tab's "bye" land before this tab re-asserts

let memoryId = '';

function randomId(): string {
    try {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '');
    } catch {
        /* fall through */
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable per browser (localStorage); per page load when storage is blocked. */
function visitorId(): string {
    if (memoryId) return memoryId;
    let id = '';
    try {
        id = localStorage.getItem(PRESENCE_STORAGE_KEY) ?? '';
    } catch {
        /* storage blocked */
    }
    if (!VISITOR_ID_PATTERN.test(id)) {
        id = randomId();
        try {
            localStorage.setItem(PRESENCE_STORAGE_KEY, id);
        } catch {
            /* storage blocked */
        }
    }
    memoryId = id;
    return id;
}

function isStandalone(): boolean {
    try {
        return (
            window.matchMedia('(display-mode: standalone)').matches ||
            (navigator as Navigator & { standalone?: boolean }).standalone === true
        );
    } catch {
        return false;
    }
}

function isIgnored(path: string): boolean {
    return IGNORED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function send(kind: PresenceKind): void {
    const body: PresenceBeaconBody = {
        v: visitorId(),
        k: kind,
        p: window.location.pathname.slice(0, MAX_PATH_LENGTH),
        a: isStandalone(),
    };
    const json = JSON.stringify(body);

    // sendBeacon is the reliable way to get a request out of a closing page.
    if (kind === 'bye' && typeof navigator.sendBeacon === 'function') {
        try {
            if (navigator.sendBeacon(PRESENCE_ENDPOINT, json)) return;
        } catch {
            /* fall back to fetch */
        }
    }
    try {
        void fetch(PRESENCE_ENDPOINT, {
            method: 'POST',
            body: json,
            keepalive: true,
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        }).catch(() => {});
    } catch {
        /* ignore */
    }
}

const visible = () => document.visibilityState === 'visible';
const online = () => navigator.onLine !== false;

let lastSentAt = 0;
// "hidden" and "pagehide" both fire when a page unloads: say bye once per departure.
let hasLeft = false;

/** One heartbeat, only when the tab is visible and the device is online. */
function heartbeat(): void {
    if (!visible() || !online()) return;
    lastSentAt = Date.now();
    hasLeft = false;
    send('hb');
}

export default function PresenceBeacon() {
    const pathname = usePathname();
    const ignored = !pathname || isIgnored(pathname);

    // The timer and the listeners live for as long as the visitor is on a counted
    // page. They deliberately do NOT restart on every page change, so someone who
    // clicks through pages quickly still heartbeats every HEARTBEAT_MS.
    useEffect(() => {
        if (ignored) return;

        let timer: number | undefined;
        let reassert: number | undefined;

        const stopTimer = () => {
            if (timer !== undefined) {
                window.clearInterval(timer);
                timer = undefined;
            }
        };
        const startTimer = () => {
            stopTimer();
            timer = window.setInterval(heartbeat, HEARTBEAT_MS);
        };
        // Shown again, back online, or restored from the back/forward cache.
        const wake = () => {
            heartbeat();
            startTimer();
        };
        // Hidden or offline: stop pinging.
        const sleep = () => {
            stopTimer();
            if (reassert !== undefined) {
                window.clearTimeout(reassert);
                reassert = undefined;
            }
        };
        // Hidden or closed: tell the server right away, and tell sibling tabs.
        const leave = () => {
            sleep();
            if (hasLeft) return;
            hasLeft = true;
            send('bye');
            try {
                localStorage.setItem(PRESENCE_SYNC_KEY, String(Date.now()));
            } catch {
                /* ignore */
            }
        };

        const onVisibility = () => (visible() ? wake() : leave());
        const onOnline = () => {
            if (visible()) wake();
        };
        const onOffline = () => sleep();
        const onPageHide = () => leave();
        // Restored from the back/forward cache (a normal first load is handled below).
        const onPageShow = (event: PageTransitionEvent) => {
            if (event.persisted && visible() && online()) wake();
        };
        // Another tab of this browser said "bye". If this is the tab the person is
        // actually looking at, re-assert presence just after that bye has landed.
        const onStorage = (event: StorageEvent) => {
            if (event.key !== PRESENCE_SYNC_KEY || !visible() || !online()) return;
            if (reassert !== undefined) window.clearTimeout(reassert);
            reassert = window.setTimeout(heartbeat, REASSERT_DELAY_MS);
        };

        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);
        window.addEventListener('storage', onStorage);

        if (visible() && online()) startTimer();

        return () => {
            sleep();
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('pageshow', onPageShow);
            window.removeEventListener('storage', onStorage);
        };
    }, [ignored]);

    // A ping for each page the visitor opens (so the admin sees the current
    // page), throttled: a quick hop within a few seconds of the last ping waits
    // for the next scheduled heartbeat instead.
    useEffect(() => {
        if (ignored) return;
        if (Date.now() - lastSentAt >= PATH_CHANGE_MIN_GAP_MS) heartbeat();
    }, [pathname, ignored]);

    return null;
}
