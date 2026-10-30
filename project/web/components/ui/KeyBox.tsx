'use client';

import { useEffect, useState } from 'react';
import { setupSnippet } from '@/lib/format';
import { CopyButton } from './bits';

/** This site's origin once in the browser (the SDK endpoint lives here). */
export function useOrigin(): string {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

/** Shows a just-issued API key once, with a ready-to-paste setup snippet. */
export function KeyBox({ title, apiKey, onDone }: { title: string; apiKey: string; onDone: () => void }) {
  const snippet = setupSnippet(apiKey, useOrigin());
  return (
    <div className="card card-body section">
      <h2>{title}</h2>
      <p className="my-3">Copy this API key now. For security it is stored hashed and cannot be shown again.</p>
      <div className="key-box row">
        <code>{apiKey}</code>
        <span className="spacer" />
        <CopyButton text={apiKey} label="Copy key" />
      </div>
      <p className="muted section">Add the SDK to your app:</p>
      <div className="key-box">
        <pre>{snippet}</pre>
      </div>
      <div className="row section">
        <CopyButton text={snippet} label="Copy setup code" />
        <span className="spacer" />
        <button type="button" className="primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
