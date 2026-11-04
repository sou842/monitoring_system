'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, useApi } from '@/lib/client/api';
import { formatDate, timeAgo } from '@/lib/format';
import type { IssueStatus } from '@/lib/schema';
import type { ClientEvent, EventResponse, ImpactValue, IssueImpact, IssueResponse } from '@/lib/types';
import { Badge, Button, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toasts';
import { Icon } from '../../ui/Icon';
import { EventDetail } from '../EventDetail';
import { Page } from '../Page';
import { useSession } from '../Shell';

/** Loaded on the first click on "Ask AI": the chat UI (Markdown, code highlighting) is most of the page's code. */
const AiPanel = dynamic(() => import('../AiPanel').then((m) => m.AiPanel), { ssr: false });

/** Same breakpoint as the CSS that moves the page aside for the panel. */
const AI_SIDE_BY_SIDE = '(min-width: 1100px)';

const STATUS_TOASTS: Record<IssueStatus, string> = { resolved: 'Issue resolved', ignored: 'Issue ignored', open: 'Issue reopened' };

function MetaItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div><span>{label}</span><b title={title}>{value}</b></div>;
}

const percent = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '');

/** A page URL shown as its path; screen names and other text stay as they are. */
function shortScreen(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

/** "Chrome 156 80% · Edge 140 20%"; "not set" when no event had a value. */
function topValues(rows: ImpactValue[], total: number, show: (v: string) => string = (v) => v): string {
  if (rows.length === 0 || (rows.length === 1 && rows[0].value === '(none)')) return 'not set';
  return rows.map((r) => `${show(r.value)} ${percent(r.count, total)}`).join(' · ');
}

/** Who and where the issue hits, over its newest stored events (server/impact.ts). */
function ImpactRow({ impact, total }: { impact: IssueImpact; total: number }) {
  if (impact.sampled === 0) return null;
  const n = impact.sampled;
  const scope = n < total ? `the newest ${n.toLocaleString()} stored events` : `all ${n.toLocaleString()} stored events`;
  const users = impact.users > 0
    ? `${impact.users.toLocaleString()}${impact.anonymous > 0 ? ` + ${percent(impact.anonymous, n)} anonymous` : ''}`
    : impact.anonymous > 0 ? 'not identified' : '–';
  return (
    <div className="meta impact" aria-label={`Impact over ${scope}`}>
      <MetaItem label="Users" value={users} title={`Distinct user ids (setUser) in ${scope}; ${impact.anonymous.toLocaleString()} event(s) had none.`} />
      <MetaItem label="Top screens" value={topValues(impact.screens, n, shortScreen)} title={`setScreen() name, else the page URL, in ${scope}`} />
      <MetaItem label="Browsers" value={topValues(impact.browsers, n)} title={`In ${scope}`} />
      <MetaItem label="App versions" value={topValues(impact.versions, n)} title={`appVersion from init(), in ${scope}`} />
      {impact.offline > 0 ? (
        <MetaItem label="Offline" value={`${percent(impact.offline, impact.withSituation)} of events`} title={`${impact.offline} of ${impact.withSituation} events from SDK 0.11.0+ happened while the device was offline`} />
      ) : null}
      {impact.duringPageLoad > 0 ? (
        <MetaItem label="While loading" value={`${percent(impact.duringPageLoad, impact.withSituation)} of events`} title={`${impact.duringPageLoad} of ${impact.withSituation} events from SDK 0.11.0+ happened before the page finished loading`} />
      ) : null}
    </div>
  );
}

/** One issue with its latest events; `?event=<id>` picks which event is shown in full. */
export function IssueView({ issueId }: { issueId: string }) {
  const router = useRouter();
  const query = useSearchParams();
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const [busyStatus, setBusyStatus] = useState<IssueStatus | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  // Stays true after closing, so the chat survives closing and reopening the panel.
  const [aiUsed, setAiUsed] = useState(false);
  const closeAi = useCallback(() => setAiOpen(false), []);
  const { collapseForPanel } = useSession();
  // Where the panel sits next to the page (wide screens), fold the sidebar to give the page room.
  useEffect(() => {
    if (!aiOpen || !window.matchMedia(AI_SIDE_BY_SIDE).matches) return;
    collapseForPanel(true);
    return () => collapseForPanel(false);
  }, [aiOpen, collapseForPanel]);

  const issueState = useApi<IssueResponse>(`/api/issue?id=${encodeURIComponent(issueId)}`);
  const data = issueState.data;
  const selectedId = query.get('event') || (data && data.latestEvent ? data.latestEvent.id : null);
  const selectedIsLatest = Boolean(data && data.latestEvent && data.latestEvent.id === selectedId);
  const eventState = useApi<EventResponse>(data && selectedId && !selectedIsLatest ? `/api/event?id=${encodeURIComponent(selectedId)}` : null);
  const event = (selectedIsLatest && data ? data.latestEvent : eventState.data?.event) as ClientEvent | null | undefined;

  const crumbs = [
    { label: 'Projects', href: '/projects' },
    ...(data && data.project ? [{ label: data.project.name, href: `/projects/${data.project.id}` }] : []),
    ...(data ? [{ label: data.issue.errorType }] : []),
  ];

  if (issueState.error) return <Page crumbs={crumbs}><ErrorNotice error={issueState.error} /></Page>;
  if (!data) return <Page crumbs={crumbs}><Loading /></Page>;
  // What this account may do in the issue's project (the server checks again).
  const can = { ai: data.access.permissions.includes('ai.use'), update: data.access.permissions.includes('issues.update'), remove: data.access.permissions.includes('issues.delete') };
  const { issue } = data;
  const projectHref = data.project ? `/projects/${data.project.id}` : '/projects';

  const setStatus = (status: IssueStatus) => action(async () => {
    setBusyStatus(status);
    try {
      await api(`/api/issue?id=${issueId}`, { method: 'PATCH', body: { status } });
      toast(STATUS_TOASTS[status]);
    } finally {
      setBusyStatus(null);
    }
  });

  const remove = action(async () => {
    const ok = await openDialog({
      title: 'Delete this issue?',
      message: `The issue and its ${issue.count.toLocaleString()} event(s) will be deleted. If the error happens again, it comes back as a new issue.`,
      confirmText: 'Delete issue',
      danger: true,
      onConfirm: () => api(`/api/issue?id=${issueId}`, { method: 'DELETE' }),
    });
    if (!ok) return;
    toast('Issue deleted');
    router.push(projectHref);
  });

  return (
    <Page crumbs={crumbs}>
      <div className="card card-body">
        <div className="issue-header">
          <div className="title">
            <div className="row">
              <Badge text={issue.eventType} />
              <Badge text={issue.status} />
              {issue.regressedAt && issue.status === 'open' ? <Badge text="regressed" kind="error" /> : null}
            </div>
            <h1>{issue.errorType}</h1>
            <div className="message">{issue.message || '(no message)'}</div>
            {issue.culprit ? <div className="culprit mono small">{issue.culprit}</div> : null}
          </div>
          <div className="row">
            {can.ai ? (
              <button type="button" className={`ai-toggle${aiOpen ? ' active' : ''} rounded-full`} aria-expanded={aiOpen} onClick={() => { setAiUsed(true); setAiOpen((o) => !o); }}>
                <Icon name="ghost" />Ask AI
              </button>
            ) : null}
            {can.update && issue.status !== 'resolved' ? <Button className="primary rounded-full" busy={busyStatus === 'resolved'} onClick={setStatus('resolved')}>Resolve</Button> : null}
            {can.update && issue.status !== 'ignored' ? <Button className="rounded-full" busy={busyStatus === 'ignored'} onClick={setStatus('ignored')}>Ignore</Button> : null}
            {can.update && issue.status !== 'open' ? <Button className="rounded-full" busy={busyStatus === 'open'} onClick={setStatus('open')}>Reopen</Button> : null}
            {can.remove ? <button type="button" className="danger rounded-full" onClick={remove}>Delete</button> : null}
          </div>
        </div>
        <div className="meta">
          <MetaItem label="Events" value={issue.count.toLocaleString()} />
          <MetaItem label="First seen" value={timeAgo(issue.firstSeen)} title={formatDate(issue.firstSeen)} />
          <MetaItem label="Last seen" value={timeAgo(issue.lastSeen)} title={formatDate(issue.lastSeen)} />
          <MetaItem label="Environments" value={issue.environments.join(', ') || '–'} />
          <MetaItem label="Platforms" value={issue.platforms.join(', ') || '–'} />
        </div>
        {data.impact ? <ImpactRow impact={data.impact} total={issue.count} /> : null}
      </div>

      <div className="detail">
        <div>
          <h2>Latest events ({data.events.length})</h2>
          <div className="card events-list">
            {data.events.map((e) => (
              <button
                key={e.id}
                type="button"
                className={e.id === selectedId ? 'active' : ''}
                onClick={() => router.push(`/issues/${issueId}?event=${e.id}`, { scroll: false })}
              >
                <div title={formatDate(e.receivedAt)}>{timeAgo(e.receivedAt)}</div>
                <div className="muted small">{[e.screen, e.environment, e.browser, e.userId ? `user ${e.userId}` : null].filter(Boolean).join(' · ')}</div>
              </button>
            ))}
          </div>
        </div>
        {!selectedId ? (
          <EmptyState icon="inbox" title="No events stored" text="Older events are deleted after 30 days." />
        ) : eventState.error ? (
          <ErrorNotice error={eventState.error} />
        ) : event ? (
          <EventDetail key={event.id} event={event} insightSettings={data.project ? data.project.insights : null} />
        ) : (
          <Loading />
        )}
      </div>
      {aiUsed ? <AiPanel key={issueId} issueId={issueId} eventId={selectedId} open={aiOpen} onClose={closeAi} /> : null}
    </Page>
  );
}
