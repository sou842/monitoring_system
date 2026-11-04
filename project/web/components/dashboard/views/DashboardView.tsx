'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/client/api';
import { bucketLabel, queryString, RANGE_LABELS, type Range } from '@/lib/format';
import type { StatsResponse } from '@/lib/types';
import { ErrorNotice, Loading, Panel } from '../../ui/bits';
import { CHART_LARGE, CHART_SMALL, ColumnChart } from '../../ui/ColumnChart';
import { Page } from '../Page';
import { useSession } from '../Shell';
import { Welcome } from '../Welcome';

const ISSUE_TICKS = 50;

function deltaText(total: number, previous: number, range: Range): string {
  if (previous === 0) return total === 0 ? 'No events yet' : 'No events in the previous period';
  const percent = Math.round(((total - previous) / previous) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}% vs previous ${RANGE_LABELS[range].toLowerCase()}`;
}

/** Overview charts for the project picked in the sidebar (`?range=24h|7d`). */
export function DashboardView() {
  const router = useRouter();
  const query = useSearchParams();
  const range: Range = query.get('range') === '7d' ? '7d' : '24h';
  const { projects, projectId } = useSession();
  const stats = useApi<StatsResponse>(projectId ? `/api/stats${queryString({ range, projectId })}` : null);
  const project = projects && projectId ? projects.find((p) => p.id === projectId) : undefined;

  const change = (changes: { range?: Range }) =>
    router.push(`/dashboard${queryString({ range, ...changes })}`, { scroll: false });

  const content = () => {
    if (stats.error) return <ErrorNotice error={stats.error} />;
    if (!projects) return <Loading />;
    if (projects.length === 0) return <Welcome />;
    const s = stats.data;
    if (!s) return <Loading />;

    const labels = s.series.map((b) => bucketLabel(b.start, range));
    const totals = s.series.map((b) => b.error + b.message + b.performance + b.crash);
    const incidents = s.series.map((b) => b.error + b.crash);
    const sideLabel = RANGE_LABELS[range];
    const { open, resolved, ignored } = s.statuses;
    const issueTotal = open + resolved + ignored;
    const onTicks = issueTotal === 0 ? 0 : Math.round((open / issueTotal) * ISSUE_TICKS);
    const typeMax = Math.max(...Object.values(s.byType), 1);
    const topMax = Math.max(...s.topIssues.map((i) => i.count), 1);

    return (
      <div className="dash-grid">
        <Panel label="Events" side={sideLabel}>
          <div className="big">{s.total.toLocaleString()}</div>
          <div className="delta">{deltaText(s.total, s.previousTotal, range)}</div>
          <div className="mt-4"><ColumnChart values={totals} labels={labels} size={CHART_SMALL} /></div>
        </Panel>

        <Panel label="Issues" side="NOW">
          <div className="big">{open.toLocaleString()}<small>open</small></div>
          <div className="ticks" aria-hidden="true">
            {Array.from({ length: ISSUE_TICKS }, (_, i) => <i key={i} className={i < onTicks ? 'on' : ''} />)}
          </div>
          <div className="tick-legend">
            <span>Open {issueTotal === 0 ? 0 : Math.round((open / issueTotal) * 100)}%</span>
            <span className="muted">Resolved {resolved} · Ignored {ignored}</span>
          </div>
          {project ? (
            <div className="list-lines">
              <Link href={`/projects/${project.id}`}>
                <span className={`k${project.openIssues === 0 ? ' off' : ''}`}>View issues of {project.name}</span>
                <span className="muted">{project.openIssues} open</span>
              </Link>
            </div>
          ) : null}
        </Panel>

        <Panel label="Event types" side={sideLabel}>
          <div className="hbars">
            {Object.entries(s.byType).sort((a, b) => b[1] - a[1]).map(([type, n]) => (
              <div key={type} className={`hbar-row type-${type}`}>
                <div className="top"><span>{type}</span><span>{n.toLocaleString()}</span></div>
                <div className="hbar"><i style={{ width: `${(n / typeMax) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="span-2" label="Error trend monitor" side={sideLabel}>
          <h3 className="panel-title">Incident Flow</h3>
          <div className="legend"><span><i />Errors + crashes per {range === '7d' ? 'day' : 'hour'}</span></div>
          <ColumnChart values={incidents} labels={labels} size={CHART_LARGE} axis />
        </Panel>

        <Panel label="Top issues" side={sideLabel}>
          <h3 className="panel-title">Incident Volume</h3>
          {s.topIssues.length === 0 ? (
            <p className="muted">No events in this range.</p>
          ) : (
            <div className="hbars mt-[18px]">
              {s.topIssues.map((issue) => (
                <Link key={issue.id} className="hbar-row" href={`/issues/${issue.id}`} title={issue.message || issue.errorType}>
                  <div className="top"><span>{issue.errorType}</span><span>{issue.count.toLocaleString()}</span></div>
                  <div className="hbar"><i style={{ width: `${(issue.count / topMax) * 100}%` }} /></div>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>
    );
  };

  return (
    <Page crumbs={[{ label: 'Dashboard' }]}>
      {projects && projects.length > 0 ? (
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Time range">
            {(Object.keys(RANGE_LABELS) as Range[]).map((key) => (
              <button key={key} type="button" className={range === key ? 'active' : ''} onClick={() => change({ range: key })}>{RANGE_LABELS[key]}</button>
            ))}
          </div>
        </div>
      ) : null}
      {content()}
    </Page>
  );
}
