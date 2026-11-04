'use client';

import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { useDelayed } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { IconTile, type IconName } from './Icon';
import { CARD } from './kit';

/** A button that shows a spinner and is disabled while `busy`. */
export function Button({ busy = false, className = '', disabled, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button {...props} className={`${className}${busy ? ' busy' : ''}`.trim() || undefined} disabled={disabled || busy} aria-busy={busy}>
      {children}
    </button>
  );
}

/** Small uppercase tag: event type, status, role… `kind` picks the style (defaults to the text). */
export function Badge({ text, kind = text }: { text: string; kind?: string }) {
  return <span className={`badge ${kind}`}>{text}</span>;
}

/** Deterministic hue (0-359) from a name, so the same person or project always gets the same colour. */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** Soft coloured tile with the first letter of a name: round for people, `square` (rounded) for projects and teams. */
export function Avatar({ name, size, shape }: { name: string; size?: 'sm' | 'lg'; shape?: 'square' }) {
  return (
    <div className={`avatar${size ? ` ${size}` : ''}${shape ? ` ${shape}` : ''}`} style={{ '--h': hueOf(name) } as CSSProperties} aria-hidden="true">
      {(name.trim()[0] || '?').toUpperCase()}
    </div>
  );
}

/** Centered card with an icon, a title and a sentence, for empty lists. */
export function EmptyState({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="card empty-state">
      <IconTile name={icon} />
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}

/** Grid panel with an uppercase label on the left of its header and `side` on the right. */
export function Panel({ label, side, className = '', children }: { label: ReactNode; side?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <section className={`panel ${className}`.trim()}>
      <div className="panel-head">
        <span>{label}</span>
        {side !== undefined ? <span>{side}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** One big number with a label and an optional note. */
export function Kpi({ label, value, note, neutral = false, side }: { label: string; value: ReactNode; note?: string | null; neutral?: boolean; side?: ReactNode }) {
  return (
    <section className="panel kpi">
      <div className="panel-head">
        <span>{label}</span>
        {side}
      </div>
      <div className="big">{value}</div>
      {note ? <div className={`delta${neutral ? ' neutral' : ''}`}>{note}</div> : null}
    </section>
  );
}

/** "Loading…" with a spinner, shown only if loading takes longer than a moment. */
export function Loading() {
  const shown = useDelayed(true);
  if (!shown) return null;
  return (
    <div className="loading">
      <span className="spinner" />
      Loading…
    </div>
  );
}

/** An error message where the page content would be. */
export function ErrorNotice({ error }: { error: Error }) {
  return <div className="notice error">{error.message || 'Something went wrong'}</div>;
}

/** Copies `text` to the clipboard and says so on the button for a moment. */
export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState('copied');
          setTimeout(() => setState('idle'), 1500);
        } catch {
          setState('failed');
        }
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

/** Settings section: title and description on the left, content on the right. */
export function SettingsCard({ title, description, className = '', children }: { title: string; description?: string | null; className?: string; children: ReactNode }) {
  return (
    <section className={cn(CARD, 'grid gap-4 p-5 md:grid-cols-[260px_minmax(0,1fr)] md:gap-8 md:p-6', className)}>
      <div>
        <h3 className="m-0 text-sm font-semibold">{title}</h3>
        {description ? <p className="mt-1 text-[13px] text-muted">{description}</p> : null}
      </div>
      <div className="grid min-w-0 content-start gap-3">{children}</div>
    </section>
  );
}
