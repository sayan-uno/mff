/**
 * Send-only Telegram helper used for admin alerts and admin login codes.
 *
 * Security notes:
 * - The server only ever SENDS to the single chat in TELEGRAM_ADMIN_CHAT_ID.
 *   It never reads incoming Telegram messages, so a leaked bot token cannot
 *   be used to read anything from here.
 * - Delivery is confirmed by Telegram's own HTTPS API response (`ok: true`
 *   and the message landing in the configured chat). Nothing a browser sends
 *   can influence that check, so callers may treat `ok: false` as "not
 *   delivered" and refuse security-critical actions (fail closed).
 * - Messages are plain text (no parse_mode), so IPs / user agents cannot inject
 *   formatting.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID.
 */

const TELEGRAM_API = 'https://api.telegram.org';
const TIMEOUT_MS = 8000;
const MAX_TEXT = 4000;

export type TelegramSendResult = { ok: true; messageId: number } | { ok: false; reason: string };

const env = (name: string) => (process.env[name] ?? '').trim();

export function isTelegramConfigured(): boolean {
  return env('TELEGRAM_BOT_TOKEN') !== '' && env('TELEGRAM_ADMIN_CHAT_ID') !== '';
}

/** Masked chat id for display in the admin UI (never the token). */
export function telegramChatIdHint(): string {
  const id = env('TELEGRAM_ADMIN_CHAT_ID');
  return id.length > 4 ? `…${id.slice(-4)}` : id ? '…' : '';
}

export async function sendTelegramAlert(text: string): Promise<TelegramSendResult> {
  const token = env('TELEGRAM_BOT_TOKEN');
  const chatId = env('TELEGRAM_ADMIN_CHAT_ID');
  if (!token || !chatId) {
    return { ok: false, reason: 'Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID).' };
  }
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, MAX_TEXT), disable_web_page_preview: true }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { message_id?: number; chat?: { id?: number | string } } }
      | null;
    if (!res.ok || !json?.ok || !json.result) {
      return { ok: false, reason: json?.description ?? `Telegram responded with HTTP ${res.status}.` };
    }
    if (String(json.result.chat?.id ?? '') !== chatId) {
      return { ok: false, reason: 'Telegram delivered the message to an unexpected chat.' };
    }
    return { ok: true, messageId: Number(json.result.message_id ?? 0) };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    return { ok: false, reason: name === 'TimeoutError' ? 'Telegram did not respond in time.' : 'Could not reach Telegram.' };
  }
}
