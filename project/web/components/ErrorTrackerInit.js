'use client';

import { useEffect } from 'react';
import ErrorTracker from '@company/error-tracker-js';
import { saveIssue } from '../lib/issueStore';

/** Starts the error tracking SDK once, in the browser. */
export default function ErrorTrackerInit() {
  useEffect(() => {
    ErrorTracker.init({
      apiKey: process.env.NEXT_PUBLIC_ET_API_KEY,
      endpoint: process.env.NEXT_PUBLIC_ET_ENDPOINT,
      environment: process.env.NODE_ENV,
      appVersion: '0.1.0',
      maskSelectors: ['.private'],
      debug: process.env.NODE_ENV !== 'production',
      // Every event passes through here just before it is queued for sending:
      // keep a copy for the Issues page.
      beforeSend: (event) => {
        saveIssue(event);
        return event;
      },
    });
    ErrorTracker.setUser({ id: 'demo_user', name: 'Demo User' });
  }, []);
  return null;
}
