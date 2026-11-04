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
  MAX_REQUEST_ID_LENGTH,
  type StatsRange,
} from '../constants.ts';
import { collections } from '../db.ts';
import { escapeRegex, parseObjectId } from '../http.ts';
import { projectPeople } from '../members.ts';
import type { EventDoc, IssueDoc, UserDoc } from '../models.ts';
import { computeEndpointDetail, computePageDetail, computePerformance } from '../performanceStats.ts';
import { computeStats } from '../stats.ts';
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
      description: "Lists an issue's stored events, newest first (id, time, screen, page, environment, version, browser, OS, user id).",
      inputSchema: z.object({
        issueId: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(AI_LIST_EVENTS_MAX).optional().describe('Default 20.'),
      }),
      execute: async ({ issueId, offset = 0, limit = 20 }) => {
        const issue = await scopedIssue(issueId);
        if (!issue) return fail(`No issue ${issueId} in the developer's projects.`);
        const [total, rows] = await Promise.all([
          c.events.countDocuments({ issueId: issue._id }),
          c.events.find({ issueId: issue._id }, { projection: EVENT_SUMMARY_PROJECTION }).sort({ receivedAt: -1 }).skip(offset).limit(limit).toArray(),
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
