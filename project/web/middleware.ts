import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from './server/constants.ts';

/**
 * Runs before every page (not API routes or static files):
 *
 * - Dashboard pages without a session cookie go straight to the login page,
 *   which returns to the page afterwards (`?next=`). The page layout still
 *   checks the session itself; this only saves a round trip.
 * - A strict Content-Security-Policy with a fresh nonce per request: Next.js
 *   puts the nonce on its own inline scripts. The SDK demo pages (/demo) are
 *   left without one on purpose: they must be able to misbehave (load
 *   external images, call unreachable hosts) for the SDK to have something
 *   to report.
 */

const DASHBOARD_PATHS = ['/dashboard', '/performance', '/projects', '/issues', '/account', '/admin'];

const isUnder = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** The SDK's ingestion URL may point at another server (e.g. local dev sending to production). */
function sdkEndpointOrigin(): string {
  try {
    const endpoint = process.env.NEXT_PUBLIC_ET_ENDPOINT;
    return endpoint && /^https?:\/\//.test(endpoint) ? ` ${new URL(endpoint).origin}` : '';
  } catch {
    return '';
  }
}

function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    // 'strict-dynamic': scripts loaded by the nonce'd Next.js runtime are trusted too. React needs eval in development only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${sdkEndpointOrigin()}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  // The dashboard layout reads this to send a lost session back to the same page after logging in.
  requestHeaders.set('x-url', `${pathname}${search}`);

  if (DASHBOARD_PATHS.some((base) => isUnder(pathname, base)) && !request.cookies.has(SESSION_COOKIE)) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
    return NextResponse.redirect(login);
  }
  if (isUnder(pathname, '/demo')) return NextResponse.next({ request: { headers: requestHeaders } });

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|icon.svg|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
