'use client';

import { useState } from 'react';
import ErrorTracker from '@company/error-tracker-js';

export default function Home() {
  const [crash, setCrash] = useState(false);
  if (crash) throw new Error('Render crash from Home page');

  return (
    <div>
      <h1>Home</h1>
      <p className="private">Private info (masked in screenshots): jane@example.com</p>

      <h3>Trigger errors</h3>
      <button onClick={() => { const cart = undefined; return cart.price; }}>Uncaught TypeError</button>
      <button onClick={() => Promise.reject(new Error('Unhandled rejection'))}>Unhandled rejection</button>
      <button onClick={() => {
        try { JSON.parse('{bad json'); } catch (e) { ErrorTracker.captureError(e, { source: 'home' }); }
      }}>Handled error</button>
      <button onClick={() => ErrorTracker.captureMessage('Hello from Home', 'info')}>Send message</button>
      <button onClick={() => setCrash(true)}>Render crash</button>

      <h3>Trigger API issues</h3>
      <button onClick={() => fetch('/api/slow')}>Slow API (2.5s)</button>
      <button onClick={() => fetch('/api/fail')}>API 500</button>
      <button onClick={() => fetch('/api/does-not-exist')}>API 404</button>
    </div>
  );
}
