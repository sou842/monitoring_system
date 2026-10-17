/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets a test build run alongside `npm run dev` without both writing to .next/.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  async headers() {
    return [
      {
        // Demo page for CSP violation tracking. Report-only: nothing is actually blocked.
        source: '/csp',
        headers: [{ key: 'Content-Security-Policy-Report-Only', value: "img-src 'self'" }],
      },
    ];
  },
};

export default nextConfig;
