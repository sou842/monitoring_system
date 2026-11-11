'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { formatDate, timeAgo } from '@/lib/format';
import { analyzeEvent, frameLabel, stackText, type ClassifiedFrame, type FrameKind, type Insight } from '@/lib/insights';
import type { Serialized, EventPayload, StackFrame } from '@/lib/schema';
import type { ClientEvent, InsightSettingsView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CopyButton } from '../ui/bits';
import { columnHelper, DataTable, type DataColumnMeta } from '../ui/DataTable';
import { Icon } from '../ui/Icon';
import { Badge, CARD, pillButton, TabBar, toneOfKind } from '../ui/kit';

type Payload = Serialized<EventPayload>;
type Frame = ClassifiedFrame<StackFrame>;
type Jump = (path: string) => void;
type ApiCall = Payload['performance']['api_calls'][number];

const FRAME_KIND_LABELS: Partial<Record<FrameKind, string>> = { app: 'your code', native: 'browser', hidden: 'hidden' };
/** How many "last moments" the overview shows before pointing to the Breadcrumbs tab. */
const OVERVIEW_MOMENTS = 8;
/** Fact text longer than this takes a whole row of the overview grid. */
const WIDE_FACT_CHARS = 70;

type TabId = 'overview' | 'stack' | 'trail' | 'details' | 'performance' | 'json';

const TONE_TEXT: Record<string, string> = { bad: 'text-danger', warn: 'text-amber', user: 'font-semibold' };

/** Small caps label used above values. */
const LABEL = 'text-[10.5px] font-semibold tracking-wider text-muted uppercase';

