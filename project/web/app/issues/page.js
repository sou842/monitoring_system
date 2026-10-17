'use client';

import { useEffect, useState } from 'react';
import { clearIssues, getIssues, subscribe } from '../../lib/issueStore';

const COLORS = { error: '#c62828', performance: '#ef6c00', message: '#1565c0', crash: '#6a1b9a' };
const SERVER_POLL_MS = 3000;

const isServer = (issue) => issue.context?.source === 'server';

export default function Issues() {
  const [browserIssues, setBrowserIssues] = useState([]);
  const [serverIssues, setServerIssues] = useState([]);
  const [openIndex, setOpenIndex] = useState(null);

  useEffect(() => {
    const load = () => setBrowserIssues(getIssues());
    load();
    return subscribe(load);
  }, []);

  // Server-side errors are kept by the /api/events receiver, not in localStorage.
  useEffect(() => {
    const load = () =>
      fetch('/api/events')
        .then((res) => res.json())
        .then((data) => setServerIssues(data.events))
        .catch(() => {});
    load();
    const timer = setInterval(load, SERVER_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const issues = [...browserIssues, ...serverIssues].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const clearAll = () => {
    clearIssues();
    fetch('/api/events', { method: 'DELETE' }).then(() => setServerIssues([]));
  };

  return (
    <div>
      <h1>Issues ({issues.length})</h1>
      <p>Events captured by the SDK, newest first. Browser issues update live; server issues every few seconds.</p>
      <button onClick={clearAll} disabled={issues.length === 0}>Clear all</button>
      {issues.length === 0 && <p>No issues yet. Trigger some from the Home page.</p>}

      {issues.map((issue, i) => (
        <div className="card" key={issue.timestamp + i}>
          <div onClick={() => setOpenIndex(openIndex === i ? null : i)} style={{ cursor: 'pointer' }}>
            <span className="badge" style={{ background: COLORS[issue.event_type] || '#555' }}>{issue.event_type}</span>
            {isServer(issue) && <span className="badge" style={{ background: '#37474f' }}>server</span>}
            <strong>{issue.error?.type}</strong>: {issue.error?.message}
            <div className="meta">
              {new Date(issue.timestamp).toLocaleString()} · {issue.error?.handled ? 'handled' : 'unhandled'} ·{' '}
              {isServer(issue) ? `${issue.context.method} ${issue.context.path}` : issue.device?.url}
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
        Page load: {perf.page_load_ms ?? '–'} ms · TTFB: {perf.ttfb_ms ?? '–'} ms · FCP: {perf.fcp_ms ?? '–'} ms · LCP: {perf.lcp_ms ?? '–'} ms · CLS: {perf.cls ?? '–'} · FPS: {perf.frame_rate_fps ?? '–'}
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
