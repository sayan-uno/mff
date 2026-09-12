/** Small browser-side helpers for the Object Manager UI. */

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return '';
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Copies text to the clipboard, with a fallback for browsers without the async API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function breadcrumbsFor(prefix: string): { name: string; prefix: string }[] {
  const crumbs = [{ name: 'Root', prefix: '' }];
  let acc = '';
  for (const part of prefix.split('/').filter(Boolean)) {
    acc += `${part}/`;
    crumbs.push({ name: part, prefix: acc });
  }
  return crumbs;
}

/** Shortens a URL for toasts: keeps the start and the file name. */
export function shortenUrl(url: string, max = 70): string {
  if (url.length <= max) return url;
  const tail = url.slice(url.lastIndexOf('/'));
  return `${url.slice(0, Math.max(10, max - tail.length - 1))}…${tail}`;
}
