/**
 * Shapes of the dashboard API's JSON responses (app/api/*). The server builds
 * them (server/views.ts and friends); the dashboard reads them. Dates are ISO
 * strings once they reach the browser, hence `Serialized<…>` on the client.
 */
import type { EventPayload, IssueStatus, Serialized } from './schema.ts';

export type Role = 'user' | 'admin';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: Date | string;
  lastLoginAt: Date | string | null;
}

export interface HintSetting {
  match: string;
  text: string;
}

export interface InsightSettingsView {
  libraryPaths: string[];
  hiddenFrames: string[];
  hints: HintSetting[];
}

export interface ProjectView {
  id: string;
  name: string;
  apiKeyHint: string;
  allowedOrigins: string[];
  insights: InsightSettingsView;
  createdAt: Date | string;
}

export interface ProjectListItem extends ProjectView {
  openIssues: number;
  events24h: number;
}

export interface IssueView {
  id: string;
  projectId: string;
  eventType: string;
  errorType: string;
  message: string;
  culprit: string | null;
  level: string;
  status: IssueStatus;
  count: number;
  firstSeen: Date | string;
  lastSeen: Date | string;
  regressedAt: Date | string | null;
  environments: string[];
  platforms: string[];
}

export interface EventSummaryView {
  id: string;
  receivedAt: Date | string;
  timestamp: Date | string;
  environment: string;
  appVersion: string | null;
  message: string | null;
  userId: string | null;
  url: string | null;
  screen: string | null;
  platform: string;
  browser: string | null;
}

export interface EventView extends EventSummaryView {
  issueId: string;
  payload: EventPayload | Serialized<EventPayload>;
}

/** An event as the dashboard receives it. */
export type ClientEvent = Omit<Serialized<EventView>, 'payload'> & { payload: Serialized<EventPayload> };

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface SessionResponse {
  authenticated: boolean;
  user: UserView | null;
}

export interface AccountResponse {
  user: UserView;
  usage: { projects: number; projectLimit: number | null };
}

export interface ProjectsResponse {
  projects: ProjectListItem[];
  limit: number | null;
}

export interface ProjectKeyResponse {
  project: ProjectView;
  apiKey: string;
}

export interface IssueListItem extends IssueView {
  /** When the search text was an API call `_id`: the newest event that recorded that call. */
  matchedEventId: string | null;
}

export interface IssuesResponse {
  issues: IssueListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<IssueStatus, number>;
  environments: string[];
}

export interface IssueResponse {
  issue: IssueView;
  project: { id: string; name: string; insights: InsightSettingsView } | null;
  events: EventSummaryView[];
  latestEvent: EventView | null;
}

export interface EventResponse {
  event: EventView;
}

export interface StatsBucket {
  start: string;
  error: number;
  message: number;
  performance: number;
  crash: number;
}

export interface TopIssue {
  id: string;
  projectId: string;
  eventType: string;
  errorType: string;
  message: string;
  status: IssueStatus;
  count: number;
}

export interface StatsResponse {
  range: '24h' | '7d';
  stepMs: number;
  total: number;
  previousTotal: number;
  byType: Record<string, number>;
  series: StatsBucket[];
  statuses: Record<IssueStatus, number>;
  topIssues: TopIssue[];
}

export type VitalRating = 'good' | 'needs-improvement' | 'poor';

export interface VitalSummary {
  p75: number | null;
  rating: VitalRating | null;
  samples: number;
}

export interface EndpointRow {
  key: string;
  method: string;
  origin: string;
  path: string;
  count: number;
  errorRate: number;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  avgServer: number | null;
  avgDownload: number | null;
  background: number;
}

export interface PageRow {
  name: string;
  views: number;
  loads: number;
  load: number | null;
  lcp: number | null;
  fcp: number | null;
  inp: number | null;
  cls: number | null;
  ttfb: number | null;
  avgBlockingMs: number;
}

export interface PerformanceResponse {
  range: '24h' | '7d';
  stepMs: number;
  environment: string | null;
  environments: string[];
  totals: { views: number; loads: number; requests: number; errorRate: number; p75: number | null; p95: number | null };
  vitals: Record<string, VitalSummary>;
  series: Array<{ start: string; views: number; requests: number; p75: number | null; lcp: number | null }>;
  pages: PageRow[];
  endpoints: EndpointRow[];
}

export interface EndpointSample {
  _id: string | null;
  receivedAt: Date | string;
  page: string;
  environment: string;
  browser: string | null;
  os: string | null;
  url: string;
  status: number;
  failure: string | null;
  duration_ms: number;
  server_ms: number | null;
  download_ms: number | null;
  size_bytes: number | null;
  failed: boolean;
}

export interface EndpointDetailResponse {
  range: '24h' | '7d';
  stepMs: number;
  summary: EndpointRow;
  series: Array<{ start: string; count: number; errors: number; p50: number | null; p75: number | null; p95: number | null }>;
  samples: EndpointSample[];
}

export interface PageSample {
  receivedAt: Date | string;
  name: string;
  environment: string;
  browser: string | null;
  os: string | null;
  vitals: { page_load_ms: number | null; lcp_ms: number | null; fcp_ms: number | null; ttfb_ms: number | null };
  long_tasks: { count: number; blocking_ms: number } | null;
  spanCount: number;
}

export interface PageDetailResponse {
  range: '24h' | '7d';
  stepMs: number;
  summary: PageRow;
  vitals: Record<string, VitalSummary>;
  series: Array<{ start: string; views: number; load: number | null; lcp: number | null }>;
  samples: PageSample[];
}

export interface AdminUserRow extends UserView {
  projects: number;
  events24h: number;
}

export interface AdminResponse {
  totals: { users: number; disabledUsers: number; admins: number; projects: number; unownedProjects: number; events24h: number };
  users: AdminUserRow[];
  truncated: boolean;
}
