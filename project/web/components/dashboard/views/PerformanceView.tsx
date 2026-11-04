'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, type MutableRefObject, type ReactNode } from 'react';
import { useApi } from '@/lib/client/api';
import { bucketLabel, formatBytes, formatDate, formatMs, formatPercent, queryString, RANGE_LABELS, SDK_PACKAGE, SECONDS_FROM_MS, timeAgo, type Range } from '@/lib/format';
import type { EndpointDetailResponse, PageDetailResponse, PerformanceResponse, VitalRating, VitalSummary } from '@/lib/types';
import { columnHelper, DataTable, type DataColumnMeta } from '../../ui/DataTable';
import { EmptyState, ErrorNotice, Kpi, Loading, Panel } from '../../ui/bits';
import { Badge, toneOfKind, type Tone } from '../../ui/kit';
import { CHART_LARGE, CHART_SMALL, CHART_WIDE, ColumnChart } from '../../ui/ColumnChart';
import { Page, type Crumb } from '../Page';
import { useSession } from '../Shell';
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

function formatVital(vital: PerfVital, value: number | null): string {
  if (value === null || value === undefined) return '–';
  return vital.format === 'cls' ? value.toFixed(3) : formatMs(value);
}

const RATING_TONE: Record<VitalRating, Tone> = { good: 'green', 'needs-improvement': 'amber', poor: 'red' };

function RatingBadge({ rating }: { rating: VitalRating | null }) {
  return rating ? <Badge tone={RATING_TONE[rating]}>{RATING_TEXT[rating]}</Badge> : null;
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


const RIGHT: DataColumnMeta = { align: 'right' };
const WRAP: DataColumnMeta = { className: 'min-w-44 whitespace-normal break-all' };
/** Missing numbers sort below every real value. */
const num = (v: number | null | undefined): number => (v === null || v === undefined ? -1 : v);
const browserOf = (row: { browser: string | null; os: string | null }): string => [row.browser, row.os].filter(Boolean).join(' · ') || '–';
const warn = (on: boolean): string => `tabular-nums${on ? ' text-amber' : ''}`;

const endpointHelper = columnHelper<PerformanceResponse['endpoints'][number]>();
const endpointColumns = endpointHelper.columns([
  endpointHelper.accessor((e) => e.path, {
    id: 'endpoint',
    header: 'Endpoint',
    meta: WRAP,
    cell: ({ row }) => (
      <span title={row.original.key}>
        <span className="method">{row.original.method}</span><span className="muted">{row.original.origin}</span><span>{row.original.path}</span>
      </span>
    ),
  }),
  endpointHelper.accessor((e) => e.count, { id: 'count', header: 'Calls', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{row.original.count.toLocaleString()}</span> }),
  endpointHelper.accessor((e) => num(e.p50), { id: 'p50', header: 'p50', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.p50)}</span> }),
  endpointHelper.accessor((e) => num(e.p75), { id: 'p75', header: 'p75', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.p75)}</span> }),
  endpointHelper.accessor((e) => num(e.p95), { id: 'p95', header: 'p95', meta: RIGHT, cell: ({ row }) => <span className={warn(row.original.p95 !== null && row.original.p95 >= SECONDS_FROM_MS)}>{formatMs(row.original.p95)}</span> }),
  endpointHelper.accessor((e) => e.errorRate, { id: 'errorRate', header: 'Failed', meta: RIGHT, cell: ({ row }) => <span className={warn(row.original.errorRate > 0)}>{formatPercent(row.original.errorRate)}</span> }),
  endpointHelper.accessor((e) => num(e.avgServer), { id: 'avgServer', header: 'Server', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{formatMs(row.original.avgServer)}</span> }),
  endpointHelper.accessor((e) => num(e.avgDownload), { id: 'avgDownload', header: 'Download', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{formatMs(row.original.avgDownload)}</span> }),
]);

const pageHelper = columnHelper<PerformanceResponse['pages'][number]>();
const pageColumns = pageHelper.columns([
  pageHelper.accessor((p) => p.name, { id: 'name', header: 'Route / screen', meta: WRAP, cell: ({ row }) => row.original.name }),
  pageHelper.accessor((p) => p.views, { id: 'views', header: 'Views', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{row.original.views.toLocaleString()}</span> }),
  pageHelper.accessor((p) => num(p.load), { id: 'load', header: 'Load', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.load)}</span> }),
  pageHelper.accessor((p) => num(p.lcp), { id: 'lcp', header: 'LCP', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.lcp)} <RatingDot vital="lcp" value={row.original.lcp} /></span> }),
  pageHelper.accessor((p) => num(p.inp), { id: 'inp', header: 'INP', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.inp)} <RatingDot vital="inp" value={row.original.inp} /></span> }),
  pageHelper.accessor((p) => num(p.cls), { id: 'cls', header: 'CLS', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{row.original.cls === null ? '–' : row.original.cls.toFixed(3)} <RatingDot vital="cls" value={row.original.cls} /></span> }),
  pageHelper.accessor((p) => num(p.ttfb), { id: 'ttfb', header: 'TTFB', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{formatMs(row.original.ttfb)}</span> }),
]);

