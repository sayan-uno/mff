import { unstable_noStore as noStore } from 'next/cache';
import { ADMIN_SESSION_HOURS } from '@/lib/admin-auth/session';
import { getSecurityOverview, listRecentLoginAttempts } from '@/lib/admin-auth/store';
import { isTelegramConfigured, telegramChatIdHint } from '@/lib/telegram';
import SecurityManager from './_components/security-manager';

// Admin auth is enforced by the (protected) layout; every action checks again.
export default async function AdminSecurityPage() {
  noStore();
  const [overview, attempts] = await Promise.all([getSecurityOverview(), listRecentLoginAttempts(25)]);
  return (
    <SecurityManager
      overview={overview}
      telegramConfigured={isTelegramConfigured()}
      telegramChatHint={telegramChatIdHint()}
      sessionHours={ADMIN_SESSION_HOURS}
      attempts={attempts.map((a) => ({ ...a, at: a.at.toISOString() }))}
    />
  );
}
