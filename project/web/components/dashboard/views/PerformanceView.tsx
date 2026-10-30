'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useApi } from '@/lib/client/api';
import { bucketLabel, formatBytes, formatDate, formatMs, formatPercent, queryString, RANGE_LABELS, SDK_PACKAGE, SECONDS_FROM_MS, timeAgo, type Range } from '@/lib/format';
import type { EndpointDetailResponse, PageDetailResponse, PerformanceResponse, ProjectsResponse, VitalRating, VitalSummary } from '@/lib/types';
import { Badge, EmptyState, ErrorNotice, Kpi, Loading, Panel } from '../../ui/bits';
import { CHART_LARGE, CHART_SMALL, CHART_WIDE, ColumnChart } from '../../ui/ColumnChart';
import { Page, type Crumb } from '../Page';
import { Welcome } from '../Welcome';

/** Web Vitals in display order, with how to show their value. */
const PERF_VITALS = [
  { key: 'lcp', label: 'LCP', name: 'Largest Contentful Paint', format: 'ms' },
  { key: 'inp', label: 'INP', name: 'Interaction to Next Paint', format: 'ms' },
  { key: 'cls', label: 'CLS', name: 'Cumulative Layout Shift', format: 'cls' },
  { key: 'fcp', label: 'FCP', name: 'First Contentful Paint', format: 'ms' },
  { key: 'ttfb', label: 'TTFB', name: 'Time to First Byte', format: 'ms' },
  { key: 'load', label: 'Load', name: 'Page load (load event)', format: 'ms' },
] as const;
type PerfVital = (typeof PERF_VITALS)[number];

const RATING_TEXT: Record<VitalRating, string> = { good: 'Good', 'needs-improvement': 'Needs work', poor: 'Poor' };
/** [good up to, poor above] for table dots; mirrors VITAL_THRESHOLDS in server/constants.ts. */
const VITAL_LIMITS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] } as const;
const ENDPOINT_SORTS = ['count', 'p50', 'p75', 'p95', 'errorRate', 'avgServer'] as const;
const PAGE_SORTS = ['views', 'load', 'lcp', 'inp', 'cls'] as const;

function formatVital(vital: PerfVital, value: number | null): string {
  if (value === null || value === undefined) return '–';
  return vital.format === 'cls' ? value.toFixed(3) : formatMs(value);
}

function RatingBadge({ rating }: { rating: VitalRating | null }) {
  return rating ? <span className={`rating ${rating}`}>{RATING_TEXT[rating]}</span> : null;
}

function VitalCard({ vital, summary }: { vital: PerfVital; summary: VitalSummary }) {
  return (
    <section className="panel kpi" title={vital.name}>
      <div className="panel-head"><span>{vital.label}</span><RatingBadge rating={summary.rating} /></div>
      <div className="big">{formatVital(vital, summary.p75)}</div>
      <div className="delta neutral">{summary.samples === 0 ? 'No samples yet' : `p75 · ${summary.samples.toLocaleString()} page view(s)`}</div>
    </section>
  );
}

/** A small coloured dot for a table cell, using the same thresholds as the server. */
function RatingDot({ vital, value }: { vital: keyof typeof VITAL_LIMITS; value: number | null }) {
  if (value === null || value === undefined) return null;
  const limits = VITAL_LIMITS[vital];
  const rating: VitalRating = value <= limits[0] ? 'good' : value > limits[1] ? 'poor' : 'needs-improvement';
  return <i className={`dot ${rating}`} title={RATING_TEXT[rating]} />;
}

/** A sortable table header cell: clicking it re-sorts by that column (largest first). */
function SortHeader({ text, sortKey, current, onSort }: { text: string; sortKey: string; current: string; onSort: (key: string) => void }) {
  return (
    <th className="num">
      <button type="button" className={`th-sort${current === sortKey ? ' active' : ''}`} onClick={() => onSort(sortKey)}>
        {text}{current === sortKey ? ' ↓' : ''}
      </button>
    </th>
  );
}

function sortRows<T>(rows: T[], key: keyof T): T[] {
  const value = (row: T) => (typeof row[key] === 'number' ? (row[key] as number) : -1);
  return rows.slice().sort((a, b) => value(b) - value(a));
}

const pick = <T extends readonly string[]>(options: T, value: string | null, fallback: T[number]): T[number] =>
  (options as readonly string[]).includes(value ?? '') ? (value as T[number]) : fallback;