type CallRow = EndpointDetailResponse['samples'][number];
const callHelper = columnHelper<CallRow>();
/** Columns of the slowest-calls table; the Page link needs the view's current filters, which it reads from `linkRef`. */
function buildCallColumns(linkRef: MutableRefObject<(changes: Record<string, string | null>) => string>) {
  return callHelper.columns([
    callHelper.accessor((r) => num(r.duration_ms), { id: 'duration', header: 'Duration', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.duration_ms)}</span> }),
    callHelper.accessor((r) => num(r.server_ms), { id: 'server', header: 'Server', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{formatMs(row.original.server_ms)}</span> }),
    callHelper.accessor((r) => num(r.download_ms), { id: 'download', header: 'Download', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{formatMs(row.original.download_ms)}</span> }),
    callHelper.accessor((r) => num(r.size_bytes), { id: 'size', header: 'Size', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{formatBytes(row.original.size_bytes)}</span> }),
    callHelper.accessor((r) => r.failure || String(r.status), { id: 'status', header: 'Status', cell: ({ row }) => <Badge tone={toneOfKind(row.original.failed ? 'error' : 'info')} className="capitalize">{row.original.failure || String(row.original.status)}</Badge> }),
    callHelper.accessor((r) => r.page, { id: 'page', header: 'Page', meta: WRAP, cell: ({ row }) => <Link href={linkRef.current({ page: row.original.page, endpoint: null })}>{row.original.page}</Link> }),
    callHelper.accessor((r) => browserOf(r), { id: 'browser', header: 'Browser', cell: ({ row }) => <span className="text-muted">{browserOf(row.original)}</span> }),
    callHelper.accessor((r) => new Date(r.receivedAt).getTime(), { id: 'when', header: 'When', cell: ({ row }) => <span className="text-muted" title={formatDate(row.original.receivedAt)}>{timeAgo(row.original.receivedAt)}</span> }),
    callHelper.accessor((r) => r._id ?? '', { id: 'callId', header: 'Call id', cell: ({ row }) => <span className="font-mono text-xs text-muted">{row.original._id || '–'}</span> }),
  ]);
}

type LoadRow = PageDetailResponse['samples'][number];
const loadHelper = columnHelper<LoadRow>();
const loadColumns = loadHelper.columns([
  loadHelper.accessor((r) => num(r.vitals.page_load_ms), { id: 'load', header: 'Load', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.vitals.page_load_ms)}</span> }),
  loadHelper.accessor((r) => num(r.vitals.lcp_ms), { id: 'lcp', header: 'LCP', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.vitals.lcp_ms)}</span> }),
  loadHelper.accessor((r) => num(r.vitals.fcp_ms), { id: 'fcp', header: 'FCP', meta: RIGHT, cell: ({ row }) => <span className="tabular-nums">{formatMs(row.original.vitals.fcp_ms)}</span> }),
  loadHelper.accessor((r) => num(r.vitals.ttfb_ms), { id: 'ttfb', header: 'TTFB', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{formatMs(row.original.vitals.ttfb_ms)}</span> }),
  loadHelper.accessor((r) => num(r.long_tasks ? r.long_tasks.blocking_ms : null), { id: 'blocking', header: 'Blocking', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{row.original.long_tasks && row.original.long_tasks.blocking_ms ? formatMs(row.original.long_tasks.blocking_ms) : '–'}</span> }),
  loadHelper.accessor((r) => r.spanCount, { id: 'requests', header: 'Requests', meta: RIGHT, cell: ({ row }) => <span className="text-muted tabular-nums">{String(row.original.spanCount)}</span> }),
  loadHelper.accessor((r) => r.name, { id: 'path', header: 'URL path', meta: WRAP, cell: ({ row }) => <span className="text-muted">{row.original.name}</span> }),
  loadHelper.accessor((r) => browserOf(r), { id: 'browser', header: 'Browser', cell: ({ row }) => <span className="text-muted">{browserOf(row.original)}</span> }),
  loadHelper.accessor((r) => new Date(r.receivedAt).getTime(), { id: 'when', header: 'When', cell: ({ row }) => <span className="text-muted" title={formatDate(row.original.receivedAt)}>{timeAgo(row.original.receivedAt)}</span> }),
]);

