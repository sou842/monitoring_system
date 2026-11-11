import { tool } from 'ai';
import type { Db, Filter, ObjectId, Sort } from 'mongodb';
import { z } from 'zod';
import { ISSUE_EVENT_TYPES, ISSUE_STATUSES } from '../../lib/schema.ts';
import type { EndpointRow, PageRow } from '../../lib/types.ts';
import {
  AI_BREAKDOWN_EVENTS,
  AI_LIST_EVENTS_MAX,
  AI_WORKSPACE_EVENT_JSON_CHARS,
  AI_WORKSPACE_ISSUES_MAX,
  AI_WORKSPACE_PERF_ROWS,
  AI_WORKSPACE_PERF_SAMPLES,
  AI_WORKSPACE_PROMPT_PROJECTS,
  AI_VERSION_MAX_LENGTH,
  AI_VERSION_QUERY_MAX_MS,
  AI_VERSIONS_MAX,
  EVENT_RETENTION_DAYS,
  MAX_REQUEST_ID_LENGTH,
  type StatsRange,
} from '../constants.ts';
import { collections, EVENTS_SDK_VERSION_INDEX } from '../db.ts';
import { escapeRegex, parseObjectId } from '../http.ts';
import { projectPeople } from '../members.ts';
import type { EventDoc, IssueDoc, UserDoc } from '../models.ts';
import { computeEndpointDetail, computePageDetail, computePerformance } from '../performanceStats.ts';
import { computeStats } from '../stats.ts';
import { sdkGuideTools } from './sdkGuide.ts';
import { breakdown, cappedJson, EVENT_SUMMARY_PROJECTION, eventAnalysis, eventSummaryLine } from './context.ts';

/**
 * The workspace assistant's data access (the /assistant page). Nothing is put
 * in the prompt up front except the project names; the model fetches what a
 * question needs with these tools. Every tool only reaches the projects in the
 * user's scope: the ones they own, plus the ones where they are a member with
 * the `ai.use` permission (the same rule as the issue panel).
 */

export interface ScopeProject {
  id: ObjectId;
  name: string;
  role: 'owner' | 'member';
  createdAt: Date;
}

export interface WorkspaceScope {
  projects: ScopeProject[];
  ids: ObjectId[];
  byId: Map<string, ScopeProject>;
}

