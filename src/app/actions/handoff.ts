
'use server';

import { cookies } from 'next/headers';

/**
 * The referral code the middleware stored for this visitor, if any. The cookie
 * is httpOnly, so page scripts cannot read it directly; the Download App link
 * uses this to put the code on the /get-app URL when the landing URL's
 * parameters are no longer available in the tab.
 */
export async function getReferralCodeFromCookie(): Promise<string | null> {
    const store = await cookies();
    return store.get('referral_code')?.value || null;
}
