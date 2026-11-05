'use client';

import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, useApi } from '@/lib/client/api';
import { formatDate, timeAgo } from '@/lib/format';
import type { IssueStatus } from '@/lib/schema';
import type { ClientEvent, EventResponse, ImpactValue, IssueImpact, IssueResponse } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { Badge, CARD, toneOfKind } from '../../ui/kit';
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

/** A label over a value, for the slim strip under the title. */
function Stat({ label, value, title, sub }: { label: string; value: string; title?: string; sub?: string }) {
  return (
    <div className="min-w-0 sm:px-4 sm:first:pl-0 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-line" title={title}>
      <div className="text-[10px] font-semibold tracking-wider text-muted uppercase">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}{sub ? <span className="ml-1.5 text-[11px] font-normal text-muted">{sub}</span> : null}</div>
    </div>
  );
}

/** One breakdown ("Top screens"): each value with a bar for its share of the events. */
function Distribution({ title, rows, total, show = (v) => v, hint }: { title: string; rows: ImpactValue[]; total: number; show?: (v: string) => string; hint: string }) {
  const empty = rows.length === 0 || (rows.length === 1 && rows[0].value === '(none)');
  return (
    <div className="min-w-0" title={hint}>
      <h4 className="m-0 mb-2.5 text-[10.5px] font-semibold tracking-wider text-muted uppercase">{title}</h4>
      {empty ? <p className="m-0 text-[13px] text-muted">not set</p> : (
        <ul className="m-0 grid list-none gap-2.5 p-0">
          {rows.map((r) => {
            const share = total > 0 ? (r.count / total) * 100 : 0;
            return (
              <li key={r.value} className="min-w-0">
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="truncate" title={show(r.value)}>{show(r.value)}</span>
                  <span className="shrink-0 text-xs text-muted tabular-nums">{percent(r.count, total)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-(--chip)">
                  <div className="h-full rounded-full bg-(--bar)" style={{ width: `${Math.max(share, 2)}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The biggest share of a breakdown as one line: "Chrome 156 80%" (+ "+2 more"); null when nothing was recorded. */
function topShare(rows: ImpactValue[], total: number, show: (v: string) => string): string | null {
  if (rows.length === 0 || (rows.length === 1 && rows[0].value === '(none)')) return null;
  const first = rows[0];
  return `${show(first.value)} ${percent(first.count, total)}${rows.length > 1 ? ` +${rows.length - 1}` : ''}`;
}

/** Who and where the issue hits, over its newest stored events (server/impact.ts): one summary line, bars on demand. */
function ImpactPanel({ impact, total }: { impact: IssueImpact; total: number }) {
  const [open, setOpen] = useState(false);
  if (impact.sampled === 0) return null;
  const n = impact.sampled;
  const scope = n < total ? `the newest ${n.toLocaleString()} stored events` : `all ${n.toLocaleString()} stored events`;
  const summary: Array<[string, string | null]> = [
    ['Screen', topShare(impact.screens, n, shortScreen)],
    ['Browser', topShare(impact.browsers, n, (v) => v)],
    ['Version', topShare(impact.versions, n, (v) => v)],
  ];
  return (
    <div className="mt-4 border-t border-line pt-3" aria-label={`Impact over ${scope}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* <span className="text-[10px] font-semibold tracking-wider text-muted uppercase">Who it affects</span> */}
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {summary.map(([label, text]) => (
            <span key={label} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-panel-2 px-2.5 py-1 text-xs" title={`${label}, in ${scope}`}>
              <span className="text-muted">{label}</span><span className="truncate font-medium">{text ?? 'not set'}</span>
            </span>
          ))}
          {impact.offline > 0 ? <Badge tone="amber">{percent(impact.offline, impact.withSituation)} offline</Badge> : null}
          {impact.duringPageLoad > 0 ? <Badge tone="amber">{percent(impact.duringPageLoad, impact.withSituation)} while loading</Badge> : null}
        </div>
        <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)} className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-muted shadow-none hover:text-fg">
          {open ? 'Hide breakdown' : 'Breakdown'}<Icon name="chevron" className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open ? (
        <div className="mt-4 grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          <Distribution title="Top screens" rows={impact.screens} total={n} show={shortScreen} hint={`setScreen() name, else the page URL, in ${scope}`} />
          <Distribution title="Browsers" rows={impact.browsers} total={n} hint={`In ${scope}`} />
          <Distribution title="App versions" rows={impact.versions} total={n} hint={`appVersion from init(), in ${scope}`} />
        </div>
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

  const impact = data.impact;
  const users = impact && impact.users > 0 ? impact.users.toLocaleString() : impact && impact.anonymous > 0 ? 'not identified' : '–';
  const usersSub = impact && impact.users > 0 && impact.anonymous > 0 ? `+ ${percent(impact.anonymous, impact.sampled)} anonymous` : undefined;

  return (
    <Page crumbs={crumbs}>
      <section className={cn(CARD, 'px-5 py-4')}>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-80">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="m-0 text-lg font-semibold tracking-tight break-words">{issue.errorType}</h1>
              <Badge tone={toneOfKind(issue.eventType)} className="capitalize">{issue.eventType}</Badge>
              <Badge tone={toneOfKind(issue.status)} className="capitalize">{issue.status}</Badge>
              {issue.regressedAt && issue.status === 'open' ? <Badge tone="solid">Regressed</Badge> : null}
            </div>
            <p className="m-0 mt-1 line-clamp-2 text-[13px] break-words text-fg-2" title={issue.message}>{issue.message || '(no message)'}</p>
            {issue.culprit ? <div className="mt-1.5 truncate font-mono text-xs text-muted" title={issue.culprit}>{issue.culprit}</div> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
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

        <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3.5 min-[480px]:grid-cols-3 sm:flex sm:flex-wrap">
          <Stat label="Events" value={issue.count.toLocaleString()} />
          <Stat label="Users" value={users} sub={usersSub} title={impact ? `Distinct user ids (setUser) in the newest ${impact.sampled.toLocaleString()} stored events; ${impact.anonymous.toLocaleString()} event(s) had none.` : undefined} />
          <Stat label="First seen" value={timeAgo(issue.firstSeen)} title={formatDate(issue.firstSeen)} />
          <Stat label="Last seen" value={timeAgo(issue.lastSeen)} title={formatDate(issue.lastSeen)} />
          <Stat label="Environments" value={issue.environments.join(', ') || '–'} />
          <Stat label="Platforms" value={issue.platforms.join(', ') || '–'} />
        </div>

        {impact ? <ImpactPanel impact={impact} total={issue.count} /> : null}
      </section>

      <div className="issue-split mt-4">
        <aside className="min-w-0">
          <div className={cn(CARD, 'issue-events overflow-hidden')}>
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="m-0 text-[13px] font-semibold">Latest events</h2>
              <Badge tone="muted">{data.events.length}</Badge>
            </div>
            <div className="issue-events-scroll overflow-y-auto">
              {data.events.map((e) => {
                const on = e.id === selectedId;
                const bits = [e.screen, e.environment, e.browser, e.userId ? `user ${e.userId}` : null].filter(Boolean);
                return (
                  <button
                    key={e.id}
                    type="button"
                    aria-current={on ? 'true' : undefined}
                    onClick={() => router.push(`/issues/${issueId}?event=${e.id}`, { scroll: false })}
                    className={cn(
                      'relative block w-full cursor-pointer rounded-none border-0 border-t border-line px-4 py-3 text-left shadow-none transition-colors first:border-t-0',
                      on ? 'bg-(--accent-soft) shadow-[inset_3px_0_0_var(--accent)]' : 'bg-transparent hover:bg-(--hover)',
                    )}
                  >
                    <div className="text-[13px] font-medium" title={formatDate(e.receivedAt)}>{timeAgo(e.receivedAt)}</div>
                    {bits.length > 0 ? <div className="mt-0.5 truncate text-xs text-muted">{bits.join(' · ')}</div> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
        <div className="min-w-0">
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
      </div>
      {aiUsed ? <AiPanel key={issueId} issueId={issueId} eventId={selectedId} open={aiOpen} onClose={closeAi} /> : null}
    </Page>
  );
}
