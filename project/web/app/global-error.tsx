'use client';

import { useEffect } from 'react';
import ErrorTracker from '@sourav732/error-tracker-js';

/** Catches crashes in the root layout itself, which app/error.tsx cannot. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    ErrorTracker.captureError(error, { boundary: 'app/global-error.tsx', digest: error.digest ?? null });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
        <h2>The app crashed.</h2>
        <button onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
}
