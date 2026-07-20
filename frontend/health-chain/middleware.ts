import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PROTECTED_ROUTES = ['/dashboard'];
const ADMIN_ROUTES = ['/admin'];
const AUTH_ROUTES = ['/auth/signin', '/auth/signup'];
const PUBLIC_ROUTES = ['/transparency'];

function parseAuthCookie(request: NextRequest): { isAuthenticated: boolean; role: string | null } {
  // Prefer httpOnly session token (set by backend on login)
  const sessionToken = request.cookies.get('session-token')?.value;
  if (sessionToken) {
    // Token presence is the gate; signature/expiry verified by the backend on every API call.
    // Decode the payload (no verification here — middleware is a routing gate only).
    try {
      const payload = JSON.parse(atob(sessionToken.split('.')[1]));
      const expired = payload.exp && payload.exp * 1000 < Date.now();
      if (!expired) return { isAuthenticated: true, role: payload.role ?? null };
    } catch { /* fall through */ }
  }

  // Fallback: Zustand persisted state (sessionStorage is not readable server-side;
  // the store also writes to a cookie named 'auth-storage' for SSR reads).
  // NOTE: this is NOT trusted for admin gating — only for basic /dashboard redirect.
  const authCookie = request.cookies.get('auth-storage')?.value;
  if (authCookie) {
    try {
      const state = JSON.parse(authCookie);
      if (state?.state?.isAuthenticated === true) {
        return { isAuthenticated: true, role: state?.state?.user?.role ?? null };
      }
    } catch { /* ignore */ }
  }

  return { isAuthenticated: false, role: null };
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_ROUTES.some((r) => pathname.startsWith(r))) return NextResponse.next();

  const { isAuthenticated, role } = parseAuthCookie(request);

  const isProtected = PROTECTED_ROUTES.some((r) => pathname.startsWith(r));
  const isAdmin = ADMIN_ROUTES.some((r) => pathname.startsWith(r));
  const isAuthRoute = AUTH_ROUTES.some((r) => pathname.startsWith(r));

  if ((isProtected || isAdmin) && !isAuthenticated) {
    const url = new URL('/auth/signin', request.url);
    url.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(url);
  }

  if (isAdmin && role !== 'admin') {
    return NextResponse.redirect(new URL('/403', request.url));
  }

  if (isAuthRoute && isAuthenticated) {
    const returnTo = request.nextUrl.searchParams.get('returnTo') || '/dashboard';
    return NextResponse.redirect(new URL(returnTo, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp)$|api).*)'],
};
