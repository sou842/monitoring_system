import type { Db, ObjectId } from 'mongodb';
import { analyzeEvent, frameLabel, stackText, type InsightEvent, type InsightSettingsInput } from '../../lib/insights.ts';
import { AI_BREAKDOWN_EVENTS, AI_BREAKDOWN_TOP, AI_MAX_EVENT_JSON_CHARS } from '../constants.ts';
import { collections } from '../db.ts';
import type { EventDoc, IssueDoc, ProjectDoc } from '../models.ts';

/**
 * Turns an issue and its events into the text the assistant reads: the issue,
 * the event on screen (in full, plus the dashboard's own analysis of it), and
 * how the issue's stored events spread over screens, browsers, versions…
 */

/** The event as the dashboard sees it (dates as ISO strings). */
function plainPayload(event: EventDoc): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>;
}

/** Compact JSON, cut to AI_MAX_EVENT_JSON_CHARS so one huge event can't fill the model's context. */
export function cappedJson(value: unknown, maxChars = AI_MAX_EVENT_JSON_CHARS): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [cut: ${text.length - maxChars} more characters]`;
}

/** The dashboard's analysis of one event, as plain text lines. */
export function eventAnalysis(event: EventDoc, settings: InsightSettingsInput | null | undefined): string {
  const payload = plainPayload(event);
  const insight = analyzeEvent(payload as InsightEvent, settings, event.receivedAt.toISOString());
  const lines: string[] = [];
  for (const fact of insight.facts) lines.push(`- ${fact.label}: ${fact.text}`);
  if (insight.whereToLook) lines.push(`- Where to look (first app frame): ${frameLabel(insight.whereToLook.frame)}`);
  const kinds = insight.frames.filter((f) => f.kind !== 'hidden').map((f) => `${f.kind === 'library' ? `library:${f.library}` : f.kind} ${frameLabel(f.frame)}`);
  if (kinds.length > 0) lines.push(`- Frames (newest first): ${kinds.join(' | ')}`);
  for (const hint of insight.hints) lines.push(`- Hint (${hint.source}): ${hint.text}`);
  if (insight.moments.length > 0) {
    lines.push('- Last moments before the error (oldest first):');
    for (const m of insight.moments) lines.push(`  - ${m.when ?? m.at ?? ''} [${m.type}] ${m.message}`);
  }
  const stack = stackText(payload.error as InsightEvent['error'], payload.stacktrace);
  if (stack) lines.push('- Stack as the browser console shows it:', '```', stack, '```');
  return lines.join('\n');
}

/** One stored event in a few words, for lists. */
export function eventSummaryLine(event: EventDoc): string {
  const device = event.payload && event.payload.device;
  const parts = [
    `id ${String(event._id)}`,
    `happened ${event.timestamp.toISOString()}`,
    event.screen ? `screen ${event.screen}` : null,
    event.url ? `url ${event.url}` : null,
    `env ${event.environment}`,
    event.appVersion ? `version ${event.appVersion}` : null,
    device && device.browser ? `${device.browser} ${device.browser_version ?? ''}`.trim() : null,
    device && device.os ? `${device.os} ${device.os_version ?? ''}`.trim() : null,
    event.userId ? `user ${event.userId}` : null,
    event.message && event.message !== event.payload.error?.message ? `message ${event.message}` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

type Counter = Map<string, number>;

function count(counter: Counter, value: unknown): void {
  const key = value === null || value === undefined || value === '' ? '(none)' : String(value);
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function topRows(counter: Counter, total: number): string {
  const rows = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  const shown = rows.slice(0, AI_BREAKDOWN_TOP).map(([k, n]) => `${k} ${n} (${Math.round((n / total) * 100)}%)`);
  if (rows.length > AI_BREAKDOWN_TOP) shown.push(`…${rows.length - AI_BREAKDOWN_TOP} more`);
  return shown.join(', ');
}

/** How the issue's stored events spread over screens, browsers, versions, days… */
export function breakdown(events: readonly EventDoc[]): string {
  if (events.length === 0) return 'No stored events.';
  const fields: Record<string, Counter> = {
    Screens: new Map(), Pages: new Map(), Environments: new Map(), 'App versions': new Map(), Browsers: new Map(),
    'Operating systems': new Map(), Handled: new Map(), Messages: new Map(), Days: new Map(),
  };
  const users = new Set<string>();
  for (const e of events) {
    const device = e.payload && e.payload.device;
    count(fields.Screens, e.screen);
    count(fields.Pages, e.url);
    count(fields.Environments, e.environment);
    count(fields['App versions'], e.appVersion);
    count(fields.Browsers, device && device.browser ? `${device.browser} ${String(device.browser_version ?? '').split('.')[0]}`.trim() : null);
    count(fields['Operating systems'], device && device.os);
    count(fields.Handled, e.handled);
    count(fields.Messages, e.message);
    count(fields.Days, e.timestamp.toISOString().slice(0, 10));
    if (e.userId) users.add(e.userId);
  }
  // When they happened (device clock), not when they arrived: the offline queue sends late events in one batch.
  const times = events.map((e) => e.timestamp.getTime());
  const oldest = new Date(Math.min(...times)).toISOString();
  const newest = new Date(Math.max(...times)).toISOString();
  const lines = [`${events.length} stored event(s), happened from ${oldest} to ${newest}; ${users.size} distinct user id(s).`];
  for (const [label, counter] of Object.entries(fields)) lines.push(`- ${label}: ${topRows(counter, events.length)}`);
  return lines.join('\n');
}

export interface IssueContextInput {
  issue: IssueDoc;
  project: Pick<ProjectDoc, 'name' | 'insights'> | null;
  /** The event the developer is viewing; null when none is stored. */
  event: EventDoc | null;
  /** Stored events of the issue, newest first (up to AI_BREAKDOWN_EVENTS), with only EVENT_SUMMARY_PROJECTION fields. */
  events: readonly EventDoc[];
}

/** The "The issue" section appended to the system prompt. */
export function issueContext({ issue, project, event, events }: IssueContextInput): string {
  const settings = project ? project.insights : null;
  const parts = [
    '# The issue',
    `- Project: ${project ? project.name : '(unknown)'}`,
    `- Issue id: ${String(issue._id)}`,
    `- Type: ${issue.eventType} / ${issue.errorType} (level ${issue.level})`,
    `- Message: ${issue.message || '(no message)'}${issue.lastMessage && issue.lastMessage !== issue.message ? ` (latest: ${issue.lastMessage})` : ''}`,
    `- Culprit (top frame): ${issue.culprit ?? '(none)'}`,
    `- Status: ${issue.status}${issue.regressedAt ? `, regressed at ${issue.regressedAt.toISOString()}` : ''}`,
    `- Occurrences: ${issue.count} total, first seen ${issue.firstSeen.toISOString()}, last seen ${issue.lastSeen.toISOString()}`,
    `- Environments: ${(issue.environments ?? []).join(', ') || '(none)'}; platforms: ${(issue.platforms ?? []).join(', ') || '(none)'}`,
    '',
    '## Across stored events',
    breakdown(events),
  ];
  if (event) {
    parts.push(
      '',
      `## The event on screen (id ${String(event._id)}, happened ${event.timestamp.toISOString()}, received ${event.receivedAt.toISOString()})`,
      '### Dashboard analysis',
      eventAnalysis(event, settings),
      '### Full event JSON',
      cappedJson(event.payload),
    );
  } else {
    parts.push('', 'No event is stored for this issue (events are deleted after 30 days).');
  }
  return parts.join('\n');
}

/** Event fields the breakdown and event lists read; skips the heavy parts (breadcrumbs, stack, API calls). */
export const EVENT_SUMMARY_PROJECTION = {
  receivedAt: 1, timestamp: 1, environment: 1, appVersion: 1, handled: 1, userId: 1, url: 1, screen: 1, message: 1,
  'payload.device': 1, 'payload.error': 1,
} as const;

/** Loads what `issueContext` needs. `eventId` is ignored unless it belongs to the issue. */
export async function loadIssueContext(db: Db, issue: IssueDoc, eventId: ObjectId | null): Promise<IssueContextInput> {
  const c = collections(db);
  const [project, events, picked] = await Promise.all([
    c.projects.findOne({ _id: issue.projectId }, { projection: { name: 1, insights: 1 } }),
    c.events.find({ issueId: issue._id }, { projection: EVENT_SUMMARY_PROJECTION }).sort({ receivedAt: -1 }).limit(AI_BREAKDOWN_EVENTS).toArray(),
    eventId ? c.events.findOne({ _id: eventId, issueId: issue._id }) : Promise.resolve(null),
  ]);
  const event = picked ?? await c.events.findOne({ issueId: issue._id }, { sort: { receivedAt: -1 } });
  return { issue, project, event, events };
}
