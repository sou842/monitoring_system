'use client';

import { useEffect } from 'react';
import ErrorTracker from '@company/error-tracker-js';

/** Catches crashes in the root layout itself, which app/error.js cannot. */
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    ErrorTracker.captureError(error, { boundary: 'app/global-error.js', digest: error.digest });
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
