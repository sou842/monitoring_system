'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { api, useApi } from '@/lib/client/api';
import { formatDate, timeAgo } from '@/lib/format';
import type { IssueStatus } from '@/lib/schema';
import type { ClientEvent, EventResponse, IssueResponse } from '@/lib/types';
import { Badge, Button, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { useToast } from '../../ui/Toasts';
import { Icon } from '../../ui/Icon';
import { EventDetail } from '../EventDetail';
import { Page } from '../Page';

/** Loaded on the first click on "Ask AI": the chat UI (Markdown, code highlighting) is most of the page's code. */
const AiPanel = dynamic(() => import('../AiPanel').then((m) => m.AiPanel), { ssr: false });

const STATUS_TOASTS: Record<IssueStatus, string> = { resolved: 'Issue resolved', ignored: 'Issue ignored', open: 'Issue reopened' };

function MetaItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div><span>{label}</span><b title={title}>{value}</b></div>;
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
            <button type="button" className={`ai-toggle${aiOpen ? ' active' : ''}`} aria-expanded={aiOpen} onClick={() => { setAiUsed(true); setAiOpen((o) => !o); }}>
              <Icon name="sparkles" />Ask AI
            </button>
            {issue.status !== 'resolved' ? <Button className="primary" busy={busyStatus === 'resolved'} onClick={setStatus('resolved')}>Resolve</Button> : null}
            {issue.status !== 'ignored' ? <Button busy={busyStatus === 'ignored'} onClick={setStatus('ignored')}>Ignore</Button> : null}
            {issue.status !== 'open' ? <Button busy={busyStatus === 'open'} onClick={setStatus('open')}>Reopen</Button> : null}
            <button type="button" className="danger" onClick={remove}>Delete</button>
          </div>
        </div>
        <div className="meta">
          <MetaItem label="Events" value={issue.count.toLocaleString()} />
          <MetaItem label="First seen" value={timeAgo(issue.firstSeen)} title={formatDate(issue.firstSeen)} />
          <MetaItem label="Last seen" value={timeAgo(issue.lastSeen)} title={formatDate(issue.lastSeen)} />
          <MetaItem label="Environments" value={issue.environments.join(', ') || '–'} />
          <MetaItem label="Platforms" value={issue.platforms.join(', ') || '–'} />
        </div>
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
