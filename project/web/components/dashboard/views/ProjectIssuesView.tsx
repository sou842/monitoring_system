'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, prefetch, useApi } from '@/lib/client/api';
import { formatDate, queryString, setupSnippet, timeAgo } from '@/lib/format';
import { ISSUE_EVENT_TYPES, ISSUE_STATUSES } from '@/lib/schema';
import type { IssuesResponse, ProjectsResponse } from '@/lib/types';
import { Avatar, Badge, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { KeyBox, useOrigin } from '../../ui/KeyBox';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { InsightsPanel, insightsLabel, OriginsPanel, originsLabel } from '../ProjectSettings';

const STATUSES = [...ISSUE_STATUSES, 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];
const SORT_OPTIONS: Array<[string, string]> = [['lastSeen', 'Last seen'], ['count', 'Most events'], ['firstSeen', 'Newest']];

/** One project's issues, with filters in the URL (`?status=&type=&env=&q=&sort=&page=`), and the project's settings. */
export function ProjectIssuesView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const query = useSearchParams();
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const origin = useOrigin();

  const filters = {
    status: (STATUSES as readonly string[]).includes(query.get('status') ?? '') ? (query.get('status') as StatusFilter) : 'open',
    type: query.get('type') || '',
    env: query.get('env') || '',
    q: query.get('q') || '',
    sort: query.get('sort') || 'lastSeen',
    page: Number(query.get('page')) || 1,
  };
  const projectsState = useApi<ProjectsResponse>('/api/projects');
  const project = projectsState.data?.projects.find((p) => p.id === projectId);
  const issuesState = useApi<IssuesResponse>(project ? `/api/issues${queryString({ projectId, ...filters })}` : null);
  const data = issuesState.data;

  const [search, setSearch] = useState(filters.q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<'origins' | 'insights' | null>(null);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  useEffect(() => setSearch(filters.q), [filters.q]);
  // A new page of results starts with nothing selected; ids no longer listed are dropped.
  const listedIds = data ? data.issues.map((i) => i.id).join(',') : '';
  useEffect(() => {
    setSelected((current) => new Set([...current].filter((id) => listedIds.split(',').includes(id))));
  }, [listedIds]);

  const setFilter = (changes: Partial<Record<keyof typeof filters, string>>) => {
    const next = { ...filters, page: '1', ...changes };
    router.push(`/projects/${projectId}${queryString({ ...next, status: next.status === 'open' ? '' : next.status, page: next.page === '1' ? '' : next.page })}`, { scroll: false });
  };

  const crumbs = [{ label: 'Projects', href: '/projects' }, ...(project ? [{ label: project.name }] : [])];
  const error = projectsState.error || issuesState.error;
  if (error) return <Page crumbs={crumbs}><ErrorNotice error={error} /></Page>;
  if (projectsState.data && !project) return <Page crumbs={crumbs}><ErrorNotice error={new Error('Project not found')} /></Page>;
  if (!project || !data) return <Page crumbs={crumbs}><Loading /></Page>;

  if (rotatedKey) {
    return (
      <Page crumbs={crumbs}>
        <KeyBox title={`New API key for "${project.name}"`} apiKey={rotatedKey} onDone={() => setRotatedKey(null)} />
      </Page>
    );
  }

  const allCount = data.counts.open + data.counts.resolved + data.counts.ignored;
  const clearLabel = filters.status === 'all' ? 'all' : filters.status;
  const clearCount = filters.status === 'all' ? allCount : data.counts[filters.status];
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const allSelected = data.issues.length > 0 && data.issues.every((i) => selected.has(i.id));

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const deleteSelected = action(async () => {
    const count = selected.size;
    const ok = await openDialog({
      title: `Delete ${count} issue(s)?`,
      message: "The selected issues and all their events will be deleted. This can't be undone.",
      confirmText: 'Delete',
      danger: true,
      onConfirm: () => api(`/api/issues?projectId=${projectId}`, { method: 'DELETE', body: { ids: [...selected] } }),
    });
    if (!ok) return;
    setSelected(new Set());
    toast(`Deleted ${count} issue(s)`);
  });

  const clearAll = action(async () => {
    const ok = await openDialog({
      title: `Delete ${clearCount} ${filters.status === 'all' ? '' : clearLabel + ' '}issue(s)?`,
      message: `All ${filters.status === 'all' ? '' : clearLabel + ' '}issues of "${project.name}" and their events will be deleted. This can't be undone.`,
      confirmText: 'Delete all',
      danger: true,
      onConfirm: () => api(`/api/issues?projectId=${projectId}&status=${filters.status}`, { method: 'DELETE' }),
    });
    if (ok) toast(`Deleted ${clearCount} issue(s)`);
  });

  const rotate = action(async () => {
    let apiKey: string | null = null;
    const ok = await openDialog({
      title: 'Rotate the API key?',
      message: `"${project.name}" gets a new key and the current one stops working immediately. Apps using it stop sending errors until you update them.`,
      confirmText: 'Rotate key',
      onConfirm: async () => {
        apiKey = (await api<{ apiKey: string }>(`/api/projects?id=${projectId}&action=rotate-key`, { method: 'POST' })).apiKey;
      },
    });
    if (ok && apiKey) setRotatedKey(apiKey);
  });

  const deleteProject = action(async () => {
    const typed = await openDialog({
      title: `Delete "${project.name}"?`,
      message: "The project, every issue and event in it, and its API key will be deleted. Apps using the key stop reporting. This can't be undone.",
      confirmText: 'Delete project',
      danger: true,
      input: { label: `Type “${project.name}” to confirm`, autocomplete: 'off' },
      onConfirm: async (value) => {
        if (value.trim() !== project.name) throw new Error('The name does not match');
        await api(`/api/projects?id=${projectId}`, { method: 'DELETE' });
      },
    });
    if (typed === null) return;
    toast(`Project "${project.name}" deleted`);
    router.push('/projects');
  });

  return (
    <Page crumbs={crumbs}>
      <div className="page-head">
        <Avatar name={project.name} size="lg" />
        <h1>{project.name}</h1>
        <span className="spacer" />
        <button type="button" className={`ghost${project.allowedOrigins.length === 0 ? ' warn' : ''}`} aria-expanded={panel === 'origins'}
          onClick={() => setPanel(panel === 'origins' ? null : 'origins')}>
          {originsLabel(project.allowedOrigins)}
        </button>
        <button type="button" className="ghost" aria-expanded={panel === 'insights'} onClick={() => setPanel(panel === 'insights' ? null : 'insights')}>
          {insightsLabel(project.insights)}
        </button>
        <button type="button" className="ghost" onClick={rotate}>Rotate API key</button>
        <button type="button" className="ghost danger" onClick={deleteProject}>Delete project</button>
      </div>
      <p className="page-sub">{data.total} issue(s)</p>

      {panel === 'origins' ? <OriginsPanel project={project} /> : null}
      {panel === 'insights' ? <InsightsPanel project={project} onSaved={() => {}} /> : null}

      <div className="tabs" role="tablist">
        {STATUSES.map((s) => (
          <button key={s} type="button" role="tab" aria-selected={filters.status === s} className={filters.status === s ? 'active' : ''} onClick={() => setFilter({ status: s })}>
            {`${s[0].toUpperCase()}${s.slice(1)} (${s === 'all' ? allCount : data.counts[s]})`}
          </button>
        ))}
      </div>
      <div className="filters">
        <input
          type="search"
          placeholder="Search message, type, location or API call id…"
          aria-label="Search issues"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') setFilter({ q: search.trim() }); }}
        />
        <select aria-label="Event type" value={filters.type} onChange={(e) => setFilter({ type: e.target.value })}>
          <option value="">All types</option>
          {ISSUE_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select aria-label="Environment" value={filters.env} onChange={(e) => setFilter({ env: e.target.value })}>
          <option value="">All environments</option>
          {data.environments.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <select aria-label="Sort" value={filters.sort} onChange={(e) => setFilter({ sort: e.target.value })}>
          {SORT_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select>
      </div>

      {data.issues.length > 0 ? (
        <div className="row bulk">
          <button type="button" className="danger" disabled={selected.size === 0} onClick={deleteSelected}>
            {selected.size > 0 ? `Delete selected (${selected.size})` : 'Delete selected'}
          </button>
          <span className="spacer" />
          <button type="button" className="danger" disabled={clearCount === 0} onClick={clearAll}>
            {filters.status === 'all' ? `Delete everything (${clearCount})` : `Delete all ${clearLabel} (${clearCount})`}
          </button>
        </div>
      ) : null}

      {data.issues.length === 0 ? (
        allCount === 0 ? (
          <EmptyState icon="inbox" title="No issues yet" text={`Errors appear here as soon as an app using this project's key (${project.apiKeyHint}) sends them. Setup:`}>
            <div className="key-box mt-4 max-w-full text-left"><pre>{setupSnippet('<your API key>', origin)}</pre></div>
          </EmptyState>
        ) : (
          <EmptyState icon="search" title="No issues match these filters" text="Try a different status, type or search term." />
        )
      ) : (
        <div className="card issue-list">
          <div className="list-head">
            <input type="checkbox" aria-label="Select all issues on this page" checked={allSelected}
              onChange={(e) => setSelected(e.target.checked ? new Set(data.issues.map((i) => i.id)) : new Set())} />
            <span>Issue</span><span>Events</span><span>Last seen</span>
          </div>
          {data.issues.map((issue) => {
            // Found by an API call's _id: open the event that recorded that call.
            const href = issue.matchedEventId ? `/issues/${issue.id}?event=${issue.matchedEventId}` : `/issues/${issue.id}`;
            const warm = () => prefetch(`/api/issue?id=${issue.id}`);
            return (
              <Link key={issue.id} className={`issue-row sev-${issue.eventType}`} href={href} onMouseEnter={warm} onFocus={warm}>
                <input type="checkbox" aria-label="Select issue" checked={selected.has(issue.id)}
                  onClick={(e) => e.stopPropagation()} onChange={(e) => toggle(issue.id, e.target.checked)} />
                <div className="min-w-0">
                  <div className="issue-title">
                    <Badge text={issue.eventType} />{issue.errorType}
                    {issue.status !== 'open' ? <Badge text={issue.status} /> : null}
                    {issue.regressedAt && issue.status === 'open' ? <Badge text="regressed" kind="error" /> : null}
                  </div>
                  <div className="issue-msg">{issue.message || '(no message)'}</div>
                  <div className="issue-meta">{[issue.culprit, issue.environments.join(', ')].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="issue-count">{issue.count.toLocaleString()}</div>
                <div className="issue-when" title={formatDate(issue.lastSeen)}>{timeAgo(issue.lastSeen)}</div>
              </Link>
            );
          })}
        </div>
      )}

      {pages > 1 ? (
        <div className="pager">
          <button type="button" disabled={filters.page <= 1} onClick={() => setFilter({ page: String(filters.page - 1) })}>Previous</button>
          <span className="muted">Page {filters.page} of {pages}</span>
          <button type="button" disabled={filters.page >= pages} onClick={() => setFilter({ page: String(filters.page + 1) })}>Next</button>
        </div>
      ) : null}
    </Page>
  );
}
