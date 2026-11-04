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
            <div className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {projects.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  onClick={() => setProjectId(p.id)}
                  className={cn(CARD, 'block p-5 text-fg no-underline transition hover:-translate-y-0.5 hover:no-underline hover:shadow-(--menu-shadow)')}
                >
                  <div className="mb-5 flex items-center gap-3">
                    <Avatar name={p.name} shape="square" />
                    <h2 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{p.name}</h2>
                    {p.id === projectId ? <Pill tone="dark">Selected</Pill> : null}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className={cn('rounded-xl px-3 py-2.5', p.openIssues > 0 ? 'bg-red-500/10' : 'bg-panel-2')}>
                      <b className={cn('block text-xl leading-tight font-semibold tabular-nums', p.openIssues > 0 && 'text-red-600 dark:text-red-400')}>{p.openIssues.toLocaleString()}</b>
                      <span className="text-xs text-muted">open issues</span>
                    </div>
                    <div className="rounded-xl bg-panel-2 px-3 py-2.5">
                      <b className="block text-xl leading-tight font-semibold tabular-nums">{p.events24h.toLocaleString()}</b>
                      <span className="text-xs text-muted">events (24h)</span>
                    </div>
                  </div>
                  <div className="mt-4 truncate font-mono text-xs text-muted">Key: {p.apiKeyHint} · {p.allowedOrigins.length === 0 ? 'any origin' : `${p.allowedOrigins.length} origin(s)`}</div>
                </Link>
              ))}
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
