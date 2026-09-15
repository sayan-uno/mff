// --- Online visitors: device label ---
// Turns a User-Agent string into a short label for the admin list, e.g.
// "Android · Chrome" or "Windows · Firefox". Deliberately coarse: it is for a
// quick glance, not for identifying anyone.

export function describeDevice(userAgent: string): string {
    const ua = (userAgent || '').toLowerCase();
    if (!ua) return 'Unknown device';

    const os = /iphone|ipod/.test(ua)
        ? 'iPhone'
        : /ipad/.test(ua) || (/macintosh/.test(ua) && /mobile/.test(ua))
          ? 'iPad'
          : /android/.test(ua)
            ? 'Android'
            : /windows/.test(ua)
              ? 'Windows'
              : /cros/.test(ua)
                ? 'ChromeOS'
                : /mac os|macintosh/.test(ua)
                  ? 'Mac'
                  : /linux/.test(ua)
                    ? 'Linux'
                    : 'Unknown';

    // Order matters: Edge, Opera and Samsung Internet all contain "chrome".
    const browser = /edg(a|e|ios)?\//.test(ua)
        ? 'Edge'
        : /opr\/|opera/.test(ua)
          ? 'Opera'
          : /samsungbrowser/.test(ua)
            ? 'Samsung Internet'
            : /firefox|fxios/.test(ua)
              ? 'Firefox'
              : /crios|chrome/.test(ua)
                ? 'Chrome'
                : /safari/.test(ua)
                  ? 'Safari'
                  : 'Browser';

    return `${os} · ${browser}`;
}
