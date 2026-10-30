'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client/api';
import { APP_PATH_PREFIX, BUILT_IN_LIBRARY_NAMES, HINT_SEPARATOR, insightSettings } from '@/lib/insights';
import type { InsightSettingsView, ProjectView } from '@/lib/types';
import { Button, SettingsCard } from '../ui/bits';
import { useDialog } from '../ui/Dialog';
import { Field, TextareaField } from '../ui/fields';
import { useToast } from '../ui/Toasts';

/** Same rules as the server's normalizeOrigin (server/origins.ts): `{ origin }` or `{ error }`. */
function parseOrigin(text: string): { origin: string } | { error: string } {
  const value = text.trim();
  if (value === '') return { error: 'Enter an origin, e.g. https://myapp.com' };
  if (value.includes('*')) return { error: 'Wildcards are not supported; add each origin' };
  if (!value.includes('://')) return { error: 'Include http:// or https://, e.g. http://localhost:3000' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'Not a valid origin; use the form https://myapp.com' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http:// and https:// origins' };
  return { origin: url.origin };
}

/** "Allowed origins: any" / "Allowed origins: 3", for the button that opens the panel. */
export function originsLabel(origins: string[]): string {
  return origins.length === 0 ? 'Allowed origins: any' : `Allowed origins: ${origins.length}`;
}

/** "Issue insights" / "Issue insights: 4", for the button that opens the panel. */
export function insightsLabel(raw: InsightSettingsView): string {
  const settings = insightSettings(raw);
  const n = settings.libraryPaths.length + settings.hiddenFrames.length + settings.hints.length;
  return n === 0 ? 'Issue insights' : `Issue insights: ${n}`;
}

/**
 * The websites whose pages may send events with this project's key. Each add
 * or remove saves the whole list at once.
 */
export function OriginsPanel({ project }: { project: ProjectView }) {
  const openDialog = useDialog();
  const { toast, action } = useToast();
  const [origins, setOrigins] = useState(project.allowedOrigins);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save(next: string[]) {
    const res = await api<{ project: ProjectView }>(`/api/projects?id=${project.id}`, { method: 'PATCH', body: { allowedOrigins: next } });
    setOrigins(res.project.allowedOrigins);
  }

  const remove = (value: string) => action(async () => {
    const next = origins.filter((o) => o !== value);
    if (next.length === 0) {
      const ok = await openDialog({
        title: 'Remove the last origin?',
        message: "With no origins listed, any website can send events with this project's key.",
        confirmText: 'Remove',
        danger: true,
        onConfirm: () => save(next),
      });
      if (ok) toast(`Removed ${value}`);
      return;
    }
    setBusy(value);
    try {
      await save(next);
      toast(`Removed ${value}`);
    } finally {
      setBusy(null);
    }
  });

  async function add(event: FormEvent) {
    event.preventDefault();
    const parsed = parseOrigin(typed);
    if ('error' in parsed) return setError(parsed.error);
    if (origins.includes(parsed.origin)) return setError(`${parsed.origin} is already in the list`);
    setBusy('add');
    try {
      await save([...origins, parsed.origin]);
      const cut = typed.trim().replace(/\/$/, '').toLowerCase() !== parsed.origin;
      toast(cut ? `Added ${parsed.origin} (cut down to its origin)` : `Added ${parsed.origin}`);
      setTyped('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="section">
      <SettingsCard title="Allowed origins" description="Websites whose pages may send events with this key. Browsers set the Origin header, so other sites cannot use a key copied from your page.">
        {origins.length === 0 ? (
          <p className="notice warn">Any website can send events with this key. Add the origins of your app, local and production, to accept events only from them.</p>
        ) : (
          <p className="muted small">Only these websites can send events. Server-side and mobile apps (no Origin header) are always accepted. Changes apply within a minute.</p>
        )}
        <div className="origin-list">
          {origins.map((value) => (
            <div key={value} className="origin-row">
              <code>{value}</code>
              <span className="spacer" />
              <Button className="ghost danger" type="button" aria-label={`Remove ${value}`} busy={busy === value} onClick={remove(value)}>Remove</Button>
            </div>
          ))}
        </div>
        <form className="origin-form" noValidate onSubmit={add}>
          <Field
            label="Add an origin"
            placeholder="https://myapp.com"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            maxLength={200}
            hint="Scheme, host and port as in the address bar, e.g. http://localhost:3000. A pasted URL is cut down to its origin."
            value={typed}
            onValue={(v) => { setTyped(v); setError(null); }}
            error={error}
          />
          <div className="form-actions"><Button className="primary" type="submit" busy={busy === 'add'}>Add</Button></div>
        </form>
      </SettingsCard>
    </div>
  );
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/**
 * How the issue page reads this project's errors (lib/insights.ts): library
 * paths, frames to hide and the team's own hints. `onSaved` runs after a save.
 */
export function InsightsPanel({ project, onSaved }: { project: ProjectView; onSaved: (settings: InsightSettingsView) => void }) {
  const { toast } = useToast();
  const initial = insightSettings(project.insights);
  const [libraries, setLibraries] = useState(initial.libraryPaths.map(String).join('\n'));
  const [hidden, setHidden] = useState(initial.hiddenFrames.map(String).join('\n'));
  const [hints, setHints] = useState(project.insights.hints.map((h) => `${h.match} ${HINT_SEPARATOR} ${h.text}`).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // Line numbers count blank lines too, so they match what the user sees.
    const rawLines = hints.split(/\r?\n/);
    const bad = rawLines.findIndex((l) => l.trim() !== '' && (!l.includes(HINT_SEPARATOR)
      || !l.slice(0, l.indexOf(HINT_SEPARATOR)).trim() || !l.slice(l.indexOf(HINT_SEPARATOR) + HINT_SEPARATOR.length).trim()));
    if (bad !== -1) return setError(`Team hints, line ${bad + 1}: write it as match ${HINT_SEPARATOR} hint`);
    const settings: InsightSettingsView = {
      libraryPaths: lines(libraries),
      hiddenFrames: lines(hidden),
      hints: lines(hints).map((l) => {
        const at = l.indexOf(HINT_SEPARATOR);
        return { match: l.slice(0, at).trim(), text: l.slice(at + HINT_SEPARATOR.length).trim() };
      }),
    };
    setBusy(true);
    try {
      const res = await api<{ project: ProjectView }>(`/api/projects?id=${project.id}`, { method: 'PATCH', body: { insights: settings } });
      toast('Issue insights saved');
      onSaved(res.project.insights);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <SettingsCard title="Issue insights" description="How the issue page reads this project's errors: which code is a library, which wrapper frames to skip, and what your team already knows about certain errors. Applies to every issue at once.">
        <form className="origin-form" noValidate onSubmit={save}>
          <TextareaField
            label="Library paths"
            hint={`One per line. A stack frame whose file URL contains this text is library code: folded away, never "where to look". Start a line with ${APP_PATH_PREFIX} to mark files as your code instead, overriding the built-in list: ${BUILT_IN_LIBRARY_NAMES.join(', ')}.`}
            value={libraries}
            onValue={setLibraries}
            placeholder={`/vendor/\n${APP_PATH_PREFIX}/js/app/`}
            rows={4}
          />
          <TextareaField
            label="Frames to hide"
            hint='One per line: function names of wrappers such as a tracking snippet ("wrapped" also hides "Object.wrapped"), or a path containing / to hide every frame from that file.'
            value={hidden}
            onValue={setHidden}
            placeholder={'serverError\nwrapped'}
            rows={3}
          />
          <TextareaField
            label="Team hints"
            hint={`One per line: match ${HINT_SEPARATOR} hint. Shown on an issue when "match" appears in its error type, message or a context value (such as an error code).`}
            value={hints}
            onValue={setHints}
            placeholder={`AppzillonServerError ${HINT_SEPARATOR} An Appzillon server call failed; check the iface and error code under Context.`}
            rows={5}
          />
          {error ? <p className="field-error">{error}</p> : null}
          <div className="form-actions"><Button className="primary" type="submit" busy={busy}>Save</Button></div>
        </form>
      </SettingsCard>
    </div>
  );
}
