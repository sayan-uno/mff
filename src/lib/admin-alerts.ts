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

export function formatUnmatchedPaymentAlert(input: { amount: number; upiRef?: string | null; sender?: string; text: string }): string {
  return [
    `⚠️ Payment received but NOT verified: ₹${input.amount}`,
    input.upiRef ? `UPI ref: ${input.upiRef}` : null,
    input.sender ? `Sender: ${input.sender}` : null,
    `Time: ${nowText()}`,
    '',
    `SMS: ${input.text.slice(0, 300)}`,
    '',
    'No active payment session matched this amount. Check Payment Sessions and SMS Logs, then approve manually if it is genuine.',
    'Tip: open this payment in your UPI app. The note starts with a 6-character pay code. Search that code on the Payment Sessions page to find the buyer.',
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

/** Best effort: a payment SMS arrived but no session matched; the admin must look. */
export async function alertUnmatchedPayment(input: Parameters<typeof formatUnmatchedPaymentAlert>[0]): Promise<void> {
  const result = await sendTelegramAlert(formatUnmatchedPaymentAlert(input));
  if (!result.ok) console.error('[alerts] unmatched payment alert not delivered:', result.reason);
}
