import ErrorTracker from '@sourav732/error-tracker-js';

// Next.js runs this file in the browser before React starts (Next 15.3+), so
// errors during the first render and hydration are captured too.
//
// The app monitors itself: the dashboard and the SDK demo pages (/demo) report
// to this app's own ingestion endpoint unless NEXT_PUBLIC_ET_ENDPOINT points
// elsewhere. The demo pages get extra options so their scenarios report quickly.
const isDemo = window.location.pathname === '/demo' || window.location.pathname.startsWith('/demo/');
const apiKey = process.env.NEXT_PUBLIC_ET_API_KEY;

if (apiKey) {
  ErrorTracker.init({
    apiKey,
    endpoint: process.env.NEXT_PUBLIC_ET_ENDPOINT || '/api/v1/events',
    environment: process.env.NODE_ENV,
    appVersion: '0.1.0',
    maskSelectors: ['.private'],
    debug: process.env.NODE_ENV !== 'production',
    ...(isDemo
      ? {
          captureConsoleErrors: true,
          // Demo: read the heap every 5 s (default 30 s) so the memory-leak button is
          // reported within a few minutes instead of about 10.
          memoryPollIntervalMs: 5000,
          // Demo: also report slow API calls and page loads as issues (off by default
          // since 0.5.0; every request and page is timed in the Performance view anyway).
          captureSlowEvents: true,
          // `next dev` compiles each page on its first request, which can take several
          // seconds. Only judge page-load speed strictly in production builds.
          slowPageLoadMs: process.env.NODE_ENV === 'development' ? 7000 : 3000,
        }
      : {}),
  });
  if (isDemo) ErrorTracker.setUser({ id: 'demo_user', name: 'Demo User' });
}