/** Web Vitals, endpoints and pages of the project picked in the sidebar (`?range=&env=`, plus `&endpoint=<key>` or `&page=<route>` for a detail view). */
export function PerformanceView() {
  const router = useRouter();
  const query = useSearchParams();
  const range: Range = query.get('range') === '7d' ? '7d' : '24h';
  const environment = query.get('env') || '';
  const endpoint = query.get('endpoint');
  const page = query.get('page');
  const { projects, projectId } = useSession();

  const state = { range, env: environment };
  const link = (changes: Record<string, string | null>) => `/performance${queryString({ ...state, ...changes })}`;
  const go = (changes: Record<string, string | null>) => router.push(link(changes), { scroll: false });
  const base = `/api/stats${queryString({ view: 'performance', range, projectId: projectId ?? '', environment })}`;
  const overview = useApi<PerformanceResponse>(projectId ? base : null);

  const detailCrumbs = (label: string): Crumb[] => [{ label: 'Performance', href: link({}) }, { label }];
  const crumbs: Crumb[] = endpoint ? detailCrumbs(endpoint) : page ? detailCrumbs(page) : [{ label: 'Performance' }];

  const toolbar = projects && overview.data ? (
    <div className="toolbar">
      <div className="seg" role="group" aria-label="Time range">
        {(Object.keys(RANGE_LABELS) as Range[]).map((key) => (
          <button key={key} type="button" className={range === key ? 'active' : ''} onClick={() => go({ range: key, endpoint, page })}>{RANGE_LABELS[key]}</button>
        ))}
      </div>
      <select aria-label="Environment" value={environment} onChange={(e) => go({ env: e.target.value, endpoint, page })}>
        <option value="">All environments</option>
        {overview.data.environments.map((env) => <option key={env} value={env}>{env}</option>)}
      </select>
    </div>
  ) : null;

  let body: ReactNode;
  if (overview.error) body = <ErrorNotice error={overview.error} />;
  else if (!projects) body = <Loading />;
  else if (projects.length === 0) body = <Welcome />;
  else if (!overview.data) body = <Loading />;
  else if (endpoint) body = <EndpointDetail path={`${base}&endpoint=${encodeURIComponent(endpoint)}`} link={link} />;
  else if (page) body = <PageDetail path={`${base}&page=${encodeURIComponent(page)}`} />;
  else body = <Overview data={overview.data} range={range} link={link} />;

  return (
    <Page crumbs={crumbs}>
      {projects && projects.length > 0 ? toolbar : null}
      {body}
    </Page>
  );
}

function Overview({ data, range, link }: {
  data: PerformanceResponse;
  range: Range;
  link: (changes: Record<string, string | null>) => string;
}) {
  if (data.totals.views === 0 && data.totals.requests === 0) {
    return (
      <EmptyState icon="inbox" title="No performance data yet"
        text={`Page views appear here once your app runs ${SDK_PACKAGE} 0.5.0 or later. Each page view sends its Web Vitals and the timing of every request.`} />
    );
  }
  const labels = data.series.map((b) => bucketLabel(b.start, range));
  const sideLabel = RANGE_LABELS[range];

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

      <DataTable
        className="mt-6"
        title="Endpoints"
        description="Server = time to first byte, from the browser. Requests made while the tab was hidden are counted but not timed."
        data={data.endpoints}
        columns={endpointColumns}
        getRowId={(e) => e.key}
        initialSort={{ id: 'count', desc: true }}
        minWidth={900}
        rowHref={(e) => link({ endpoint: e.key })}
      />

      <DataTable
        className="mt-6"
        title="Pages"
        description={<>p75 per route, or per screen when the app names screens (setScreen). IDs in paths are grouped as {'{id}'}.</>}
        data={data.pages}
        columns={pageColumns}
        getRowId={(p) => p.name}
        initialSort={{ id: 'views', desc: true }}
        minWidth={760}
        rowHref={(p) => link({ page: p.name })}
      />
    </>
  );
}

function EndpointDetail({ path, link }: { path: string; link: (changes: Record<string, string | null>) => string }) {
  const linkRef = useRef(link);
  linkRef.current = link;
  const callColumns = useMemo(() => buildCallColumns(linkRef), []);
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
      <DataTable
        className="mt-6"
        title="Slowest calls"
        description="From the last 7 days at most; hidden-tab calls are left out."
        data={data.samples}
        columns={callColumns}
        getRowId={(row, i) => row._id ?? `sample-${i}`}
        initialSort={{ id: 'duration', desc: true }}
        minWidth={980}
        empty="No recent calls kept for this endpoint."
      />
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
      <DataTable
        className="mt-6"
        title="Slowest page loads"
        description="From the last 7 days at most; loads in a hidden tab are left out."
        data={data.samples}
        columns={loadColumns}
        getRowId={(row, i) => `${String(row.receivedAt)}-${i}`}
        initialSort={{ id: 'load', desc: true }}
        minWidth={920}
        empty="No recent full page loads kept for this route."
      />
    </>
  );
}
