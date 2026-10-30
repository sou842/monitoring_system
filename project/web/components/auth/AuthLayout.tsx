'use client';

import type { ReactNode } from 'react';
import { SDK_PACKAGE } from '@/lib/format';
import { ICONS } from '../ui/Icon';
import { useOrigin } from '../ui/KeyBox';
import { ThemeToggle } from '../ui/ThemeToggle';

const AUTH_FEATURES: Array<[string, string]> = [
  ['Every error, grouped', 'Uncaught exceptions, failed requests and crashes, grouped into issues with stack traces and breadcrumbs.'],
  ['Performance & 404s', 'Slow pages, slow API calls, frozen UIs, memory leaks and missing pages, out of the box.'],
  ['Private by default', 'Your projects and their data are visible only to your account.'],
];

/** Split layout for log in / sign up: product intro on the left, the form card on the right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  const origin = useOrigin();
  const snippet = [`import ErrorTracker from '${SDK_PACKAGE}';`, '', 'ErrorTracker.init({', "  apiKey: 'et_…',", `  endpoint: '${origin}/api/v1/events',`, '});'].join('\n');
  return (
    <div className="auth">
      <section className="auth-hero" aria-label="About Error Tracker">
        <div className="brand"><span className="brand-mark" />ERROR TRACKER</div>
        <div className="auth-pitch">
          <p className="eyebrow">Error monitoring for web apps</p>
          <h2 className="auth-headline">Know about every error before your users report it.</h2>
          <ul className="auth-features">
            {AUTH_FEATURES.map(([title, text]) => (
              <li key={title}>
                <span className="feature-icon">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS.check} /></svg>
                </span>
                <div><b>{title}</b><span>{text}</span></div>
              </li>
            ))}
          </ul>
          <div className="auth-code">
            <div className="auth-code-head"><i /><i /><i /><span>app.js</span></div>
            <pre>{snippet}</pre>
          </div>
        </div>
        <p className="auth-foot">Free to use · Zero-dependency SDK · Set up in two minutes</p>
      </section>
      <div className="auth-main">
        <div className="auth-top">
          <div className="brand auth-brand-mobile"><span className="brand-mark" />ERROR TRACKER</div>
          <span className="spacer" />
          <ThemeToggle />
        </div>
        <div className="auth-card">{children}</div>
      </div>
    </div>
  );
}
