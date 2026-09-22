/**
 * Helpers for handing a visitor from a social in-app browser (Instagram /
 * Facebook) over to the phone's real browser WITHOUT losing the URL.
 *
 * Why the query string must survive the hand-off: `?ref=<code>` is how referral
 * and ad-source codes reach the site (src/middleware.ts turns it into the
 * `referral_code` cookie). The in-app browser has its own cookie jar, so a cookie
 * set there never reaches Chrome or Safari; the URL is the only thing that can
 * carry the code across. `gclid` / `fbclid` ride along for the same reason, so
 * the Google Ads and Meta Pixel tags in the real browser can still attribute
 * the click.
 *
 * These are pure string builders (no DOM access) so they can be unit-tested.
 */

/** Drops a `#fragment`. Android splits an intent URL at its last `#`, so a fragment would corrupt it. */
function withoutFragment(url: string): string {
    return url.split('#')[0];
}

/**
 * Android intent URL that asks the OS to open `url` in Chrome.
 *
 * Format: https://developer.chrome.com/docs/android/intents
 * - The data part is the page URL without its scheme; the `scheme=https` extra
 *   puts it back. This is the exact shape that was already in use on the site.
 * - `S.browser_fallback_url` is loaded instead when Chrome is not installed, so
 *   the visitor is never left on a blank screen. It is percent-encoded once,
 *   which is what Android's intent parser expects (it decodes extras).
 */
export function buildChromeIntentUrl(url: string): string {
    const pageUrl = withoutFragment(url);
    const withoutScheme = pageUrl.replace(/^https?:\/\//, '');
    const fallback = encodeURIComponent(pageUrl);
    return `intent:${withoutScheme}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
}

/**
 * Instagram's own "open in external browser" deep link, used on iOS where an
 * intent URL does not exist. Instagram only honours it when it is triggered by
 * a user tap, so wire it to a button; never fire it automatically on page load.
 */
export function buildInstagramExternalBrowserUrl(url: string): string {
    return `instagram://extbrowser/?url=${encodeURIComponent(withoutFragment(url))}`;
}

/**
 * True for the Facebook / Instagram in-app browser on Android: the only place
 * where a Chrome intent hand-off applies. Same user-agent checks as the
 * BrowserRedirect component and the /ff page.
 */
export function isAndroidInAppBrowser(userAgent: string): boolean {
    const isFacebook = /FBAN|FBAV/i.test(userAgent);
    const isInstagram = /Instagram/i.test(userAgent);
    const isAndroid = /android/i.test(userAgent);
    return (isFacebook || isInstagram) && isAndroid;
}
