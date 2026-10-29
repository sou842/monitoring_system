'use client';

import { Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ErrorTracker from '@sourav732/error-tracker-js';

// Each scenario mounts a small "screen app" in its own full-page React root with
// no error boundary (like an Appzillon screen container or a micro-frontend).
// When it breaks or renders nothing, the user sees a plain white page.

const MISSING_CHUNK_URL = '/_next/static/chunks/screen-from-old-deploy.3f2a9c.js';
const OVERLAY_DELAY_MS = 300;

function mountScreen(screenName, Screen) {
  ErrorTracker.setScreen(screenName);
  // The new screen replaces the page, as a real screen change would.
  for (const child of Array.from(document.body.children)) child.style.display = 'none';
  const host = document.createElement('div');
  host.style.cssText = 'min-height:100vh;background:#fff';
  document.body.appendChild(host);
  createRoot(host).render(<Screen />);
}

/** 1. The API answers 200 with an unexpected shape; rendering throws and React unmounts the root. */
function ProfileScreen() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch('/api/profile').then((r) => r.json()).then(setData);
  }, []);
  if (data === null) return <p style={{ padding: 16 }}>Loading profile…</p>;
  return <h1 style={{ padding: 16 }}>Hello {data.profile.name}</h1>;
}

/** 2. A lazily loaded screen whose chunk was deleted by a new deploy. */
const OldDeployScreen = lazy(() => import(/* webpackIgnore: true */ MISSING_CHUNK_URL));
function ChunkScreen() {
  return (
    <Suspense fallback={<p style={{ padding: 16 }}>Loading screen…</p>}>
      <OldDeployScreen />
    </Suspense>
  );
}

/** 3. No error at all: a permission check returns nothing. */
function PermissionScreen() {
  const user = { roles: ['viewer'] };
  if (!user.roles.includes('admin')) return null;
  return <h1>Admin panel</h1>;
}

/** 4. The session expired (401); the app clears its state and shows nothing. */
function SessionScreen() {
  const [user, setUser] = useState({ name: 'Jane' });
  useEffect(() => {
    fetch('/api/session').then((r) => {
      if (r.status === 401) setUser(null);
    });
  }, []);
  if (user === null) return null;
  return <p style={{ padding: 16 }}>Welcome back, {user.name}…</p>;
}

/** 5. A white modal backdrop that opens and never closes over the real page. */
function openStuckOverlay() {
  ErrorTracker.setScreen('Checkout dialog');
  setTimeout(() => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#fff';
    document.body.style.overflow = 'hidden';
    document.body.appendChild(backdrop);
  }, OVERLAY_DELAY_MS);
}

export default function BlankScreenDemo() {
  return (
    <div>
      <h1>Blank screen scenarios</h1>
      <p>
        Each button turns the page white the way it happens to real users. Reload the page to come back.
        Then check the dashboard: what does the SDK show for each one?
      </p>
      <section>
        <button onClick={() => mountScreen('Profile', ProfileScreen)}>1. API returned unexpected data (render crash)</button>
        <button onClick={() => mountScreen('Reports', ChunkScreen)}>2. Screen code missing after deploy (chunk 404)</button>
        <button onClick={() => mountScreen('Admin', PermissionScreen)}>3. Screen renders nothing (no error)</button>
        <button onClick={() => mountScreen('Dashboard', SessionScreen)}>4. Session expired (401, app clears state)</button>
        <button onClick={openStuckOverlay}>5. White overlay that never closes</button>
      </section>
    </div>
  );
}
