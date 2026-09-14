import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionToken } from '@/lib/admin-auth/session';

const ADMIN_LOGIN_PATH = '/admin/login';

function isAdminArea(pathname: string) {
  return pathname === '/admin' || (pathname.startsWith('/admin/') && !pathname.startsWith(ADMIN_LOGIN_PATH));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Admin gate: pages and /api/admin/* need a validly signed session cookie.
  // (Signature + expiry are checked here; pages and actions also check the
  // session version against the database.)
  if (isAdminArea(pathname) || pathname.startsWith('/api/admin/')) {
    const session = await verifyAdminSessionToken(request.cookies.get(ADMIN_SESSION_COOKIE)?.value);
    if (!session) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
      }
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = ADMIN_LOGIN_PATH;
      loginUrl.search = '';
      return NextResponse.redirect(loginUrl);
    }
  }

  const response = NextResponse.next();

  // Handle referral codes
  const referralCode = request.nextUrl.searchParams.get('ref');
  const existingReferralCode = request.cookies.get('referral_code')?.value;

  // Only set the referral code if it's not already set
  // This ensures the first referrer gets credit
  if (referralCode && !existingReferralCode) {
    response.cookies.set('referral_code', referralCode, {
      maxAge: 365 * 24 * 60 * 60, // 1 year, to persist across sessions
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    });
  }

  return response;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)', '/api/admin/:path*'],
};
