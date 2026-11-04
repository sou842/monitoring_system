'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, prefetch, useApi } from '@/lib/client/api';
import { formatDate, queryString, setupSnippet, timeAgo } from '@/lib/format';
import type { Permission } from '@/lib/permissions';
import { ISSUE_EVENT_TYPES, ISSUE_STATUSES } from '@/lib/schema';
import type { IssuesResponse, IssueListItem, ProjectsResponse } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, EmptyState, ErrorNotice, Loading, SettingsCard } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { KeyBox, useOrigin } from '../../ui/KeyBox';
import { CARD, PageTitle, Pill, PillButton, TabBar, type Tone } from '../../ui/kit';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { MembersPanel } from '../MembersPanel';
import { InsightsPanel, OriginsPanel } from '../ProjectSettings';
import { useSession } from '../Shell';

const STATUSES = [...ISSUE_STATUSES, 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];
const SORT_OPTIONS: Array<[string, string]> = [['lastSeen', 'Last seen'], ['count', 'Most events'], ['firstSeen', 'Newest']];
type ProjectTab = 'issues' | 'members' | 'settings';

const FIELD = 'h-9 rounded-full border border-line-strong bg-panel px-4 text-[13px] text-fg placeholder:text-faint';
const EVENT_TONE: Record<string, Tone> = { crash: 'dark', error: 'red', performance: 'amber', message: 'neutral' };
const SEVERITY_DOT: Record<string, string> = { crash: 'bg-fg', error: 'bg-red-500', performance: 'bg-amber-500' };
const LIST_COLUMNS = 'grid grid-cols-[24px_minmax(0,1fr)] gap-x-4 sm:grid-cols-[24px_minmax(0,1fr)_80px_110px]';

/** One project: its issues (filters in the URL: `?status=&type=&env=&q=&sort=&page=`) and, under "Settings", its keys, origins and insights. */
export function ProjectIssuesView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const query = useSearchParams();
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const origin = useOrigin();
  const { setProjectId } = useSession();

  const requestedTab = query.get('tab');
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
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);

  // Opening a project's page (from a link, a bookmark or the project list) makes it the active project.
  const known = Boolean(project);
  useEffect(() => {
    if (known) setProjectId(projectId);
  }, [known, projectId, setProjectId]);

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
  const setTab = (id: ProjectTab) =>
    router.push(id === 'issues' ? `/projects/${projectId}` : `/projects/${projectId}?tab=${id}`, { scroll: false });

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

  // What this account may do here (the server checks every request again).
  const can = (permission: Permission) => project.permissions.includes(permission);
  const isOwner = project.role === 'owner';
  const showSettings = can('settings.manage') || can('key.manage') || isOwner;
  const tabs: Array<{ id: ProjectTab; label: string }> = [
    { id: 'issues', label: 'Issues' },
    { id: 'members', label: 'Members' },
    ...(showSettings ? [{ id: 'settings' as const, label: 'Settings' }] : []),
  ];
  const tab: ProjectTab = tabs.some((t) => t.id === requestedTab) ? (requestedTab as ProjectTab) : 'issues';

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
      <PageTitle
        lead={<Avatar name={project.name} size="lg" shape="square" />}
        title={project.name}
        sub={`${data.total.toLocaleString()} issue(s) · ${project.events24h.toLocaleString()} events in the last 24 h`}
        actions={project.allowedOrigins.length === 0 && can('settings.manage') ? (
          <button type="button" onClick={() => setTab('settings')} className="cursor-pointer rounded-full border-0 bg-amber-500/15 shadow-none px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            Any origin can send events · set allowed origins
          </button>
        ) : null}
      />

      <TabBar label="Project" tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'members' ? (
        <MembersPanel projectId={projectId} projectName={project.name} />
      ) : tab === 'settings' ? (
        <div className="grid gap-4 [&>.section]:mt-0">
          {can('key.manage') ? (
            <SettingsCard title="API key" description={`Apps send events with this key. Current key: ${project.apiKeyHint}`}>
              <p className="m-0 text-[13px] text-muted">The full key is shown only when it is created. Rotating gives you a new one and the current key stops working at once.</p>
              <div><PillButton onClick={rotate}>Rotate API key</PillButton></div>
            </SettingsCard>
          ) : null}
          {can('settings.manage') ? <OriginsPanel project={project} /> : null}
          {can('settings.manage') ? <InsightsPanel project={project} onSaved={() => {}} /> : null}
          {isOwner ? (
            <SettingsCard title="Danger zone" description="This can't be undone.">
              <p className="m-0 text-[13px] text-muted">Deleting the project removes every issue, event, member and chat message in it, and its API key.</p>
              <div><PillButton variant="danger" onClick={deleteProject}>Delete project</PillButton></div>
            </SettingsCard>
          ) : null}
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
              {STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={filters.status === s}
                  onClick={() => setFilter({ status: s })}
                  className={cn(
                    'h-8 cursor-pointer rounded-full border-0 px-3.5 shadow-none text-[13px] font-medium transition-colors',
                    filters.status === s ? 'bg-invert-bg text-invert-fg' : 'bg-transparent text-muted hover:bg-(--hover) hover:text-fg',
                  )}
                >
                  {`${s[0].toUpperCase()}${s.slice(1)} · ${s === 'all' ? allCount : data.counts[s]}`}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <input
              type="search"
              placeholder="Search message, type, location or API call id…"
              aria-label="Search issues"
              className={cn(FIELD, 'min-w-56 flex-1')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setFilter({ q: search.trim() }); }}
            />
            <select aria-label="Event type" className={FIELD} value={filters.type} onChange={(e) => setFilter({ type: e.target.value })}>
              <option value="">All types</option>
              {ISSUE_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select aria-label="Environment" className={FIELD} value={filters.env} onChange={(e) => setFilter({ env: e.target.value })}>
              <option value="">All environments</option>
              {data.environments.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <select aria-label="Sort" className={FIELD} value={filters.sort} onChange={(e) => setFilter({ sort: e.target.value })}>
              {SORT_OPTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </div>

          {data.issues.length > 0 && can('issues.delete') ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <PillButton variant="danger" className="h-8" disabled={selected.size === 0} onClick={deleteSelected}>
                {selected.size > 0 ? `Delete selected (${selected.size})` : 'Delete selected'}
              </PillButton>
              <span className="flex-1" />
              <PillButton variant="ghost" className="h-8 hover:text-danger" disabled={clearCount === 0} onClick={clearAll}>
                {filters.status === 'all' ? `Delete everything (${clearCount})` : `Delete all ${clearLabel} (${clearCount})`}
              </PillButton>
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
            <div className={cn(CARD, 'overflow-hidden')}>
              <div className={cn(LIST_COLUMNS, 'items-center border-b border-line bg-panel-2 px-5 py-2.5 text-xs font-medium text-muted')}>
                <input type="checkbox" aria-label="Select all issues on this page" checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Set(data.issues.map((i) => i.id)) : new Set())} />
                <span>Issue</span>
                <span className="hidden text-right sm:block">Events</span>
                <span className="hidden text-right sm:block">Last seen</span>
              </div>
              {data.issues.map((issue) => <IssueRow key={issue.id} issue={issue} selected={selected.has(issue.id)} onToggle={(on) => toggle(issue.id, on)} />)}
            </div>
          )}

          {pages > 1 ? (
            <div className="mt-4 flex items-center justify-end gap-3 text-[13px] text-muted">
              <PillButton disabled={filters.page <= 1} onClick={() => setFilter({ page: String(filters.page - 1) })}>Previous</PillButton>
              <span>Page {filters.page} of {pages}</span>
              <PillButton disabled={filters.page >= pages} onClick={() => setFilter({ page: String(filters.page + 1) })}>Next</PillButton>
            </div>
          ) : null}
        </>
      )}
    </Page>
  );
}

