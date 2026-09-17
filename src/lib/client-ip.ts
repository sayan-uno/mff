/**
 * The visitor's IP address, resolved the same way everywhere (rate limits,
 * admin login lockouts, IP logs, IP blocks, payment sessions, the SMS webhook,
 * online visitors).
 *
 * Why this exists: a visitor can type any `X-Forwarded-For` value they like.
 * What they cannot fake is the entry the reverse proxy itself adds, which is
 * always the LAST one. So the rule is: walk the list from the right and take
 * the first public address. Private addresses on the right are our own
 * internal hops (Docker networks) and are skipped.
 *
 * Hosting notes
 * - Dokploy / Traefik (current setup): Traefik discards forwarded headers sent
 *   by visitors and writes the real address itself, so the header has a single
 *   entry and this returns exactly what the old "first entry" code returned.
 *   Existing IP blocks and IP logs keep matching.
 * - nginx or any proxy that appends instead of replacing: still correct,
 *   because the faked part is on the left and is never used.
 * - Cloudflare (or any CDN) in front of the server: every request then
 *   arrives from the CDN's own address. Set the environment variable
 *   CLIENT_IP_HEADER=cf-connecting-ip so the CDN's visitor header is used.
 *   Only set it when the site really is behind that CDN, because otherwise
 *   visitors could send that header themselves.
 */

export const UNKNOWN_IP = 'unknown';

/** Anything with a `get(name)`: `Headers`, Next's `headers()`, `request.headers`. */
export interface HeaderSource {
    get(name: string): string | null | undefined;
}

const OVERRIDE_HEADER = (process.env.CLIENT_IP_HEADER ?? '').trim().toLowerCase();

/** Trims, strips brackets and ports, and rejects anything that is not an IP. */
function cleanIp(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let value = raw.trim();
    if (!value) return null;

    const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/); // "[2001:db8::1]:443"
    if (bracketed) {
        value = bracketed[1];
    } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
        value = value.slice(0, value.lastIndexOf(':')); // "203.0.113.7:51234"
    }

    if (value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
    if (!value.includes('.') && !value.includes(':')) return null;
    return value;
}

/** Loopback, private, link-local and carrier-internal ranges: our own hops, never a visitor on the internet. */
function isPrivateIp(ip: string): boolean {
    const v4 = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip;
    const parts = v4.split('.');
    if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
        const [a, b] = parts.map(Number);
        return (
            a === 10 ||
            a === 127 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127)
        );
    }
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

export function getClientIp(headers: HeaderSource): string {
    if (OVERRIDE_HEADER) {
        const fromOverride = cleanIp(headers.get(OVERRIDE_HEADER));
        if (fromOverride) return fromOverride;
    }

    const forwarded = headers.get('x-forwarded-for');
    if (forwarded) {
        const entries = forwarded.split(',');
        let rightmostValid: string | null = null;
        for (let index = entries.length - 1; index >= 0; index--) {
            const ip = cleanIp(entries[index]);
            // A malformed entry ends the trusted part of the chain: never read past it.
            if (!ip) break;
            if (!rightmostValid) rightmostValid = ip;
            if (!isPrivateIp(ip)) return ip;
        }
        // Every entry was private (local development, a visitor on the same network).
        if (rightmostValid) return rightmostValid;
    }

    return cleanIp(headers.get('x-real-ip')) ?? UNKNOWN_IP;
}
