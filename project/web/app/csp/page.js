/**
 * Served with `Content-Security-Policy-Report-Only: img-src 'self'` (see
 * next.config.mjs), so the external image below triggers a CSP violation
 * report without actually being blocked.
 */
export default function CspPage() {
  return (
    <div>
      <h1>CSP violation</h1>
      <p>This page only allows same-origin images, but loads one from another site:</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f41b.png" alt="bug" width={36} height={36} />
      <p>
        Both problems on this page happen while the HTML is still loading, before the SDK starts: the CSP report above,
        and this broken image:
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/images/missing-early.png" alt="" width={36} height={36} />
    </div>
  );
}