/** One issue in the list: a link to the issue (or to the event that matched an API call id). */
function IssueRow({ issue, selected, onToggle }: { issue: IssueListItem; selected: boolean; onToggle: (on: boolean) => void }) {
  // Found by an API call's _id: open the event that recorded that call.
  const href = issue.matchedEventId ? `/issues/${issue.id}?event=${issue.matchedEventId}` : `/issues/${issue.id}`;
  const warm = () => prefetch(`/api/issue?id=${issue.id}`);
  const meta = [issue.culprit, issue.environments.join(', ')].filter(Boolean).join(' · ');
  return (
    <Link
      href={href}
      onMouseEnter={warm}
      onFocus={warm}
      className={cn(LIST_COLUMNS, 'items-start border-t border-line/70 px-5 py-3.5 text-fg no-underline first:border-t-0 hover:bg-(--hover) hover:no-underline')}
    >
      <input type="checkbox" aria-label="Select issue" className="mt-1" checked={selected} onClick={(e) => e.stopPropagation()} onChange={(e) => onToggle(e.target.checked)} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className={cn('size-2 shrink-0 rounded-full', SEVERITY_DOT[issue.eventType] ?? 'bg-muted')} aria-hidden="true" />
          {issue.errorType}
          <Pill tone={EVENT_TONE[issue.eventType] ?? 'neutral'}>{issue.eventType}</Pill>
          {issue.status !== 'open' ? <Pill tone="muted">{issue.status}</Pill> : null}
          {issue.regressedAt && issue.status === 'open' ? <Pill tone="red">regressed</Pill> : null}
        </div>
        <div className="mt-1 truncate text-[13px] text-fg-2">{issue.message || '(no message)'}</div>
        {meta ? <div className="mt-1 truncate text-xs text-muted">{meta}</div> : null}
        <div className="mt-1 text-xs text-muted sm:hidden">{issue.count.toLocaleString()} events · {timeAgo(issue.lastSeen)}</div>
      </div>
      <div className="hidden text-right text-sm tabular-nums sm:block">{issue.count.toLocaleString()}</div>
      <div className="hidden text-right text-xs text-muted sm:block" title={formatDate(issue.lastSeen)}>{timeAgo(issue.lastSeen)}</div>
    </Link>
  );
}