/** Web Vitals, endpoints and pages (`?range=&project=&env=`, plus `&endpoint=<key>` or `&page=<route>` for a detail view). */
export function PerformanceView() {
  const router = useRouter();
  const query = useSearchParams();
  const range: Range = query.get('range') === '7d' ? '7d' : '24h';
  const environment = query.get('env') || '';
  const endpoint = query.get('endpoint');
  const page = query.get('page');
  const projectsState = useApi<ProjectsResponse>('/api/projects');
  const projects = projectsState.data?.projects;
  const projectId = projects && projects.some((p) => p.id === query.get('project')) ? (query.get('project') ?? '') : '';

  const state = { range, project: projectId, env: environment };
  const link = (changes: Record<string, string | null>) => `/performance${queryString({ ...state, ...changes })}`;
  const go = (changes: Record<string, string | null>) => router.push(link(changes), { scroll: false });
  const base = `/api/stats${queryString({ view: 'performance', range, projectId, environment })}`;
  const overview = useApi<PerformanceResponse>(projects && projects.length > 0 ? base : null);

  const detailCrumbs = (label: string): Crumb[] => [{ label: 'Performance', href: link({}) }, { label }];
  const crumbs: Crumb[] = endpoint ? detailCrumbs(endpoint) : page ? detailCrumbs(page) : [{ label: 'Performance' }];

  const toolbar = projects && overview.data ? (
    <div className="toolbar">
      <div className="seg" role="group" aria-label="Time range">
        {(Object.keys(RANGE_LABELS) as Range[]).map((key) => (
          <button key={key} type="button" className={range === key ? 'active' : ''} onClick={() => go({ range: key, endpoint, page })}>{RANGE_LABELS[key]}</button>
        ))}
      </div>
      <select aria-label="Project" value={projectId} onChange={(e) => go({ project: e.target.value })}>
        <option value="">All projects</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select aria-label="Environment" value={environment} onChange={(e) => go({ env: e.target.value, endpoint, page })}>
        <option value="">All environments</option>
        {overview.data.environments.map((env) => <option key={env} value={env}>{env}</option>)}
      </select>
    </div>
  ) : null;

  let body: ReactNode;
  const error = projectsState.error || overview.error;
  if (error) body = <ErrorNotice error={error} />;
  else if (!projects) body = <Loading />;
  else if (projects.length === 0) body = <Welcome />;
  else if (!overview.data) body = <Loading />;
  else if (endpoint) body = <EndpointDetail path={`${base}&endpoint=${encodeURIComponent(endpoint)}`} link={link} />;
  else if (page) body = <PageDetail path={`${base}&page=${encodeURIComponent(page)}`} />;
  else body = <Overview data={overview.data} range={range} link={link} go={go} />;

  return (
    <Page crumbs={crumbs}>
      {projects && projects.length > 0 ? toolbar : null}
      {body}
    </Page>
  );
}

