'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, useApi } from '@/lib/client/api';
import type { ProjectKeyResponse, ProjectsResponse } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, Button, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { Field } from '../../ui/fields';
import { Icon } from '../../ui/Icon';
import { KeyBox } from '../../ui/KeyBox';
import { CARD, PageTitle, Pill, PillButton, pillButton } from '../../ui/kit';
import { Page, scrollPageToTop } from '../Page';
import { useSession } from '../Shell';

/** Column layout shared by the list header and its rows (project, open issues, events, arrow). */
const LIST_COLS = 'md:grid md:grid-cols-[minmax(0,1fr)_110px_110px_16px] md:items-center md:gap-4 px-5';

/** Your projects, each with its API key hint; create a new one (its key is shown once). */
export function ProjectsView() {
  const router = useRouter();
  const query = useSearchParams();
  const { data, error } = useApi<ProjectsResponse>('/api/projects');
  const { projectId, setProjectId } = useSession();
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<{ title: string; apiKey: string } | null>(null);

  const limit = data ? data.limit : null;
  const projects = data ? data.projects : [];
  // `limit` is null when accounts may have any number of projects.
  const atLimit = limit !== null && projects.length >= limit;

  // ?new=1 (from the welcome guide) opens the form right away.
  const wantsNew = query.get('new') === '1';
  useEffect(() => {
    if (wantsNew && data && !atLimit) setCreating(true);
  }, [wantsNew, data, atLimit]);

  return (
    <Page crumbs={[{ label: 'Projects' }]}>
      {error ? <ErrorNotice error={error} /> : !data ? <Loading /> : (
        <>
          <PageTitle
            title="Projects"
            sub={atLimit ? `You have reached the limit of ${limit} projects. Delete a project to create another.` : 'Each app that sends errors is a project with its own API key.'}
            actions={(
              <>
                <Pill tone={atLimit ? 'amber' : 'neutral'}>{limit === null ? `${projects.length} project(s)` : `${projects.length} / ${limit} projects`}</Pill>
                <PillButton variant="primary" disabled={atLimit || creating} title={atLimit ? `You can have at most ${limit} projects` : undefined} onClick={() => setCreating(true)}>
                  <Icon name="plus" className="size-4" />New project
                </PillButton>
              </>
            )}
          />

          {newKey ? (
            <KeyBox title={newKey.title} apiKey={newKey.apiKey} onDone={() => { setNewKey(null); scrollPageToTop(); }} />
          ) : creating ? (
            <CreateProjectForm
              onCancel={() => {
                setCreating(false);
                if (wantsNew) router.replace('/projects', { scroll: false });
              }}
              onCreated={({ project, apiKey }) => {
                setCreating(false);
                setNewKey({ title: `Project "${project.name}" created`, apiKey });
                if (wantsNew) router.replace('/projects', { scroll: false });
              }}
            />
          ) : null}

          {projects.length > 0 ? (
            <div className={cn(CARD, 'mt-6 overflow-hidden')}>
              <div className={cn(LIST_COLS, 'border-b border-line bg-panel-2 py-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase max-md:hidden')}>
                <span>Project</span>
                <span className="text-right">Open issues</span>
                <span className="text-right">Events (24h)</span>
                <span className="w-4" />
              </div>
              <ul className="m-0 list-none divide-y divide-line p-0">
                {projects.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/projects/${p.id}`}
                      onClick={() => setProjectId(p.id)}
                      className={cn(LIST_COLS, 'group py-3.5 text-fg no-underline transition-colors hover:bg-(--hover) hover:no-underline max-md:flex max-md:flex-wrap max-md:gap-y-2')}
                    >
                      <div className="flex min-w-0 items-center gap-3 max-md:basis-full">
                        <Avatar name={p.name} shape="square" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h2 className="m-0 truncate text-sm font-semibold text-fg">{p.name}</h2>
                            {p.id === projectId ? <Pill tone="dark">Selected</Pill> : null}
                            {p.role === 'member' ? <Pill tone="muted">Shared</Pill> : null}
                            {p.unreadMessages > 0 ? <Pill tone="dark">{p.unreadMessages > 99 ? '99+' : p.unreadMessages} new</Pill> : null}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted">
                            {p.role === 'member'
                              ? `Shared by ${p.ownerName ?? 'the owner'}`
                              : <span className="font-mono">Key {p.apiKeyHint} · {p.allowedOrigins.length === 0 ? 'any origin' : `${p.allowedOrigins.length} origin(s)`}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="text-right max-md:text-left">
                        {p.openIssues > 0
                          ? <Pill tone="red" className="tabular-nums">{p.openIssues.toLocaleString()}<span className="md:hidden">&nbsp;open</span></Pill>
                          : <span className="text-[13px] text-muted tabular-nums">0<span className="md:hidden"> open</span></span>}
                      </div>
                      <div className="text-right text-[13px] tabular-nums max-md:text-left">
                        {p.events24h.toLocaleString()}<span className="text-muted md:hidden"> events (24h)</span>
                      </div>
                      <Icon name="chevron" className="size-4 -rotate-90 text-muted transition-transform group-hover:translate-x-0.5 max-md:hidden" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState icon="folder" title="No projects yet" text="Create your first project to get an API key and start tracking errors." />
          )}
        </>
      )}
    </Page>
  );
}

function CreateProjectForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (result: ProjectKeyResponse) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a project name');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      onCreated(await api<ProjectKeyResponse>('/api/projects', { method: 'POST', body: { name } }));
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  return (
    <div className={cn(CARD, 'p-5 md:p-6')}>
      <h3 className="m-0 mb-4 text-sm font-semibold">New project</h3>
      <form className="grid max-w-md gap-4" noValidate onSubmit={submit}>
        <Field
          ref={inputRef}
          label="Project name"
          placeholder="e.g. Web shop"
          maxLength={80}
          autoComplete="off"
          hint="Usually the name of the app or website that will send errors."
          value={name}
          onValue={(v) => { setName(v); setError(null); }}
          error={error}
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={pillButton('ghost')} onClick={onCancel}>Cancel</button>
          <Button type="submit" className={pillButton('primary')} busy={busy}>Create project</Button>
        </div>
      </form>
    </div>
  );
}