/** The projects the assistant may read for this user (owner, or member with `ai.use`), oldest first. */
export async function workspaceScope(db: Db, user: UserDoc): Promise<WorkspaceScope> {
  const c = collections(db);
  const projection = { name: 1, createdAt: 1 } as const;
  const [owned, memberships] = await Promise.all([
    c.projects.find({ ownerId: user._id }, { projection }).toArray(),
    c.members.find({ userId: user._id, permissions: 'ai.use' }, { projection: { projectId: 1 } }).toArray(),
  ]);
  const shared = memberships.length === 0 ? [] : await c.projects.find({ _id: { $in: memberships.map((m) => m.projectId) } }, { projection }).toArray();
  const projects: ScopeProject[] = [
    ...owned.map((p) => ({ id: p._id, name: p.name, role: 'owner' as const, createdAt: p.createdAt })),
    ...shared.map((p) => ({ id: p._id, name: p.name, role: 'member' as const, createdAt: p.createdAt })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { projects, ids: projects.map((p) => p.id), byId: new Map(projects.map((p) => [String(p.id), p])) };
}

/** The "Workspace" section of the system prompt: who is asking, when, and which projects exist (names only). */
export function workspaceContext(user: Pick<UserDoc, 'name'>, scope: WorkspaceScope, now = new Date()): string {
  const lines = ['# Workspace', `- Developer: ${user.name}`, `- Now: ${now.toISOString()}`];
  if (scope.projects.length === 0) {
    lines.push('- Projects: none. The developer has no project the assistant can read (they can create one on the Projects page, or ask an owner for the "Use AI" permission).');
    return lines.join('\n');
  }
  lines.push(`- Projects (${scope.projects.length}; id · name · role):`);
  for (const p of scope.projects.slice(0, AI_WORKSPACE_PROMPT_PROJECTS)) lines.push(`  - ${String(p.id)} · ${p.name} · ${p.role}`);
  if (scope.projects.length > AI_WORKSPACE_PROMPT_PROJECTS) lines.push(`  - …${scope.projects.length - AI_WORKSPACE_PROMPT_PROJECTS} more: call list_projects`);
  return lines.join('\n');
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const fail = (error: string) => ({ error });

const projectIdInput = z.string().optional().describe('Project id from the workspace list. Omit for all projects.');
const rangeInput = z.enum(['24h', '7d'] as const satisfies readonly StatsRange[]).optional().describe('Time range. Default 24h.');

/** Compact issue row for lists. */
function issueRow(issue: IssueDoc, scope: WorkspaceScope) {
  return {
    id: String(issue._id),
    project: scope.byId.get(String(issue.projectId))?.name ?? null,
    type: `${issue.eventType}/${issue.errorType}`,
    message: issue.message.slice(0, 300),
    culprit: issue.culprit,
    status: issue.status,
    level: issue.level,
    count: issue.count,
    firstSeen: iso(issue.firstSeen),
    lastSeen: iso(issue.lastSeen),
    regressedAt: iso(issue.regressedAt),
    environments: issue.environments ?? [],
  };
}

function endpointRow(row: EndpointRow) {
  return {
    key: row.key, method: row.method, origin: row.origin, path: row.path, calls: row.count,
    errorRate: Math.round(row.errorRate * 1000) / 10, p50: row.p50, p75: row.p75, p95: row.p95,
    avgServerMs: row.avgServer === null ? null : Math.round(row.avgServer), avgDownloadMs: row.avgDownload === null ? null : Math.round(row.avgDownload),
  };
}

function pageRow(row: PageRow) {
  return { page: row.name, views: row.views, loads: row.loads, loadP75: row.load, lcpP75: row.lcp, fcpP75: row.fcp, inpP75: row.inp, clsP75: row.cls, ttfbP75: row.ttfb, avgBlockingMs: Math.round(row.avgBlockingMs) };
}

/** The version these queries look at: the error-tracker SDK that sent the event (`sdk.version`), not the app's own version. */
const SDK_VERSION_FIELD = 'payload.sdk.version';

interface VersionFilters {
  ids: ObjectId[];
  since: Date;
  type?: string;
  environment?: string;
}
interface VersionRow { _id: string | null; events: number; issues: number; first: Date; last: Date }
interface VersionIssueRow { _id: ObjectId; events: number; first: Date; last: Date; newInVersion: boolean }
interface VersionIssuesResult { top: VersionIssueRow[]; totals: Array<{ issues: number; events: number }> }

/** MongoDB's error code for a query stopped by `maxTimeMS`. */
const MONGO_MAX_TIME_EXPIRED = 50;
/** Options of every version query: a time cap, and the index that makes it covered (no event documents read) unless type/environment are given. */
export const VERSION_QUERY_OPTIONS = { maxTimeMS: AI_VERSION_QUERY_MAX_MS, hint: EVENTS_SDK_VERSION_INDEX } as const;

function versionMatch({ ids, since, type, environment }: VersionFilters, version?: string): Filter<EventDoc> {
  const match: Record<string, unknown> = { projectId: { $in: ids } };
  if (version !== undefined) match[SDK_VERSION_FIELD] = version;
  match.receivedAt = { $gte: since };
  if (type) match.eventType = type;
  if (environment) match.environment = environment;
  return match as Filter<EventDoc>;
}

/** SDK versions seen in the range: events, distinct issues, first/last seen; most recently seen first. Exported for the query-plan test. */
export function versionListPipeline(filters: VersionFilters) {
  return [
    { $match: versionMatch(filters) },
    // Two steps (version+issue, then version) keep memory to one row per pair instead of a growing set per version.
    { $group: { _id: { v: `$${SDK_VERSION_FIELD}`, i: '$issueId' }, events: { $sum: 1 }, first: { $min: '$receivedAt' }, last: { $max: '$receivedAt' } } },
    { $group: { _id: '$_id.v', events: { $sum: '$events' }, issues: { $sum: 1 }, first: { $min: '$first' }, last: { $max: '$last' } } },
    { $sort: { last: -1 } },
    { $limit: AI_VERSIONS_MAX },
  ];
}

/**
 * One SDK version's issues, most events first, with totals. `newInVersion`: the issue's
 * own `firstSeen` (set from its first event's `receivedAt`, kept 90 days) is not before
 * the first event sent by this SDK version, so no older SDK version ever reported it. No other events are read.
 * Exported for the query-plan test.
 */
export function versionIssuesPipeline(filters: VersionFilters & { version: string; onlyNew: boolean; limit: number }) {
  return [
    { $match: versionMatch(filters, filters.version) },
    { $group: { _id: '$issueId', events: { $sum: 1 }, first: { $min: '$receivedAt' }, last: { $max: '$receivedAt' } } },
    { $lookup: { from: 'issues', localField: '_id', foreignField: '_id', as: 'issue', pipeline: [{ $project: { _id: 0, firstSeen: 1 } }] } },
    { $match: { 'issue.0': { $exists: true } } },
    { $set: { newInVersion: { $gte: [{ $arrayElemAt: ['$issue.firstSeen', 0] }, '$first'] } } },
    ...(filters.onlyNew ? [{ $match: { newInVersion: true } }] : []),
    { $project: { issue: 0 } },
    {
      $facet: {
        top: [{ $sort: { events: -1, last: -1 } }, { $limit: filters.limit }],
        totals: [{ $group: { _id: null, issues: { $sum: 1 }, events: { $sum: '$events' } } }],
      },
    },
  ];
}

/** The tools of the workspace assistant, bound to this user's scope. */
export function workspaceTools(db: Db, scope: WorkspaceScope) {
  const c = collections(db);

  /** Project ids a call may read: the one asked for (when in scope) or all of them. */
  const projectsFor = (projectId: string | undefined): ObjectId[] | { error: string } => {
    if (!projectId) return scope.ids;
    const p = scope.byId.get(projectId);
    return p ? [p.id] : fail(`Unknown project ${projectId}. Use an id from the workspace list.`);
  };
  /** The issue when it is in scope. */
  const scopedIssue = async (issueId: string): Promise<IssueDoc | null> => {
    const id = parseObjectId(issueId);
    const issue = id ? await c.issues.findOne({ _id: id }) : null;
    return issue && scope.byId.has(String(issue.projectId)) ? issue : null;
  };
  const insightSettings = async (projectId: ObjectId) => (await c.projects.findOne({ _id: projectId }, { projection: { insights: 1 } }))?.insights ?? null;

  return {
    ...sdkGuideTools(),
    list_projects: tool({
      description: 'Lists every project the developer can ask about: id, name, role, open/total issues, when the last issue was seen, member count.',
      inputSchema: z.object({}),
      execute: async () => {
        const [issueRows, memberRows] = await Promise.all([
          c.issues.aggregate<{ _id: ObjectId; open: number; total: number; lastSeen: Date }>([
            { $match: { projectId: { $in: scope.ids } } },
            { $group: { _id: '$projectId', open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } }, total: { $sum: 1 }, lastSeen: { $max: '$lastSeen' } } },
          ]).toArray(),
          c.members.aggregate<{ _id: ObjectId; n: number }>([{ $match: { projectId: { $in: scope.ids } } }, { $group: { _id: '$projectId', n: { $sum: 1 } } }]).toArray(),
        ]);
        const issuesOf = new Map(issueRows.map((r) => [String(r._id), r]));
        const membersOf = new Map(memberRows.map((r) => [String(r._id), r.n]));
        return {
          projects: scope.projects.map((p) => {
            const s = issuesOf.get(String(p.id));
            return { id: String(p.id), name: p.name, role: p.role, createdAt: iso(p.createdAt), openIssues: s?.open ?? 0, totalIssues: s?.total ?? 0, lastIssueSeen: iso(s?.lastSeen), members: (membersOf.get(String(p.id)) ?? 0) + 1 };
          }),
        };
      },
    }),

    get_overview: tool({
      description: 'Error activity of one project or all: events in the range vs. the previous range, by event type, issue counts per status, the issues with the most events, and events per time bucket.',
      inputSchema: z.object({ projectId: projectIdInput, range: rangeInput }),
      execute: async (input) => {
        const { projectId, range: asked } = input;
        const range = asked ?? '24h';
        const ids = projectsFor(projectId);
        if (!Array.isArray(ids)) return fail(ids.error);
        const stats = await computeStats(db, { projectIds: ids, range });
        return {
          range,
          events: stats.total,
          previousRangeEvents: stats.previousTotal,
          byType: stats.byType,
          issuesByStatus: stats.statuses,
          topIssues: stats.topIssues.map((i) => ({ id: i.id, project: scope.byId.get(i.projectId)?.name ?? null, type: `${i.eventType}/${i.errorType}`, message: i.message.slice(0, 200), status: i.status, eventsInRange: i.count })),
          // Only buckets with events, to keep the result small.
          buckets: stats.series
            .map((b) => ({ start: b.start, events: b.error + b.message + b.performance + b.crash }))
            .filter((b) => b.events > 0),
        };
      },
    }),

    search_issues: tool({
      description: 'Finds issues. Filters: project, status, event type, environment, free text (message / error type / culprit, or an API call _id), seen within the last N hours. Sort by lastSeen, count or firstSeen.',
      inputSchema: z.object({
        projectId: projectIdInput,
        status: z.enum([...ISSUE_STATUSES, 'all']).optional().describe('Default open.'),
        type: z.enum(ISSUE_EVENT_TYPES).optional(),
        environment: z.string().max(100).optional(),
        query: z.string().max(200).optional().describe('Text in the message, error type or culprit; or an API call _id.'),
        seenInLastHours: z.number().positive().max(24 * 90).optional().describe('Only issues whose last occurrence is this recent.'),
        sort: z.enum(['lastSeen', 'count', 'firstSeen']).optional().describe('Default lastSeen.'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(AI_WORKSPACE_ISSUES_MAX).optional().describe('Default 20.'),
      }),
      execute: async (input) => {
        const { projectId, status: askedStatus, type, environment, query, seenInLastHours, sort: askedSort, offset = 0, limit = 20 } = input;
        const status = askedStatus ?? 'open';
        const sort = askedSort ?? 'lastSeen';
        const ids = projectsFor(projectId);
        if (!Array.isArray(ids)) return fail(ids.error);
        const filter: Filter<IssueDoc> = { projectId: { $in: ids } };
        if (status !== 'all') filter.status = status;
        if (type) filter.eventType = type;
        if (environment) filter.environments = environment;
        if (seenInLastHours) filter.lastSeen = { $gte: new Date(Date.now() - seenInLastHours * 3600_000) };
        const q = (query ?? '').trim();
        if (q) {
          const pattern = new RegExp(escapeRegex(q), 'i');
          const or: Filter<IssueDoc>[] = [{ message: pattern }, { errorType: pattern }, { culprit: pattern }];
          // API call ids are 16 hex characters (SDK 0.9.0+); anything else skips the event lookup.
          if (q.length <= MAX_REQUEST_ID_LENGTH && /^[0-9a-f]{16}$/.test(q)) {
            const hits = await c.events.distinct('issueId', { 'payload.performance.api_calls._id': q, projectId: { $in: ids } });
            if (hits.length > 0) or.push({ _id: { $in: hits } });
          }
          filter.$or = or;
        }
        const order: Sort = sort === 'count' ? { count: -1, lastSeen: -1 } : sort === 'firstSeen' ? { firstSeen: -1 } : { lastSeen: -1 };
        const [rows, total] = await Promise.all([
          c.issues.find(filter).sort(order).skip(offset).limit(limit).toArray(),
          c.issues.countDocuments(filter),
        ]);
        return { total, offset, issues: rows.map((r) => issueRow(r, scope)) };
      },
    }),

    get_sdk_version_issues: tool({
      description: 'Errors by error-tracker SDK version (`sdk.version` of each event, e.g. 0.12.0: the version of our SDK that sent it). Only versions that sent events in the stored data (30 days): not the SDK release history (that is read_sdk_guide topic versions). Without `version`: lists the SDK versions seen in the stored events, with event/issue counts and first/last seen. With `version`: the issues that had events sent by that SDK version, how many events, when, and `newInVersion` (the issue was first reported by this SDK version).',
      inputSchema: z.object({
        projectId: projectIdInput,
        version: z.string().max(AI_VERSION_MAX_LENGTH).optional().describe('Exact SDK version, e.g. "0.12.0" (no "v"). Omit to list the versions.'),
        type: z.enum(ISSUE_EVENT_TYPES).optional(),
        environment: z.string().max(100).optional(),
        days: z.number().int().min(1).max(EVENT_RETENTION_DAYS).optional().describe(`Only events from the last N days. Default ${EVENT_RETENTION_DAYS} (all stored events).`),
        onlyNew: z.boolean().optional().describe('Only issues that first appeared in this version.'),
        limit: z.number().int().min(1).max(AI_WORKSPACE_ISSUES_MAX).optional().describe('Default 20.'),
      }),
      execute: async (input) => {
        const { projectId, version, type, environment, days, onlyNew = false, limit = 20 } = input;
        const ids = projectsFor(projectId);
        if (!Array.isArray(ids)) return fail(ids.error);
        const base = { ids, since: new Date(Date.now() - (days ?? EVENT_RETENTION_DAYS) * 86_400_000), type, environment };
        // "v0.12.0" and "0.12.0" mean the same; the SDK sends the bare number.
        const v = (version ?? '').trim().replace(/^v(?=\d)/i, '');
        try {
          if (!v) {
            const rows = await c.events.aggregate<VersionRow>(versionListPipeline(base), VERSION_QUERY_OPTIONS).toArray();
            return {
              versions: rows.map((r) => ({ version: r._id ?? '(unknown)', events: r.events, issues: r.issues, firstSeen: iso(r.first), lastSeen: iso(r.last) })),
              note: `SDK versions, most recently seen first, at most ${AI_VERSIONS_MAX}.`,
            };
          }
          const [result] = await c.events.aggregate<VersionIssuesResult>(versionIssuesPipeline({ ...base, version: v, onlyNew, limit }), VERSION_QUERY_OPTIONS).toArray();
          const top = result?.top ?? [];
          const totals = result?.totals[0] ?? { issues: 0, events: 0 };
          if (totals.issues === 0) {
            return { sdkVersion: v, totalIssues: 0, totalEvents: 0, issues: [], note: `No stored issues from SDK version "${v}" in the range (events are kept 30 days). Call without version to see the SDK versions that exist.` };
          }
          const issues = await c.issues.find({ _id: { $in: top.map((r) => r._id) } }).toArray();
          const byId = new Map(issues.map((i) => [String(i._id), i]));
          return {
            sdkVersion: v,
            totalIssues: totals.issues,
            totalEvents: totals.events,
            issues: top.flatMap((r) => {
              const issue = byId.get(String(r._id));
              if (!issue) return [];
              return [{ ...issueRow(issue, scope), link: `/issues/${String(issue._id)}`, eventsInVersion: r.events, firstInVersion: iso(r.first), lastInVersion: iso(r.last), newInVersion: r.newInVersion }];
            }),
          };
        } catch (err) {
          // A query over a very large project can hit the time limit; the model can narrow it and retry.
          if ((err as { code?: unknown }).code === MONGO_MAX_TIME_EXPIRED) return fail('This query took too long. Narrow it: pick one projectId, fewer days, or a type/environment.');
          throw err;
        }
      },
    }),

    get_issue: tool({
      description: "One issue in depth: its facts, how its stored events spread over screens/pages/browsers/versions/days/users, and the dashboard's analysis of the newest event (where to look, last moments, hints, stack). Call get_event for an event's full JSON.",
      inputSchema: z.object({ issueId: z.string() }),
      execute: async ({ issueId }) => {
        const issue = await scopedIssue(issueId);
        if (!issue) return fail(`No issue ${issueId} in the developer's projects.`);
        const [events, newest, settings] = await Promise.all([
          c.events.find({ issueId: issue._id }, { projection: EVENT_SUMMARY_PROJECTION }).sort({ receivedAt: -1 }).limit(AI_BREAKDOWN_EVENTS).toArray(),
          c.events.findOne({ issueId: issue._id }, { sort: { receivedAt: -1 } }),
          insightSettings(issue.projectId),
        ]);
        return {
          issue: { ...issueRow(issue, scope), message: issue.message, lastMessage: issue.lastMessage ?? null, platforms: issue.platforms ?? [] },
          link: `/issues/${String(issue._id)}`,
          acrossStoredEvents: breakdown(events),
          newestEvent: newest ? { id: String(newest._id), happened: iso(newest.timestamp), analysis: eventAnalysis(newest, settings) } : null,
        };
      },
    }),

    list_issue_events: tool({
      description: "Lists an issue's stored events, newest first (id, time, screen, page, environment, version, browser, OS, user id). Optional `sdkVersion` keeps only events sent by one SDK version.",
      inputSchema: z.object({
        issueId: z.string(),
        sdkVersion: z.string().max(AI_VERSION_MAX_LENGTH).optional().describe('Only events sent by this exact error-tracker SDK version, e.g. "0.12.0".'),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(AI_LIST_EVENTS_MAX).optional().describe('Default 20.'),
      }),
      execute: async (input) => {
        const { issueId, sdkVersion, offset = 0, limit = 20 } = input;
        const issue = await scopedIssue(issueId);
        if (!issue) return fail(`No issue ${issueId} in the developer's projects.`);
        const filter: Record<string, unknown> = { issueId: issue._id };
        const sv = (sdkVersion ?? '').trim().replace(/^v(?=\d)/i, '');
        if (sv) filter[SDK_VERSION_FIELD] = sv;
        const [total, rows] = await Promise.all([
          c.events.countDocuments(filter),
          c.events.find(filter, { projection: EVENT_SUMMARY_PROJECTION }).sort({ receivedAt: -1 }).skip(offset).limit(limit).toArray(),
        ]);
        return { total, offset, events: rows.map(eventSummaryLine) };
      },
    }),

    get_event: tool({
      description: "One event in full: the dashboard's analysis and the complete event JSON (breadcrumbs, API calls, device, context…).",
      inputSchema: z.object({ eventId: z.string() }),
      execute: async ({ eventId }) => {
        const id = parseObjectId(eventId);
        const event: EventDoc | null = id ? await c.events.findOne({ _id: id }) : null;
        if (!event || !scope.byId.has(String(event.projectId))) return fail(`No event ${eventId} in the developer's projects.`);
        return {
          id: String(event._id),
          issueId: String(event.issueId),
          link: `/issues/${String(event.issueId)}?event=${String(event._id)}`,
          receivedAt: iso(event.receivedAt),
          // Hashed sender network (never the IP); device.id and session_id are in the JSON.
          networkId: event.networkId ?? null,
          analysis: eventAnalysis(event, await insightSettings(event.projectId)),
          json: cappedJson(event.payload, AI_WORKSPACE_EVENT_JSON_CHARS),
        };
      },
    }),

    get_performance: tool({
      description: 'Performance of one project or all (from page views the SDK sends): totals, Web Vitals p75 with ratings, the busiest pages and API endpoints with latency percentiles and error rates.',
      inputSchema: z.object({
        projectId: projectIdInput,
        range: rangeInput,
        environment: z.string().max(100).optional(),
        sortEndpointsBy: z.enum(['calls', 'p95', 'errorRate']).optional().describe('Default calls.'),
      }),
      execute: async (input) => {
        const { projectId, range: asked, environment, sortEndpointsBy } = input;
        const range = asked ?? '24h';
        const ids = projectsFor(projectId);
        if (!Array.isArray(ids)) return fail(ids.error);
        const perf = await computePerformance(db, { projectIds: ids, range, environment: environment ?? null });
        const endpoints = [...perf.endpoints];
        if (sortEndpointsBy === 'p95') endpoints.sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));
        if (sortEndpointsBy === 'errorRate') endpoints.sort((a, b) => b.errorRate - a.errorRate);
        return {
          range,
          environment: perf.environment,
          environments: perf.environments,
          totals: { ...perf.totals, errorRate: Math.round(perf.totals.errorRate * 1000) / 10 },
          vitals: perf.vitals,
          pages: perf.pages.slice(0, AI_WORKSPACE_PERF_ROWS).map(pageRow),
          endpoints: endpoints.slice(0, AI_WORKSPACE_PERF_ROWS).map(endpointRow),
          note: 'Times in ms; errorRate in %. Use get_performance_detail with an endpoint key or page name for its trend and slowest samples.',
        };
      },
    }),

    get_performance_detail: tool({
      description: 'One API endpoint (by its key from get_performance) or one page (by its name): trend over the range and the slowest recent samples.',
      inputSchema: z.object({
        kind: z.enum(['endpoint', 'page']),
        key: z.string().max(1000).describe('Endpoint `key` or page `page` from get_performance.'),
        projectId: projectIdInput,
        range: rangeInput,
        environment: z.string().max(100).optional(),
      }),
      execute: async (input) => {
        const { kind, key, projectId, range: asked, environment } = input;
        const range = asked ?? '24h';
        const ids = projectsFor(projectId);
        if (!Array.isArray(ids)) return fail(ids.error);
        const options = { projectIds: ids, range, environment: environment ?? null };
        if (kind === 'endpoint') {
          const d = await computeEndpointDetail(db, { ...options, key });
          if (!d) return fail(`No data for endpoint ${key} in this range.`);
          return {
            summary: endpointRow(d.summary),
            series: d.series.filter((b) => b.count > 0),
            slowest: d.samples.slice(0, AI_WORKSPACE_PERF_SAMPLES).map((s) => ({ _id: s._id, at: s.receivedAt, page: s.page, status: s.status, failure: s.failure, failed: s.failed, durationMs: s.duration_ms, serverMs: s.server_ms, downloadMs: s.download_ms, sizeBytes: s.size_bytes, browser: s.browser, environment: s.environment })),
          };
        }
        const d = await computePageDetail(db, { ...options, page: key });
        if (!d) return fail(`No data for page ${key} in this range.`);
        return {
          summary: pageRow(d.summary),
          vitals: d.vitals,
          series: d.series.filter((b) => b.views > 0),
          slowest: d.samples.slice(0, AI_WORKSPACE_PERF_SAMPLES).map((s) => ({ at: s.receivedAt, page: s.name, browser: s.browser, os: s.os, environment: s.environment, vitals: s.vitals, longTasks: s.long_tasks, requests: s.spanCount })),
        };
      },
    }),

    list_members: tool({
      description: 'Owner and members of one project, with their permissions.',
      inputSchema: z.object({ projectId: z.string() }),
      execute: async (input) => {
        const { projectId } = input;
        const scoped = scope.byId.get(projectId);
        const project = scoped ? await c.projects.findOne({ _id: scoped.id }) : null;
        if (!project) return fail(`Unknown project ${projectId}.`);
        const people = await projectPeople(db, project);
        return {
          owner: people.owner ? { name: people.owner.name, email: people.owner.email } : null,
          members: people.members.map((m) => ({ name: m.name, email: m.email, permissions: m.permissions, addedAt: iso(m.addedAt) })),
        };
      },
    }),
  };
}