/** Label/value rows; empty values are left out. */
function KeyValues({ rows }: { rows: Array<[string, string | number | null | undefined]> }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (shown.length === 0) return <p className="m-0 text-[13px] text-muted">Nothing recorded.</p>;
  return (
    <dl className="m-0 grid grid-cols-[104px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px] max-sm:grid-cols-1 max-sm:gap-y-0.5">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted max-sm:mt-2">{label}</dt>
          <dd className="m-0 break-words">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Device, session and network ids of one event, each with a link to every issue
 * in the project that has events from it (the issues search matches these ids).
 */
function OriginIds({ event, projectId }: { event: ClientEvent; projectId: string | null }) {
  const rows: Array<[string, string | null, string]> = [
    ['Device', event.payload.device.id ?? event.deviceId ?? null, 'Random id this browser keeps (SDK 0.12.0+). Same id = same browser on the same machine.'],
    ['Session', event.payload.session_id ?? event.sessionId ?? null, 'One visit: the same tab, reloads included, until 30 minutes without activity.'],
    ['Network', event.networkId ?? null, 'Hashed IP network the event was sent from (never the IP). Shared by everyone behind the same office or home connection.'],
  ];
  const shown = rows.filter((r): r is [string, string, string] => Boolean(r[1]));
  if (shown.length === 0) return <p className="m-0 text-[13px] text-muted">Not recorded (sent by an SDK older than 0.12.0).</p>;
  return (
    <dl className="m-0 grid grid-cols-[104px_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px] max-sm:grid-cols-1 max-sm:gap-y-0.5">
      {shown.map(([label, id, help]) => (
        <div key={label} className="contents">
          <dt className="text-muted max-sm:mt-2" title={help}>{label}</dt>
          <dd className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="mono truncate text-xs" title={id}>{id}</span>
            {projectId ? (
              <Link className="text-xs whitespace-nowrap underline underline-offset-2" href={`/projects/${projectId}?status=all&q=${encodeURIComponent(id)}`}>
                All issues from this {label.toLowerCase()}
              </Link>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A titled block inside a tab. */
function Block({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-panel p-4', className)}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * `JSON.stringify(value, null, 2)` as React nodes (same text), with every array item and
 * top-level field wrapped in a span marked by its path ("breadcrumbs.3", "stacktrace.0",
 * "error"), so rows on the issue page can jump to their place in the raw JSON.
 */
function jsonNodes(value: unknown, path = '', indent = ''): ReactNode[] {
  const inner = `${indent}  `;
  const wrap = (child: unknown, childPath: string) => (
    <span key={childPath} className="json-item" data-json-path={childPath}>{jsonNodes(child, childPath, inner)}</span>
  );
  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]'];
    const out: ReactNode[] = ['[\n'];
    value.forEach((item: unknown, i) => out.push(inner, wrap(item, path ? `${path}.${i}` : String(i)), i < value.length - 1 ? ',\n' : '\n'));
    out.push(`${indent}]`);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined && typeof record[key] !== 'function');
    if (keys.length === 0) return ['{}'];
    const out: ReactNode[] = ['{\n'];
    keys.forEach((key, i) => {
      const child = path === '' ? [wrap(record[key], key)] : jsonNodes(record[key], `${path}.${key}`, inner);
      out.push(`${inner}${JSON.stringify(key)}: `, ...child, i < keys.length - 1 ? ',\n' : '\n');
    });
    out.push(`${indent}}`);
    return out;
  }
  return [JSON.stringify(value)];
}

/** Props that make a row jump to `path` in the raw JSON on click, Enter or Space. */
function jumpProps(path: string, jump: Jump, className = '') {
  return {
    className: `${className} jump`.trim(),
    role: 'button',
    tabIndex: 0,
    title: 'Show in the raw event JSON',
    onClick: () => jump(path),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      jump(path);
    },
  };
}

interface TimelineItem {
  key: string;
  time: string;
  type: string;
  message: string;
  tone: string;
  /** The error itself (first row of the overview). */
  error?: boolean;
  path?: string;
}

/** A vertical timeline: dot per row, time and type on top, the message under them. Rows with a `path` jump to the raw JSON. */
function Timeline({ items, jump }: { items: TimelineItem[]; jump: Jump }) {
  return (
    <ol className="relative m-0 list-none p-0">
      <span className="absolute top-2 bottom-2 left-[5px] w-px bg-line" aria-hidden="true" />
      {items.map((item) => {
        const body = (
          <>
            <span className={cn('absolute top-[13px] left-0 size-[11px] rounded-full border-2 border-panel', item.error ? 'bg-danger' : item.tone === 'bad' ? 'bg-danger' : item.tone === 'warn' ? 'bg-amber' : item.tone === 'user' ? 'bg-fg' : 'bg-line-strong')} aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-muted tabular-nums">{item.time || '–'}</span>
              <Badge tone={toneOfKind(item.error ? 'error' : 'info')} className="capitalize">{item.type}</Badge>
            </div>
            <div className={cn('mt-1 text-[13px] break-words', item.error ? 'font-semibold text-danger' : TONE_TEXT[item.tone])}>{item.message}</div>
          </>
        );
        const cls = 'relative block rounded-lg py-2 pr-2 pl-6';
        return (
          <li key={item.key}>
            {item.path ? <div {...jumpProps(item.path, jump, cn(cls, 'hover:bg-(--hover)'))}>{body}</div> : <div className={cls}>{body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** A small heading above a group on the overview. */
function GroupTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="m-0 text-[11px] font-semibold tracking-wider text-muted uppercase">{children}</h3>
      {aside}
    </div>
  );
}

/** Who, where and on what the event happened: the facts a reader wants first, from the payload itself. */
function QuickFacts({ payload, receivedAt }: { payload: Payload; receivedAt: string | Date }) {
  const d = payload.device;
  const user = payload.user.name || payload.user.email || payload.user.id;
  const items: Array<[string, string | null, string?]> = [
    ['When', timeAgo(receivedAt), formatDate(receivedAt)],
    ['Handled', payload.error ? (payload.error.handled ? 'Yes, caught by the app' : 'No, uncaught') : null],
    ['Screen', payload.screen || null],
    ['Page', d.url ? shortUrl(d.url) : null, d.url || undefined],
    ['User', user || null, [payload.user.id, payload.user.name, payload.user.email].filter(Boolean).join(' · ') || undefined],
    ['Browser', [d.browser, d.browser_version].filter(Boolean).join(' ') || null],
    ['OS / device', [d.os, d.os_version].filter(Boolean).join(' ') || [d.manufacturer, d.model].filter(Boolean).join(' ') || null],
    ['Device id', d.id ? d.id.slice(0, 8) : null, d.id ? `${d.id} (same id = same browser; full ids under Details)` : undefined],
    ['Screen size', d.screen_width ? `${d.screen_width} × ${d.screen_height}` : null],
    ['App version', payload.app_version],
    ['Environment', payload.environment],
  ];
  const shown = items.filter((i): i is [string, string, string?] => Boolean(i[1]));
  if (shown.length === 0) return null;
  return (
    <section aria-label="This event">
      <GroupTitle>This event</GroupTitle>
      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(min(100%,168px),1fr))] overflow-hidden rounded-2xl border border-line bg-panel">
        {shown.map(([label, value, title]) => (
          <div key={label} className="min-w-0 border-r border-b border-line px-3.5 py-2.5 [margin:0_-1px_-1px_0]" title={title}>
            <dt className="text-[10px] font-semibold tracking-wider text-muted uppercase">{label}</dt>
            <dd className="m-0 mt-0.5 truncate text-[13px] font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** "file:line:col" of a frame, for copying. */
function locationOf(frame: StackFrame): string {
  return `${frame.filename || '?'}${frame.lineno !== null ? ':' + frame.lineno : ''}${frame.colno !== null ? ':' + frame.colno : ''}`;
}

/** Path of a page URL (the host is the same for every event of an app). */
function shortUrl(value: string): string {
  try {
    const u = new URL(value);
    return `${u.pathname}${u.hash}` || '/';
  } catch {
    return value;
  }
}

/** Overview: where to look, this event's facts, what the analysis found, hints and the last moments. */
function OverviewTab({ insight, payload, receivedAt, jump, showTrail, showStack }: { insight: Insight<StackFrame> | null; payload: Payload; receivedAt: string | Date; jump: Jump; showTrail: () => void; showStack: () => void }) {
  const look = insight ? insight.whereToLook : null;
  const errorText = payload.error ? `${payload.error.type}: ${payload.error.message}` : payload.event_type;
  const reversed = insight ? insight.moments.slice().reverse() : [];
  const moments: TimelineItem[] = [
    { key: 'error', time: '0 s', type: payload.event_type, message: errorText, tone: 'bad', error: true, path: payload.error ? 'error' : 'event_type' },
    ...reversed.slice(0, OVERVIEW_MOMENTS).map((m, i) => ({
      key: `${m.index}-${i}`,
      time: m.when || (m.at ? new Date(m.at).toLocaleTimeString() : ''),
      type: m.type,
      message: m.message,
      tone: m.tone || '',
      path: m.index >= 0 ? `breadcrumbs.${m.index}` : undefined,
    })),
  ];
  const hidden = reversed.length - OVERVIEW_MOMENTS;
  const facts = insight ? insight.facts : [];
  const hints = insight ? insight.hints : [];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {look ? (
        <section aria-label="Where to look">
          <GroupTitle>Where to look</GroupTitle>
          <div className="overflow-hidden rounded-2xl border border-line bg-panel">
            <div {...jumpProps(`stacktrace.${payload.stacktrace.indexOf(look.frame)}`, jump, 'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 hover:bg-(--hover)')}>
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-sm font-semibold break-all">{frameLabel(look.frame)}</code>
                  <Badge tone="neutral">your code</Badge>
                </div>
                {look.frame.filename ? (
                  <div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted">
                    <span className="truncate" title={locationOf(look.frame)}>{look.frame.filename}</span>
                    {look.frame.lineno !== null ? <span className="shrink-0 rounded bg-(--chip) px-1.5 py-0.5 text-fg-2">line {look.frame.lineno}{look.frame.colno !== null ? `:${look.frame.colno}` : ''}</span> : null}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <CopyButton className={pillButton('secondary', 'h-8 px-3 text-xs')} text={locationOf(look.frame)} />
                {payload.stacktrace.length > 0 ? <button type="button" onClick={showStack} className={pillButton('secondary', 'h-8 px-3 text-xs')}>Stack trace</button> : null}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {hints.length > 0 ? (
        <section aria-label="Hints">
          <GroupTitle>{hints.length === 1 ? 'Hint' : 'Hints'}</GroupTitle>
          <ul className="m-0 flex flex-col gap-2 p-0">
            {hints.map((h, i) => (
              <li key={i} className="flex items-start gap-3">
                <p className="m-0 min-w-0 flex-1 text-[13px] leading-relaxed">{h.text}</p>
                {h.source === 'project' ? <Badge tone="amber" className="shrink-0">Team</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <QuickFacts payload={payload} receivedAt={receivedAt} />

      {facts.length > 0 || insight === null ? (
        <section aria-label="What the analysis found">
          <GroupTitle aside={facts.length > 0 ? <span className="text-xs text-muted">{facts.length} finding{facts.length === 1 ? '' : 's'}</span> : null}>What we found</GroupTitle>
          {facts.length > 0 ? (
            <dl className="m-0 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
              {facts.map((f, i) => (
                <div key={`${f.label}-${i}`} className="grid grid-cols-[116px_minmax(0,1fr)] gap-x-4 gap-y-0.5 px-4 py-2.5 max-sm:grid-cols-1">
                  <dt className="flex items-start gap-2 text-xs font-medium text-muted">
                    <span className={cn('mt-[5px] size-1.5 shrink-0 rounded-full', f.tone === 'bad' ? 'bg-danger' : f.tone === 'warn' ? 'bg-amber' : 'bg-line-strong')} aria-hidden="true" />
                    {f.label}
                  </dt>
                  <dd className={cn('m-0 text-[13px] leading-relaxed break-words', f.tone && TONE_TEXT[f.tone])}>{f.text}</dd>
                </div>
              ))}
            </dl>
          ) : <p className="m-0 text-[13px] text-muted">Not enough data in this event for a summary.</p>}
        </section>
      ) : null}

      {reversed.length > 0 ? (
        <section aria-label="Last moments">
          <GroupTitle aside={<span className="text-xs text-muted">newest first</span>}>Last moments</GroupTitle>
          <div className="rounded-2xl border border-line bg-panel p-2">
            <Timeline items={moments} jump={jump} />
          </div>
          {hidden > 0 ? (
            <button type="button" onClick={showTrail} className="mt-2 cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-muted underline shadow-none hover:text-fg">
              Show {hidden} earlier in Breadcrumbs
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function FrameRow({ c, focus, payload, jump }: { c: Frame; focus: boolean; payload: Payload; jump: Jump }) {
  const f = c.frame;
  return (
    <div {...jumpProps(`stacktrace.${payload.stacktrace.indexOf(f)}`, jump, `frame mono${focus ? ' focus' : ''}${c.kind === 'app' ? '' : ' dim'}`)}>
      <span className="fn">{f.function}</span>{' '}
      <span className="muted">{`${f.filename || '?'}${f.lineno !== null ? ':' + f.lineno : ''}${f.colno !== null ? ':' + f.colno : ''}`}</span>
      <span className="frame-tag">{c.library || FRAME_KIND_LABELS[c.kind]}</span>
    </div>
  );
}

/** The whole error as the browser console prints it, ready to paste into a ticket or chat. */
function StackTextBlock({ payload }: { payload: Payload }) {
  const text = stackText(payload.error, payload.stacktrace);
  return (
    <details className="stack-text">
      <summary>Raw Error</summary>
      <div className="row stack-text-bar">
        <span className="muted small">Every frame, nothing folded.</span>
        <span className="spacer" />
        <CopyButton text={text} />
      </div>
      <pre>{text}</pre>
    </details>
  );
}

/** Stack trace with your code shown and runs of library/browser/hidden frames folded away, plus the plain-text version. */
function StackTab({ frames, focus, payload, jump }: { frames: Frame[]; focus: Frame | null; payload: Payload; jump: Jump }) {
  const appFrames = frames.filter((c) => c.kind === 'app').length;
  const summary = (
    <p className="m-0 mb-3 text-xs text-muted">{frames.length} frame(s){appFrames > 0 ? ` · ${appFrames} in your code` : ''}. Click a frame to find it in the raw JSON.</p>
  );
  // A stack with no frames of your code is shown whole: folding everything would hide it all.
  if (appFrames === 0) {
    return (
      <div>
        {summary}
        <div className="frames">{frames.map((c, i) => <FrameRow key={i} c={c} focus={i === 0} payload={payload} jump={jump} />)}</div>
        <StackTextBlock payload={payload} />
      </div>
    );
  }
  const groups: Array<Frame | Frame[]> = [];
  for (const c of frames) {
    const last = groups[groups.length - 1];
    if (c.kind === 'app') groups.push(c);
    else if (Array.isArray(last)) last.push(c);
    else groups.push([c]);
  }
  return (
    <div>
      {summary}
      <div className="frames">
        {groups.map((g, i) => {
          if (!Array.isArray(g)) return <FrameRow key={i} c={g} focus={g === focus} payload={payload} jump={jump} />;
          const names = [...new Set(g.map((c) => c.library || FRAME_KIND_LABELS[c.kind]))].join(', ');
          return (
            <details key={i} className="frame-group">
              <summary>{`${g.length} frame${g.length === 1 ? '' : 's'}: ${names}`}</summary>
              {g.map((c, j) => <FrameRow key={j} c={c} focus={false} payload={payload} jump={jump} />)}
            </details>
          );
        })}
      </div>
      <StackTextBlock payload={payload} />
    </div>
  );
}

const apiHelper = columnHelper<ApiCall>();
const RIGHT: DataColumnMeta = { align: 'right' };
const apiColumns = apiHelper.columns([
  apiHelper.accessor((c) => c.method, { id: 'method', header: 'Method', cell: ({ row }) => <span className="method">{row.original.method}</span> }),
  apiHelper.accessor((c) => c.url, { id: 'url', header: 'URL', meta: { className: 'min-w-56 whitespace-normal break-all' } satisfies DataColumnMeta, cell: ({ row }) => <span className="font-mono text-xs">{row.original.url}</span> }),
  apiHelper.accessor((c) => c.status, { id: 'status', header: 'Status', cell: ({ row }) => <Badge tone={toneOfKind(row.original.status >= 400 || row.original.status === 0 ? 'error' : 'info')} className="capitalize">{String(row.original.status)}</Badge> }),
  apiHelper.accessor((c) => c.duration_ms, { id: 'duration', header: 'Duration', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{row.original.duration_ms} ms</span> }),
  // The _id (SDK 0.9.0+) can be pasted into the issue search to find every event that recorded the call.
  apiHelper.accessor((c) => c._id ?? '', { id: 'callId', header: 'Call id', cell: ({ row }) => <span className="font-mono text-xs text-muted">{row.original._id || '–'}</span> }),
]);

/** A number with its label as a tile. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-panel-2 px-3.5 py-3">
      <div className={LABEL}>{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function PerformanceTab({ payload }: { payload: Payload }) {
  const perf = payload.performance;
  const ms = (v: number | null) => (v === null ? null : `${v} ms`);
  const stats: Array<[string, string | null]> = [
    ['Page load', ms(perf.page_load_ms)], ['TTFB', ms(perf.ttfb_ms)], ['FCP', ms(perf.fcp_ms)], ['LCP', ms(perf.lcp_ms)],
    ['CLS', perf.cls === null ? null : String(perf.cls)], ['Startup', ms(perf.startup_ms)],
    ['Frame rate', perf.frame_rate_fps === null ? null : `${perf.frame_rate_fps} fps`],
    ['Slow screen', perf.slow_screen ? 'yes' : null],
    ['Memory', payload.memory.used_mb !== null ? `${payload.memory.used_mb} / ${payload.memory.total_mb} MB${payload.memory.leak_suspected ? ' · leak?' : ''}` : null],
  ];
  const shown = stats.filter((s): s is [string, string] => s[1] !== null);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {shown.length > 0 ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">{shown.map(([label, value]) => <Stat key={label} label={label} value={value} />)}</div>
      ) : <p className="m-0 text-[13px] text-muted">No performance numbers in this event.</p>}
      {perf.api_calls.length > 0 ? (
        <DataTable
          data={perf.api_calls}
          columns={apiColumns}
          getRowId={(c, i) => c._id ?? `call-${i}`}
          title={`API calls (${perf.api_calls.length})`}
          description="Requests the page made before this event."
          initialSort={{ id: 'duration', desc: true }}
          minWidth={640}
        />
      ) : null}
    </div>
  );
}

/** Everything about one event, grouped into tabs: overview first, then stack, breadcrumbs, details, performance and the raw JSON. */
export function EventDetail({ event, insightSettings, projectId = null }: { event: ClientEvent; insightSettings: InsightSettingsView | null; projectId?: string | null }) {
  const p = event.payload;
  const rawJsonRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<TabId>('overview');
  const [pendingJump, setPendingJump] = useState<string | null>(null);

  /** Opens the raw event JSON tab, scrolls to the item at `path` and highlights it. */
  const jump: Jump = (path) => {
    setTab('json');
    setPendingJump(path);
  };
  useEffect(() => {
    if (tab !== 'json' || pendingJump === null) return;
    const box = rawJsonRef.current;
    const target = box && box.querySelector(`[data-json-path="${CSS.escape(pendingJump)}"]`);
    if (box && target) {
      for (const old of box.querySelectorAll('.json-hit')) old.classList.remove('json-hit');
      target.classList.add('json-hit');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    setPendingJump(null);
  }, [tab, pendingJump]);

  let insight: Insight<StackFrame> | null = null;
  try {
    insight = analyzeEvent(p, insightSettings, event.receivedAt);
  } catch (error) {
    // The summary is a convenience: an unexpected event shape must never break the issue page.
    console.warn('Issue insights failed for this event', error);
  }

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'overview', label: 'Overview' },
    ...(p.stacktrace.length > 0 ? [{ id: 'stack' as const, label: `Stack trace (${p.stacktrace.length})` }] : []),
    ...(p.breadcrumbs.length > 0 ? [{ id: 'trail' as const, label: `Breadcrumbs (${p.breadcrumbs.length})` }] : []),
    { id: 'details', label: 'Details' },
    { id: 'performance', label: p.performance.api_calls.length > 0 ? `Performance (${p.performance.api_calls.length} calls)` : 'Performance' },
    { id: 'json', label: 'Raw JSON' },
  ];

  const trail: TimelineItem[] = p.breadcrumbs.slice().reverse().map((b, i) => ({
    key: String(i),
    time: b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : '',
    type: b.type,
    message: b.message,
    tone: '',
    path: `breadcrumbs.${p.breadcrumbs.length - 1 - i}`,
  }));

  return (
    <div className={cn(CARD, 'min-w-0 p-3 sm:p-5')}>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="m-0 text-sm font-semibold">Event</h2>
        <span className="text-xs text-muted" title={formatDate(p.timestamp)}>{formatDate(p.timestamp)}</span>
        {p.error ? <Badge tone={p.error.handled ? 'muted' : 'red'}>{p.error.handled ? 'handled' : 'unhandled'}</Badge> : null}
        {p.level ? <Badge tone="neutral">{p.level}</Badge> : null}
        {p.screen ? <Badge tone="neutral">{p.screen}</Badge> : null}
      </div>

      <TabBar label="Event sections" tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' ? <OverviewTab insight={insight} payload={p} receivedAt={event.receivedAt} jump={jump} showTrail={() => setTab('trail')} showStack={() => setTab('stack')} /> : null}

      {tab === 'stack' ? (
        <StackTab
          frames={insight ? insight.frames : p.stacktrace.map((frame) => ({ frame, kind: 'app' as const, library: null }))}
          focus={insight ? insight.whereToLook : null}
          payload={p}
          jump={jump}
        />
      ) : null}

      {tab === 'trail' ? (
        <div>
          <p className="m-0 mb-3 text-xs text-muted">{p.breadcrumbs.length} breadcrumb(s), newest first. Click one to find it in the raw JSON.</p>
          <Timeline items={trail} jump={jump} />
        </div>
      ) : null}

      {tab === 'details' ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-4">
          <Block title="Event">
            <KeyValues rows={[
              ['Time', formatDate(p.timestamp)],
              ['Received', formatDate(event.receivedAt)],
              ['Environment', p.environment],
              ['App version', p.app_version],
              ['Level', p.level],
              ['Handled', p.error ? (p.error.handled ? 'yes' : 'no') : null],
              // One-URL apps (Appzillon) name their screens: the screen says where the user was, the URL doesn't.
              ['Page', [p.screen, p.device.url].filter(Boolean).join('  ·  ')],
              ['User', [p.user.id, p.user.name, p.user.email].filter(Boolean).join(' · ')],
              ['SDK', `${p.sdk.name} ${p.sdk.version || ''}`],
            ]} />
          </Block>
          <Block title="Device">
            <KeyValues rows={[
              ['Platform', p.device.platform],
              ['OS', [p.device.os, p.device.os_version].filter(Boolean).join(' · ')],
              ['Browser', [p.device.browser, p.device.browser_version].filter(Boolean).join(' ')],
              ['Device', [p.device.manufacturer, p.device.model].filter(Boolean).join(' ')],
              ['Screen', p.device.screen_width ? `${p.device.screen_width} × ${p.device.screen_height}` : null],
              ['Locale', p.device.locale],
              ['Referrer', p.device.referrer],
            ]} />
          </Block>
          <Block title="Came from">
            <OriginIds event={event} projectId={projectId} />
          </Block>
          {p.context ? (
            <Block title="Context" className="col-span-full" aside={<CopyButton text={JSON.stringify(p.context, null, 2)} />}>
              <pre className="mono m-0 max-h-96 overflow-auto text-xs">{JSON.stringify(p.context, null, 2)}</pre>
            </Block>
          ) : null}
        </div>
      ) : null}

      {tab === 'performance' ? <PerformanceTab payload={p} /> : null}

      {/* Rows in the other tabs (breadcrumbs, stack frames, the error) jump to their item here. */}
      {tab === 'json' ? (
        <div ref={rawJsonRef} className="raw-json">
          {/* Stays at the top of the scrolling page while the (long) JSON scrolls underneath. */}
          <div className="sticky top-2 z-10 mb-2 flex items-center justify-between gap-3 rounded-full border border-line bg-panel/95 py-1.5 pr-1.5 pl-4 shadow-sm backdrop-blur">
            <span className="text-xs font-medium text-muted">Raw event JSON</span>
            <CopyButton className={pillButton('primary', 'h-8 px-4 text-xs')} label="Copy JSON" text={JSON.stringify(p, null, 2)} />
          </div>
          <pre>{jsonNodes(p)}</pre>
        </div>
      ) : null}
    </div>
  );
}
