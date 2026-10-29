'use client';

import { useState } from 'react';
import Link from 'next/link';
import ErrorTracker from '@sourav732/error-tracker-js';
import { CRASH_LAYOUT_KEY } from '../components/LayoutCrashTrigger';
import MemoryLeakDemo from '../components/MemoryLeakDemo';

const FREEZE_MS = 1500;
const STORM_SIZE = 150;
const TIMEOUT_MS = 500;

function freezeMainThread() {
  const end = performance.now() + FREEZE_MS;
  while (performance.now() < end) {
    // Busy-wait: the page can't respond to anything until this finishes.
  }
}

function startFailingWorker() {
  const source = "setTimeout(function () { throw new Error('Image decoding failed inside worker'); }, 0);";
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  new Worker(url);
}

function loadMissingFont() {
  const face = new FontFace('Missing Brand Font', 'url(/fonts/missing-brand-font.woff2)');
  document.fonts.add(face);
  face.load().catch(() => {});
}

function loadMissingCssImage() {
  const div = document.createElement('div');
  div.style.cssText = 'width:1px;height:1px;background-image:url(/images/missing-background.png)';
  document.body.appendChild(div);
}

function loadBrokenImage() {
  const img = document.createElement('img');
  img.src = '/images/missing-photo.jpg';
  img.alt = '';
  img.style.display = 'none';
  document.body.appendChild(img);
}

function Section({ title, children }) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export default function Home() {
  const [crash, setCrash] = useState(false);
  if (crash) throw new Error('Render crash from Home page');

  return (
    <div>
      <h1>Home</h1>
      <p className="private">Private info (masked in click breadcrumbs): jane@example.com</p>

      <Section title="Runtime errors">
        <button onClick={() => { const cart = undefined; return cart.price; }}>Uncaught TypeError</button>
        <button onClick={() => Promise.reject(new Error('Unhandled rejection'))}>Unhandled rejection</button>
        <button onClick={() => {
          try { JSON.parse('{bad json'); } catch (e) { ErrorTracker.captureError(e, { source: 'home' }); }
        }}>Handled error</button>
        <button onClick={() => ErrorTracker.captureMessage('Hello from Home', 'info')}>Send message</button>
        <button onClick={() => console.error('Payment widget failed to initialise', { provider: 'stripe' })}>console.error</button>
        <button onClick={() => setCrash(true)}>Render crash</button>
        <button onClick={() => { sessionStorage.setItem(CRASH_LAYOUT_KEY, '1'); location.reload(); }}>Crash root layout</button>
      </Section>

      <Section title="API & network">
        <button onClick={() => fetch('/api/fail')}>API 500</button>
        <button onClick={() => fetch('/api/does-not-exist')}>API 404</button>
        <button onClick={() => fetch('/api/slow')}>Slow API (2.5s)</button>
        <button onClick={() => fetch('http://localhost:1/unreachable')}>Connection refused</button>
        <button onClick={() => fetch('/api/slow', { signal: AbortSignal.timeout(TIMEOUT_MS) })}>Request timeout</button>
        <button onClick={() => {
          const controller = new AbortController();
          fetch('/api/slow', { signal: controller.signal }).catch(() => {});
          controller.abort();
        }}>User-aborted request (not reported)</button>
        <button onClick={async () => {
          try { await (await fetch('/api/bad-json')).json(); } catch { /* app handles it; SDK still reports */ }
        }}>Invalid JSON response</button>
      </Section>

      <Section title="Performance">
        <button onClick={freezeMainThread}>Freeze page ({FREEZE_MS / 1000}s)</button>
        <button onClick={() => {
          for (let i = 0; i < STORM_SIZE; i++) ErrorTracker.captureMessage(`Storm error #${i}`, 'error');
        }}>Error storm ({STORM_SIZE} errors)</button>
      </Section>

      <Section title="Memory">
        <MemoryLeakDemo />
      </Section>

      <Section title="Resources & workers">
        <button onClick={loadBrokenImage}>Broken &lt;img&gt;</button>
        <button onClick={loadMissingCssImage}>Missing CSS background image</button>
        <button onClick={loadMissingFont}>Missing web font</button>
        <button onClick={startFailingWorker}>Web Worker error</button>
      </Section>

      <Section title="Other pages">
        <Link href="/wrong_path">Wrong path</Link> ·{' '}
        <a href="/abouts">Typo URL (/abouts, full page load)</a> ·{' '}
        <Link href="/hydration">Hydration mismatch</Link> · <Link href="/csp">CSP violation</Link> ·{' '}
        <Link href="/blank">Blank screen</Link> ·{' '}
        <a href="/server-error">Server component error</a> ·{' '}
        <button onClick={() => fetch('/api/crash')}>Server API crash</button>
      </Section>
    </div>
  );
}
