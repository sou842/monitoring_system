'use client';

/** Renders different text on the server and in the browser, causing a hydration mismatch. */
export default function HydrationPage() {
  return (
    <div>
      <h1>Hydration mismatch</h1>
      <p>Rendered on: {typeof window === 'undefined' ? 'server' : 'client'}</p>
    </div>
  );
}
