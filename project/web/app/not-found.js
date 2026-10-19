'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import ErrorTracker from '@sourav732/error-tracker-js';

/**
 * Next.js 404 page. A typed URL (full page load, HTTP 404) is detected by the SDK on its own;
 * this call covers client-side <Link> navigations, which have no HTTP status. The SDK drops the duplicate.
 */
export default function NotFound() {
  useEffect(() => {
    ErrorTracker.capturePageNotFound();
  }, []);

  return (
    <div>
      <h2>Page not found</h2>
      <p>This page does not exist.</p>
      <Link href="/">Back to home</Link>
    </div>
  );
}
