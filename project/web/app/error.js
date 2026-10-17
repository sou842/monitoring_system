'use client';

import { useEffect } from 'react';
import ErrorTracker from '@sourav732/error-tracker-js';

/** Next.js error boundary: reports render crashes to the SDK. */
export default function Error({ error, reset }) {
  useEffect(() => {
    ErrorTracker.captureError(error, { boundary: 'app/error.js', digest: error.digest });
  }, [error]);

  return (
    <div>
      <h2>Something went wrong.</h2>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
