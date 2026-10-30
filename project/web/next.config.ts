import type { NextConfig } from 'next';

const isProduction = process.env.NODE_ENV === 'production';

/** Sent with every response. The Content-Security-Policy is set per request in middleware.ts (it needs a nonce). */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // HSTS is meaningless (and sticky) on http://localhost.
  ...(isProduction ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

const nextConfig: NextConfig = {
  // Lets a test build run alongside `npm run dev` without both writing to .next/.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/(.*)', headers: SECURITY_HEADERS },
      {
        // SDK demo page for CSP violation tracking. Report-only: nothing is actually blocked.
        source: '/demo/csp',
        headers: [{ key: 'Content-Security-Policy-Report-Only', value: "img-src 'self'" }],
      },
    ];
  },
  async redirects() {
    // The old SDK demo pages, now under /demo.
    return ['/products', '/about', '/hydration', '/csp', '/server-error', '/blank'].map((path) => ({
      source: path,
      destination: `/demo${path}`,
      permanent: false,
    }));
  },
};

export default nextConfig;
