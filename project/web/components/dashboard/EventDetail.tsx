'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { formatDate } from '@/lib/format';
import { analyzeEvent, frameLabel, stackText, type ClassifiedFrame, type FrameKind, type Insight } from '@/lib/insights';
import type { Serialized, EventPayload, StackFrame } from '@/lib/schema';
import type { ClientEvent, InsightSettingsView } from '@/lib/types';
import { Badge, CopyButton } from '../ui/bits';

type Payload = Serialized<EventPayload>;
type Frame = ClassifiedFrame<StackFrame>;
type Jump = (path: string) => void;

const FRAME_KIND_LABELS: Partial<Record<FrameKind, string>> = { app: 'your code', native: 'browser', hidden: 'hidden' };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card card-body section">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/** Label/value rows; empty values are left out. */
function KeyValues({ rows }: { rows: Array<[string, string | number | null | undefined]> }) {
  return (
    <dl className="kv">
      {rows.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value]) => (
        <div key={label} className="contents">
          <dt>{label}</dt>
          <dd>{String(value)}</dd>
        </div>
      ))}
    </dl>
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

/** "What happened": the facts, where to look, and hints (lib/insights.ts). */
function SummarySection({ insight, payload, jump }: { insight: Insight<StackFrame>; payload: Payload; jump: Jump }) {
  const look = insight.whereToLook;
  return (
    <Section title="What happened">
      {insight.facts.length > 0 ? (
        <dl className="facts">
          {insight.facts.map((f, i) => (
            <div key={`${f.label}-${i}`} className="contents">
              <dt>{f.label}</dt>
              <dd className={f.tone ? `tone-${f.tone}` : ''}>{f.text}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted">Not enough data in this event for a summary.</p>
      )}
      {look ? (
        <div {...jumpProps(`stacktrace.${payload.stacktrace.indexOf(look.frame)}`, jump, 'look')}>
          <span className="look-label">Where to look</span>
          <code>{frameLabel(look.frame)}</code>
          {look.frame.filename ? <div className="muted small mono">{look.frame.filename}</div> : null}
        </div>
      ) : null}
      {insight.hints.map((h, i) => (
        <div key={i} className="hint">
          <span className="look-label">{h.source === 'project' ? 'Team hint' : 'Hint'}</span>
          <p>{h.text}</p>
        </div>
      ))}
    </Section>
  );
}

/** The breadcrumbs just before the error, newest first: the error on top, then what led up to it. */
function MomentsSection({ insight, payload, jump }: { insight: Insight<StackFrame>; payload: Payload; jump: Jump }) {
  if (insight.moments.length === 0) return null;
  const errorText = payload.error ? `${payload.error.type}: ${payload.error.message}` : payload.event_type;
  return (
    <Section title="Last moments (newest first)">
      <ol className="timeline moments">
        <li {...jumpProps(payload.error ? 'error' : 'event_type', jump, 'moment-error')}>
          <span className="mono small">0 s</span>
          <span className="bc-type"><Badge text={payload.event_type} kind="error" /></span>
          <span className="moment-msg">{errorText}</span>
        </li>
        {insight.moments.slice().reverse().map((m, i) => {
          const tone = m.tone ? `tone-${m.tone}` : '';
          const props = m.index >= 0 ? jumpProps(`breadcrumbs.${m.index}`, jump, tone) : { className: tone };
          return (
            <li key={`${m.index}-${i}`} {...props}>
              <span className="muted mono small">{m.when || (m.at ? new Date(m.at).toLocaleTimeString() : '')}</span>
              <span className="bc-type"><Badge text={m.type} kind="info" /></span>
              <span className="moment-msg">{m.message}</span>
            </li>
          );
        })}
      </ol>
    </Section>
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
function StackSection({ frames, focus, payload, jump }: { frames: Frame[]; focus: Frame | null; payload: Payload; jump: Jump }) {
  // A stack with no frames of your code is shown whole: folding everything would hide it all.
  if (!frames.some((c) => c.kind === 'app')) {
    return (
      <Section title="Stack trace">
        <div className="frames">{frames.map((c, i) => <FrameRow key={i} c={c} focus={i === 0} payload={payload} jump={jump} />)}</div>
        <StackTextBlock payload={payload} />
      </Section>
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
    <Section title="Stack trace">
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
    </Section>
  );
}

/** Everything about one event: insights on top, then the raw sections and the full JSON. */
export function EventDetail({ event, insightSettings }: { event: ClientEvent; insightSettings: InsightSettingsView | null }) {
  const p = event.payload;
  const rawJsonRef = useRef<HTMLDetailsElement>(null);

  /** Opens the raw event JSON, scrolls to the item at `path` and highlights it. */
  const jump: Jump = (path) => {
    const box = rawJsonRef.current;
    const target = box && box.querySelector(`[data-json-path="${CSS.escape(path)}"]`);
    if (!box || !target) return;
    box.open = true;
    for (const old of box.querySelectorAll('.json-hit')) old.classList.remove('json-hit');
    target.classList.add('json-hit');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  let insight: Insight<StackFrame> | null = null;
  try {
    insight = analyzeEvent(p, insightSettings, event.receivedAt);
  } catch (error) {
    // The summary is a convenience: an unexpected event shape must never break the issue page.
    console.warn('Issue insights failed for this event', error);
  }

  const perf = p.performance;
  const ms = (v: number | null) => (v === null ? null : `${v} ms`);

  return (
    <div>
      {insight ? <SummarySection insight={insight} payload={p} jump={jump} /> : null}
      {insight ? <MomentsSection insight={insight} payload={p} jump={jump} /> : null}
      {p.stacktrace.length > 0 ? (
        <StackSection
          frames={insight ? insight.frames : p.stacktrace.map((frame) => ({ frame, kind: 'app' as const, library: null }))}
          focus={insight ? insight.whereToLook : null}
          payload={p}
          jump={jump}
        />
      ) : null}

      <Section title="Event">
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
      </Section>

      {p.breadcrumbs.length > 0 ? (
        <div className="card card-body section">
          <details>
            <summary>{`All breadcrumbs (${p.breadcrumbs.length}), newest first`}</summary>
            <ul className="timeline">
              {p.breadcrumbs.slice().reverse().map((b, i) => (
                <li key={i} {...jumpProps(`breadcrumbs.${p.breadcrumbs.length - 1 - i}`, jump)}>
                  <span className="muted mono small">{b.timestamp ? new Date(b.timestamp).toLocaleTimeString() : ''}</span>
                  <span className="bc-type"><Badge text={b.type} kind="info" /></span>
                  <span>{b.message}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}

      {p.context ? (
        <Section title="Context">
          <pre className="mono">{JSON.stringify(p.context, null, 2)}</pre>
        </Section>
      ) : null}

      <Section title="Device">
        <KeyValues rows={[
          ['Platform', p.device.platform],
          ['OS', [p.device.os, p.device.os_version].filter(Boolean).join(' · ')],
          ['Browser', [p.device.browser, p.device.browser_version].filter(Boolean).join(' ')],
          ['Device', [p.device.manufacturer, p.device.model].filter(Boolean).join(' ')],
          ['Screen', p.device.screen_width ? `${p.device.screen_width} × ${p.device.screen_height}` : null],
          ['Locale', p.device.locale],
          ['Referrer', p.device.referrer],
        ]} />
      </Section>

      <Section title="Performance">
        <KeyValues rows={[
          ['Page load', ms(perf.page_load_ms)], ['TTFB', ms(perf.ttfb_ms)], ['FCP', ms(perf.fcp_ms)], ['LCP', ms(perf.lcp_ms)],
          ['CLS', perf.cls], ['Startup', ms(perf.startup_ms)], ['Frame rate', perf.frame_rate_fps === null ? null : `${perf.frame_rate_fps} fps`],
          ['Slow screen', perf.slow_screen ? 'yes' : null],
          ['Memory', p.memory.used_mb !== null ? `${p.memory.used_mb} MB of ${p.memory.total_mb} MB${p.memory.leak_suspected ? ' · leak suspected' : ''}` : null],
        ]} />
        {perf.api_calls.length > 0 ? (
          <details className="section">
            <summary>{`API calls (${perf.api_calls.length})`}</summary>
            {/* The _id (SDK 0.9.0+) can be pasted into the issue search to find every event that recorded the call. */}
            <pre>{perf.api_calls.map((c) => `${c._id ? `${c._id}  ` : ''}${c.method} ${c.url} → ${c.status} (${c.duration_ms} ms)`).join('\n')}</pre>
          </details>
        ) : null}
      </Section>

      {/* Rows above (breadcrumbs, stack frames, the error) jump to their item here. */}
      <details ref={rawJsonRef} className="section raw-json">
        <summary>Raw event JSON</summary>
        <pre>{jsonNodes(p)}</pre>
      </details>
    </div>
  );
}
