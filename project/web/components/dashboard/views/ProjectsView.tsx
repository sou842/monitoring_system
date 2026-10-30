'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, useApi } from '@/lib/client/api';
import type { ProjectKeyResponse, ProjectsResponse } from '@/lib/types';
import { Avatar, Button, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { Field } from '../../ui/fields';
import { KeyBox } from '../../ui/KeyBox';
import { Page } from '../Page';

/** Your projects, each with its API key hint; create a new one (its key is shown once). */
export function ProjectsView() {
  const router = useRouter();
  const query = useSearchParams();
  const { data, error } = useApi<ProjectsResponse>('/api/projects');
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
          <div className="page-head">
            <h1>Projects</h1>
            <span className="spacer" />
            <span className={`usage-pill${atLimit ? ' full' : ''}`}>{limit === null ? `${projects.length} project(s)` : `${projects.length} / ${limit} projects`}</span>
            <button type="button" className="primary" disabled={atLimit || creating} title={atLimit ? `You can have at most ${limit} projects` : undefined} onClick={() => setCreating(true)}>
              New project
            </button>
          </div>
          <p className="page-sub">
            {atLimit ? `You have reached the limit of ${limit} projects. Delete a project to create another.` : 'Each app that sends errors is a project with its own API key.'}
          </p>

          {newKey ? (
            <KeyBox title={newKey.title} apiKey={newKey.apiKey} onDone={() => { setNewKey(null); window.scrollTo(0, 0); }} />
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
            <div className="grid section">
              {projects.map((p) => (
                <div key={p.id} className="card project">
                  <Link className="project-card" href={`/projects/${p.id}`}>
                    <div className="project-top"><Avatar name={p.name} /><h2>{p.name}</h2></div>
                    <div className="stats">
                      <div className={`stat${p.openIssues > 0 ? ' alert' : ''}`}><b>{p.openIssues.toLocaleString()}</b><span className="muted small">open issues</span></div>
                      <div className="stat"><b>{p.events24h.toLocaleString()}</b><span className="muted small">events (24h)</span></div>
                    </div>
                    <div className="key-hint mono">Key: {p.apiKeyHint} · {p.allowedOrigins.length === 0 ? 'any origin' : `${p.allowedOrigins.length} origin(s)`}</div>
                  </Link>
                </div>
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
    <div className="card card-body section">
      <h3 className="card-title">New project</h3>
      <form className="create-form" noValidate onSubmit={submit}>
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
        <div className="form-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <Button type="submit" className="primary" busy={busy}>Create project</Button>
        </div>
      </form>
    </div>
  );
}