function Overview({ data, range, link, go }: {
  data: PerformanceResponse;
  range: Range;
  link: (changes: Record<string, string | null>) => string;
  go: (changes: Record<string, string | null>) => void;
}) {
  const query = useSearchParams();
  if (data.totals.views === 0 && data.totals.requests === 0) {
    return (
      <EmptyState icon="inbox" title="No performance data yet"
        text={`Page views appear here once your app runs ${SDK_PACKAGE} 0.5.0 or later. Each page view sends its Web Vitals and the timing of every request.`} />
    );
  }
  const labels = data.series.map((b) => bucketLabel(b.start, range));
  const sideLabel = RANGE_LABELS[range];
  const endpointSort = pick(ENDPOINT_SORTS, query.get('sort'), 'count');
  const pageSort = pick(PAGE_SORTS, query.get('psort'), 'views');
  const sortEndpoints = (s: string) => go({ sort: s, psort: pageSort });
  const sortPages = (s: string) => go({ psort: s, sort: endpointSort });

  return (
    <>
      <div className="vitals-grid">
        {PERF_VITALS.map((vital) => <VitalCard key={vital.key} vital={vital} summary={data.vitals[vital.key]} />)}
      </div>
      <div className="dash-grid section">
        <Panel className="span-2" label="Request latency · p75" side={sideLabel}>
          <div className="big">{formatMs(data.totals.p75)}<small>p95 {formatMs(data.totals.p95)}</small></div>
          <div className="delta neutral">{data.totals.requests.toLocaleString()} request(s) · {formatPercent(data.totals.errorRate)} failed</div>
          <div className="section"><ColumnChart values={data.series.map((b) => b.p75 || 0)} labels={labels} size={CHART_LARGE} axis /></div>
        </Panel>
        <Panel label="Page views" side={sideLabel}>
          <div className="big">{data.totals.views.toLocaleString()}<small>{data.totals.loads.toLocaleString()} full load(s)</small></div>
          <div className="section"><ColumnChart values={data.series.map((b) => b.views)} labels={labels} size={CHART_SMALL} /></div>
        </Panel>
      </div>

      <section className="card table-wrap section">
        <div className="table-title">
          <h3>Endpoints</h3>
          <span className="muted small">Server = time to first byte, from the browser. Requests made while the tab was hidden are counted but not timed.</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <SortHeader text="Calls" sortKey="count" current={endpointSort} onSort={sortEndpoints} />
              <SortHeader text="p50" sortKey="p50" current={endpointSort} onSort={sortEndpoints} />
              <SortHeader text="p75" sortKey="p75" current={endpointSort} onSort={sortEndpoints} />
              <SortHeader text="p95" sortKey="p95" current={endpointSort} onSort={sortEndpoints} />
              <SortHeader text="Failed" sortKey="errorRate" current={endpointSort} onSort={sortEndpoints} />
              <SortHeader text="Server" sortKey="avgServer" current={endpointSort} onSort={sortEndpoints} />
              <th className="num">Download</th>
            </tr>
          </thead>
          <tbody>
            {sortRows(data.endpoints, endpointSort).map((e) => (
              <tr key={e.key}>
                <td className="wrap">
                  <Link href={link({ endpoint: e.key })} title={e.key}>
                    <span className="method">{e.method}</span><span className="muted">{e.origin}</span><span>{e.path}</span>
                  </Link>
                </td>
                <td className="num">{e.count.toLocaleString()}</td>
                <td className="num">{formatMs(e.p50)}</td>
                <td className="num">{formatMs(e.p75)}</td>
                <td className={`num${e.p95 !== null && e.p95 >= SECONDS_FROM_MS ? ' warn' : ''}`}>{formatMs(e.p95)}</td>
                <td className={`num${e.errorRate > 0 ? ' warn' : ''}`}>{formatPercent(e.errorRate)}</td>
                <td className="num muted">{formatMs(e.avgServer)}</td>
                <td className="num muted">{formatMs(e.avgDownload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card table-wrap section">
        <div className="table-title">
          <h3>Pages</h3>
          <span className="muted small">p75 per route, or per screen when the app names screens (setScreen). IDs in paths are grouped as {'{id}'}.</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Route / screen</th>
              <SortHeader text="Views" sortKey="views" current={pageSort} onSort={sortPages} />
              <SortHeader text="Load" sortKey="load" current={pageSort} onSort={sortPages} />
              <SortHeader text="LCP" sortKey="lcp" current={pageSort} onSort={sortPages} />
              <SortHeader text="INP" sortKey="inp" current={pageSort} onSort={sortPages} />
              <SortHeader text="CLS" sortKey="cls" current={pageSort} onSort={sortPages} />
              <th className="num">TTFB</th>
            </tr>
          </thead>
          <tbody>
            {sortRows(data.pages, pageSort).map((p) => (
              <tr key={p.name}>
                <td className="wrap"><Link href={link({ page: p.name })}>{p.name}</Link></td>
                <td className="num">{p.views.toLocaleString()}</td>
                <td className="num">{formatMs(p.load)}</td>
                <td className="num">{formatMs(p.lcp)} <RatingDot vital="lcp" value={p.lcp} /></td>
                <td className="num">{formatMs(p.inp)} <RatingDot vital="inp" value={p.inp} /></td>
                <td className="num">{p.cls === null ? '–' : p.cls.toFixed(3)} <RatingDot vital="cls" value={p.cls} /></td>
                <td className="num muted">{formatMs(p.ttfb)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function EndpointDetail({ path, link }: { path: string; link: (changes: Record<string, string | null>) => string }) {
  const { data, error } = useApi<EndpointDetailResponse>(path);
  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Loading />;
  const s = data.summary;
  const labels = data.series.map((b) => bucketLabel(b.start, data.range));

  return (
    <>
      <div className="page-head perf-head">
        <h1 className="endpoint-title"><span className="method">{s.method}</span><span>{`${s.origin}${s.path}`}</span></h1>
      </div>
      <div className="kpi-grid">
        <Kpi label="p50 · p75" value={`${formatMs(s.p50)} · ${formatMs(s.p75)}`} />
        <Kpi label="p95" value={formatMs(s.p95)} />
        <Kpi label="Calls" value={s.count.toLocaleString()} note={`${formatPercent(s.errorRate)} failed`} neutral />
        <Kpi label="Server · download (avg)" value={`${formatMs(s.avgServer)} · ${formatMs(s.avgDownload)}`} neutral
          note={s.avgServer === null ? 'Not exposed by the browser (cross-origin)' : 'Time to first byte · body'} />
      </div>
      <Panel className="section" label="Latency per bucket" side={RANGE_LABELS[data.range]}>
        <div className="legend"><span><i />p75 per {data.range === '7d' ? 'day' : 'hour'}</span></div>
        <ColumnChart values={data.series.map((b) => b.p75 || 0)} labels={labels} size={CHART_WIDE} axis />
      </Panel>
      <section className="card table-wrap section">
        <div className="table-title">
          <h3>Slowest calls</h3>
          <span className="muted small">From the last 7 days at most; hidden-tab calls are left out.</span>
        </div>
        {data.samples.length === 0 ? (
          <p className="muted pad">No recent calls kept for this endpoint.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>{['Duration', 'Server', 'Download', 'Size', 'Status', 'Page', 'Browser', 'When', 'Call id'].map((h, i) => <th key={h} className={i < 4 ? 'num' : ''}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.samples.map((row, i) => (
                <tr key={row._id ?? `sample-${i}`}>
                  <td className="num">{formatMs(row.duration_ms)}</td>
                  <td className="num muted">{formatMs(row.server_ms)}</td>
                  <td className="num muted">{formatMs(row.download_ms)}</td>
                  <td className="num muted">{formatBytes(row.size_bytes)}</td>
                  <td><Badge text={row.failure || String(row.status)} kind={row.failed ? 'error' : 'info'} /></td>
                  <td className="wrap"><Link href={link({ page: row.page, endpoint: null })}>{row.page}</Link></td>
                  <td className="muted">{[row.browser, row.os].filter(Boolean).join(' · ') || '–'}</td>
                  <td className="muted" title={formatDate(row.receivedAt)}>{timeAgo(row.receivedAt)}</td>
                  <td className="mono small muted">{row._id || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function PageDetail({ path }: { path: string }) {
  const { data, error } = useApi<PageDetailResponse>(path);
  if (error) return <ErrorNotice error={error} />;
  if (!data) return <Loading />;
  const labels = data.series.map((b) => bucketLabel(b.start, data.range));

  return (
    <>
      <div className="page-head perf-head"><h1 className="endpoint-title">{data.summary.name}</h1></div>
      <div className="vitals-grid">
        {PERF_VITALS.map((vital) => <VitalCard key={vital.key} vital={vital} summary={data.vitals[vital.key]} />)}
      </div>
      {/* Routes reached only by in-app navigation have no full page loads: chart their views instead. */}
      {data.summary.loads > 0 ? (
        <Panel className="section" label="Page load · p75" side={RANGE_LABELS[data.range]}>
          <div className="delta neutral">{data.summary.views.toLocaleString()} view(s), {data.summary.loads.toLocaleString()} full load(s)</div>
          <div className="section"><ColumnChart values={data.series.map((b) => b.load || 0)} labels={labels} size={CHART_WIDE} axis /></div>
        </Panel>
      ) : (
        <Panel className="section" label="Views" side={RANGE_LABELS[data.range]}>
          <div className="delta neutral">{data.summary.views.toLocaleString()} view(s), all from in-app navigation (no full page loads)</div>
          <div className="section"><ColumnChart values={data.series.map((b) => b.views)} labels={labels} size={CHART_WIDE} axis /></div>
        </Panel>
      )}
      <section className="card table-wrap section">
        <div className="table-title">
          <h3>Slowest page loads</h3>
          <span className="muted small">From the last 7 days at most; loads in a hidden tab are left out.</span>
        </div>
        {data.samples.length === 0 ? (
          <p className="muted pad">No recent full page loads kept for this route.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>{['Load', 'LCP', 'FCP', 'TTFB', 'Blocking', 'Requests', 'URL path', 'Browser', 'When'].map((h, i) => <th key={h} className={i < 6 ? 'num' : ''}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.samples.map((row, i) => (
                <tr key={`${String(row.receivedAt)}-${i}`}>
                  <td className="num">{formatMs(row.vitals.page_load_ms)}</td>
                  <td className="num">{formatMs(row.vitals.lcp_ms)}</td>
                  <td className="num">{formatMs(row.vitals.fcp_ms)}</td>
                  <td className="num muted">{formatMs(row.vitals.ttfb_ms)}</td>
                  <td className="num muted">{row.long_tasks && row.long_tasks.blocking_ms ? formatMs(row.long_tasks.blocking_ms) : '–'}</td>
                  <td className="num muted">{String(row.spanCount)}</td>
                  <td className="wrap muted">{row.name}</td>
                  <td className="muted">{[row.browser, row.os].filter(Boolean).join(' · ') || '–'}</td>
                  <td className="muted" title={formatDate(row.receivedAt)}>{timeAgo(row.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
