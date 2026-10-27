import ErrorTracker from '@sourav732/error-tracker-js';

// Next.js runs this file in the browser before React starts (Next 15.3+), so
// errors during the first render and hydration are captured too.
ErrorTracker.init({
  apiKey: process.env.NEXT_PUBLIC_ET_API_KEY,
  endpoint: process.env.NEXT_PUBLIC_ET_ENDPOINT,
  environment: process.env.NODE_ENV,
  appVersion: '0.1.0',
  maskSelectors: ['.private'],
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
  debug: process.env.NODE_ENV !== 'production',
});
ErrorTracker.setUser({ id: 'demo_user', name: 'Demo User' });
