import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * Tailwind building blocks for the app-frame look (docs/DESIGN.md): soft white cards on the grey frame,
 * radius 16, pill buttons and badges, almost no borders. New screens use these instead of the older
 * global classes (.card, .badge, .page-head…). Utilities win over the base-layer button/input rules.
 */

/** White rounded card with a very soft shadow. */
export const CARD = 'rounded-2xl border border-line/70 bg-panel shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.04)]';

const BUTTON_BASE =
  'inline-flex h-9 cursor-pointer shadow-none items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40';
const BUTTON_VARIANTS = {
  primary: 'border-0 bg-invert-bg text-invert-fg hover:bg-invert-bg/85',
  secondary: 'border border-line-strong bg-panel text-fg hover:bg-(--hover)',
  ghost: 'border-0 bg-transparent text-muted hover:bg-(--hover) hover:text-fg',
  danger: 'border border-line-strong bg-panel text-danger hover:border-danger hover:bg-panel',
} as const;

/** Class names of a pill button; also usable on a `Link`. */
export function pillButton(variant: keyof typeof BUTTON_VARIANTS = 'secondary', extra?: string): string {
  return cn(BUTTON_BASE, BUTTON_VARIANTS[variant], extra);
}

/** Pill-shaped button: black (`primary`), outlined (`secondary`), flat (`ghost`) or red text (`danger`). */
export function PillButton({ variant = 'secondary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return <button type="button" {...props} className={pillButton(variant, className)} />;
}

const TONES = {
  neutral: 'bg-(--chip) text-fg-2',
  muted: 'bg-(--chip) text-muted',
  red: 'bg-red-500/12 text-red-600 dark:text-red-400',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  green: 'bg-green-500/12 text-green-700 dark:text-green-400',
  dark: 'bg-invert-bg text-invert-fg',
} as const;
export type Tone = keyof typeof TONES;

/** Small soft-tinted pill: status, event type, counts. */
export function Pill({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] leading-5 font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>;
}

/** Page title row: title and a sentence on the left, actions on the right. */
export function PageTitle({ title, sub, lead, actions }: { title: ReactNode; sub?: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
      {lead}
      <div className="min-w-0 flex-1 basis-48">
        <h1 className="truncate text-[22px] font-semibold tracking-tight">{title}</h1>
        {sub ? <p className="mt-0.5 text-[13px] text-muted">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 max-sm:basis-full">{actions}</div> : null}
    </div>
  );
}

/** Underlined tab row (`Issues` · `Settings`). */
export function TabBar<T extends string>({ tabs, value, onChange, label }: { tabs: Array<{ id: T; label: string }>; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="mb-5 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            '-mb-px shrink-0 cursor-pointer rounded-none shadow-none border-0 border-b-2 bg-transparent px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors',
            value === tab.id ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
