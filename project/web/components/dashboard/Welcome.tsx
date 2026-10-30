'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { firstName, SDK_PACKAGE } from '@/lib/format';
import { useSession } from './Shell';

function Step({ n, title, text, children }: { n: number; title: string; text: string; children?: ReactNode }) {
  return (
    <li className="step">
      <span className="step-n">{n}</span>
      <div>
        <b>{title}</b>
        <p className="muted">{text}</p>
        {children}
      </div>
    </li>
  );
}

/** First-run guide for an account with no projects yet. */
export function Welcome() {
  const router = useRouter();
  const { user } = useSession();
  return (
    <div className="card welcome">
      <p className="eyebrow">Getting started</p>
      <h1>Welcome, {firstName(user)}</h1>
      <p className="muted welcome-sub">Three steps to your first tracked error. Charts and issues appear here as soon as events arrive.</p>
      <ol className="steps">
        <Step n={1} title="Create a project" text="Each app gets its own project and API key.">
          <button type="button" className="primary" onClick={() => router.push('/projects?new=1')}>Create a project</button>
        </Step>
        <Step n={2} title="Install the SDK" text="Add the package and call init() as early as possible in your app.">
          <div className="key-box"><pre>{`npm install ${SDK_PACKAGE}`}</pre></div>
        </Step>
        <Step n={3} title="Watch errors arrive" text="Errors, slow pages, failed requests and crashes show up grouped into issues, with stack traces and breadcrumbs." />
      </ol>
    </div>
  );
}
