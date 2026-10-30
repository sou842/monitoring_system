'use client';

import { useEffect } from 'react';
import ErrorTracker from '@sourav732/error-tracker-js';

/** Next.js error boundary for every page: reports render crashes to the SDK. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    ErrorTracker.captureError(error, { boundary: 'app/error.tsx', digest: error.digest ?? null });
  }, [error]);

  return (
    <main className="app-main">
      <div className="card empty-state">
        <h2>Something went wrong.</h2>
        <p>The error was reported. Try again, or reload the page.</p>
        <button type="button" className="primary mt-3" onClick={reset}>Try again</button>
      </div>
    </main>
  );
}
