'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, useApi } from '@/lib/client/api';
import type { ProjectKeyResponse, ProjectsResponse } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { Field } from '../../ui/fields';
import { Icon } from '../../ui/Icon';
import { KeyBox } from '../../ui/KeyBox';
import { CARD, PageTitle, Badge, PillButton, pillButton } from '../../ui/kit';
import { ProjectsTable } from './ProjectsTable';
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
                <Badge tone={atLimit ? 'amber' : 'neutral'}>{limit === null ? `${projects.length} project(s)` : `${projects.length} / ${limit} projects`}</Badge>
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
            <ProjectsTable projects={projects} activeId={projectId} onOpen={setProjectId} />
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
