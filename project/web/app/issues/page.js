'use client';

import { useEffect, useState } from 'react';
import { clearIssues, getIssues, subscribe } from '../../lib/issueStore';

const COLORS = { error: '#c62828', performance: '#ef6c00', message: '#1565c0', crash: '#6a1b9a' };

export default function Issues() {
  const [issues, setIssues] = useState([]);
  const [openIndex, setOpenIndex] = useState(null);

  useEffect(() => {
    const load = () => setIssues(getIssues());
    load();
    return subscribe(load);
  }, []);

  return (
    <div>
      <h1>Issues ({issues.length})</h1>
      <p>Events captured by the SDK in this browser, newest first. Updates live.</p>
      <button onClick={clearIssues} disabled={issues.length === 0}>Clear all</button>
      {issues.length === 0 && <p>No issues yet. Trigger some from the Home page.</p>}

      {issues.map((issue, i) => (
        <div className="card" key={issue.timestamp + i}>
          <div onClick={() => setOpenIndex(openIndex === i ? null : i)} style={{ cursor: 'pointer' }}>
            <span className="badge" style={{ background: COLORS[issue.event_type] || '#555' }}>{issue.event_type}</span>
            <strong>{issue.error?.type}</strong>: {issue.error?.message}
            <div className="meta">
              {new Date(issue.timestamp).toLocaleString()} · {issue.error?.handled ? 'handled' : 'unhandled'} · {issue.device?.url}
            </div>
          </div>
          {openIndex === i && <IssueDetails issue={issue} />}
        </div>
      ))}
    </div>
  );
}

function IssueDetails({ issue }) {
  const perf = issue.performance || {};
  const mem = issue.memory || {};
  return (
    <div className="details">
      {issue.stacktrace?.length > 0 && (
        <>
          <h4>Stack trace</h4>
          <pre>{issue.stacktrace.map((f) => `at ${f.function} (${f.filename}:${f.lineno}:${f.colno})`).join('\n')}</pre>
        </>
      )}

      <h4>Breadcrumbs ({issue.breadcrumbs?.length || 0})</h4>
      <ul>
        {(issue.breadcrumbs || []).slice().reverse().map((b, i) => (
          <li key={i}>
            <code>{new Date(b.timestamp).toLocaleTimeString()}</code> [{b.type}] {b.message}
          </li>
        ))}
      </ul>

      <h4>Performance</h4>
      <p>
        Page load: {perf.page_load_ms ?? '–'} ms · TTFB: {perf.ttfb_ms ?? '–'} ms · FCP: {perf.fcp_ms ?? '–'} ms · LCP: {perf.lcp_ms ?? '–'} ms · CLS: {perf.cls ?? '–'}
        {perf.slow_screen && ' · ⚠️ slow page'}
      </p>
      {perf.slow_api_calls?.length > 0 && (
        <p>Slow API calls: {perf.slow_api_calls.map((c) => `${c.method} ${c.url} (${c.duration_ms} ms)`).join(', ')}</p>
      )}

      <h4>Memory</h4>
      <p>
        Used: {mem.used_mb ?? '–'} MB · Total: {mem.total_mb ?? '–'} MB{mem.leak_suspected && ' · ⚠️ leak suspected'}
      </p>

      <h4>User & device</h4>
      <p>
        User: {issue.user?.id ?? 'anonymous'} · {issue.device?.browser} {issue.device?.browser_version} · {issue.device?.os} ·{' '}
        {issue.device?.screen_width}×{issue.device?.screen_height} · {issue.environment} · v{issue.app_version}
      </p>

      {issue.context && (
        <>
          <h4>Context</h4>
          <pre>{JSON.stringify(issue.context, null, 2)}</pre>
        </>
      )}

      {issue.screenshot && (
        <>
          <h4>Screenshot</h4>
          <img src={issue.screenshot} alt="Screenshot at time of error" style={{ maxWidth: '100%', border: '1px solid #ccc' }} />
        </>
      )}
    </div>
  );
}
