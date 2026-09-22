/**
 * "Download App" support. The app is a Chrome WebAPK bound to this site, so it
 * runs inside Chrome and shares Chrome's cookies. For the referral cookie to be
 * there when the app first opens, Chrome must load a page of this site with
 * `?ref=` BEFORE the APK downloads. `/get-app` is that page: the middleware sets
 * the cookie from the URL, then the page starts the download.
 *
 * The parameters of the landing URL (ref plus the ad-click parameters) are
 * remembered per browser tab so they can be put on the /get-app URL later,
 * after the visitor has navigated around and the address bar no longer has them.
 */

export const APK_DOWNLOAD_URL = 'https://github.com/dhdgs23/Garena-Store/releases/download/v1.0/base.apk';

export const GET_APP_PATH = '/get-app';

const LANDING_PARAMS_KEY = 'landingParams';

/** Parameters worth carrying to /get-app: the referral code and the ad platforms' click parameters. */
function isCarriedParam(name: string): boolean {
    return name === 'ref' || name === 'fbclid' || name === 'gclid' || name === 'gbraid' || name === 'wbraid' || name.startsWith('utm_');
}

/**
 * Remembers the carried parameters of the current URL for this tab (first URL
 * with any of them wins). Safe to call on every page; silently does nothing if
 * storage is unavailable, in which case the download link simply behaves as before.
 */
export function rememberLandingParams(search: string): void {
    try {
        if (sessionStorage.getItem(LANDING_PARAMS_KEY)) return;
        const kept = new URLSearchParams();
        new URLSearchParams(search).forEach((value, name) => {
            if (isCarriedParam(name)) kept.set(name, value);
        });
        const serialized = kept.toString();
        if (serialized) sessionStorage.setItem(LANDING_PARAMS_KEY, serialized);
    } catch {
        // Storage blocked or unavailable: nothing to remember.
    }
}

/** The parameters remembered by rememberLandingParams(), or an empty set. */
export function getLandingParams(): URLSearchParams {
    try {
        return new URLSearchParams(sessionStorage.getItem(LANDING_PARAMS_KEY) || '');
    } catch {
        return new URLSearchParams();
    }
}

/** Absolute /get-app URL carrying the given parameters (none → plain /get-app). */
export function buildGetAppUrl(origin: string, params: URLSearchParams): string {
    const query = params.toString();
    return `${origin}${GET_APP_PATH}${query ? `?${query}` : ''}`;
}
