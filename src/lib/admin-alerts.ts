/**
 * Admin alerts sent to Telegram (server-only). Replaces the old Gmail emails.
 *
 * Two kinds:
 * - best effort: never block the user-facing action (new orders, payments).
 * - must deliver: the caller refuses the action when `ok` is false
 *   (UPI ID change). The delivery check is Telegram's own API response, see
 *   src/lib/telegram.ts.
 */

import { sendTelegramAlert, type TelegramSendResult } from '@/lib/telegram';

function nowText(): string {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

/** "ffgarenasmaxsayan@yesg" -> "ffga***@yesg" */
export function maskUpiId(upiId: string): string {
  const [name, provider] = upiId.split('@');
  if (!name || !provider) return '***';
  return `${name.slice(0, Math.min(4, name.length))}***@${provider}`;
}

export function formatRedeemCodeOrderAlert(input: { gamingId: string; productName: string; redeemCode: string; amount?: number; orderId?: string }): string {
  return [
    '🧾 New redeem-code order',
    `Product: ${input.productName}`,
    input.amount !== undefined ? `Amount: ₹${input.amount}` : null,
    `Gaming ID: ${input.gamingId}`,
    `Redeem code: ${input.redeemCode}`,
    input.orderId ? `Order: ${input.orderId}` : null,
    `Time: ${nowText()}`,
    '',
    'Process it in the admin panel (Pending Orders).',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function formatUpiChangeAlert(input: { oldUpiId: string; newUpiId: string; ip?: string }): string {
  return [
    '🚨 HIGH ALERT: UPI ID changed',
    `Old: ${maskUpiId(input.oldUpiId)}`,
    `New: ${input.newUpiId}`,
    input.ip ? `IP: ${input.ip}` : null,
    `Time: ${nowText()}`,
    '',
    'If you did not do this, change the admin password and restore the UPI ID immediately.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function formatPaymentReceivedAlert(input: { gamingId: string; productName: string; amount: number; status: string; orderId?: string; utr?: string | null }): string {
  return [
    `💰 Payment received: ₹${input.amount}`,
    `Product: ${input.productName}`,
    `Gaming ID: ${input.gamingId}`,
    `Order status: ${input.status}`,
    input.utr ? `UPI ref: ${input.utr}` : null,
    input.orderId ? `Order: ${input.orderId}` : null,
    `Time: ${nowText()}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** Best effort: a failure is logged but never blocks the order. */
export async function alertRedeemCodeOrder(input: Parameters<typeof formatRedeemCodeOrderAlert>[0]): Promise<void> {
  const result = await sendTelegramAlert(formatRedeemCodeOrderAlert(input));
  if (!result.ok) console.error('[alerts] redeem-code order alert not delivered:', result.reason);
}

/** Must deliver: the caller blocks the UPI change unless `ok` is true. */
export async function alertUpiChange(input: Parameters<typeof formatUpiChangeAlert>[0]): Promise<TelegramSendResult> {
  return sendTelegramAlert(formatUpiChangeAlert(input));
}

/** Best effort: informational only, never blocks payment processing. */
export async function alertPaymentReceived(input: Parameters<typeof formatPaymentReceivedAlert>[0]): Promise<void> {
  const result = await sendTelegramAlert(formatPaymentReceivedAlert(input));
  if (!result.ok) console.error('[alerts] payment alert not delivered:', result.reason);
}
