'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '../ui/Icon';
import { pillButton } from '../ui/kit';

/** The filter values of the issue list. `status` is open | resolved | ignored | all. */
export interface IssueFilterValues {
  status: string;
  type: string;
  env: string;
  sort: string;
}

/** What a filter returns to when it is reset (the list's defaults). */
export const DEFAULT_ISSUE_FILTERS: IssueFilterValues = { status: 'open', type: '', env: '', sort: 'lastSeen' };

interface Option {
  value: string;
  label: string;
  /** Small number shown beside the label (issues in that status). */
  count?: number;
}

interface Props {
  values: IssueFilterValues;
  onChange: (changes: Partial<IssueFilterValues>) => void;
  statuses: Option[];
  types: Option[];
  environments: Option[];
  sorts: Option[];
  /** Search text (applied with Enter) and its handlers. */
  search: string;
  onSearchChange: (text: string) => void;
  onSearchSubmit: () => void;
}

/** Tailwind needs the full class names, so the column counts are spelled out here. */
const COLUMNS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' };

/** One filter: a small heading and a grid of equal-width options (single choice). */
function OptionGrid({ label, options, value, onPick, columns }: { label: string; options: Option[]; value: string; onPick: (value: string) => void; columns: 2 | 3 | 4 }) {
  return (
    <section aria-label={label}>
      <h4 className="m-0 mb-2 text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</h4>
      <div className={cn('grid gap-1.5', COLUMNS[columns])} role="group" aria-label={label}>
        {options.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              title={o.label}
              onClick={() => onPick(o.value)}
              className={cn(
                'flex h-10 min-w-0 cursor-pointer flex-col items-center justify-center rounded-xl border px-2 text-[13px] leading-tight font-medium shadow-none transition-colors',
                on ? 'border-transparent bg-invert-bg text-invert-fg' : 'border-line bg-panel-2 text-fg hover:border-line-strong hover:bg-(--hover)',
              )}
            >
              <span className="max-w-full truncate">{o.label}</span>
              {o.count !== undefined ? <span className={cn('text-[11px] font-normal tabular-nums', on ? 'opacity-70' : 'text-muted')}>{o.count.toLocaleString()}</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Number of filters that differ from the defaults. */
export function activeFilterCount(v: IssueFilterValues): number {
  return (Object.keys(DEFAULT_ISSUE_FILTERS) as Array<keyof IssueFilterValues>).filter((k) => v[k] !== DEFAULT_ISSUE_FILTERS[k]).length;
}

/** Search box + a "Filter" button that opens a panel with every filter, and removable chips for the active ones. */
export function IssueFilters({ values, onChange, statuses, types, environments, sorts, search, onSearchChange, onSearchSubmit }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const active = activeFilterCount(values);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const reset = () => onChange({ ...DEFAULT_ISSUE_FILTERS });
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') onSearchSubmit(); };

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <div className="relative min-w-52 max-w-md flex-1">
        <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search message, type, location or API call id…"
          aria-label="Search issues"
          className="h-9 w-full rounded-full border border-line-strong bg-panel pr-3 pl-9 text-[13px] placeholder:text-faint"
        />
      </div>

      <div className="relative" ref={wrap}>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className={pillButton('secondary', cn('gap-2', (open || active > 0) && 'border-fg'))}
        >
          <Icon name="sliders" className="size-4" />
          Filter
          {active > 0 ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-invert-bg px-1.5 text-[11px] leading-none text-invert-fg tabular-nums">{active}</span> : null}
        </button>

        {open ? (
          <div role="dialog" aria-label="Filter issues" className="absolute left-0 z-30 mt-2 w-[min(400px,calc(100vw-48px))] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--menu-shadow)">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h3 className="m-0 text-sm font-semibold">Filters</h3>
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-muted shadow-none enabled:hover:text-fg disabled:cursor-default disabled:opacity-40" disabled={active === 0} onClick={reset}>Reset all</button>
            </div>
            <div className="grid max-h-[min(70vh,520px)] gap-5 overflow-y-auto px-4 py-4">
              <OptionGrid label="Status" columns={4} options={statuses} value={values.status} onPick={(status) => onChange({ status })} />
              <OptionGrid label="Event type" columns={3} options={[{ value: '', label: 'All' }, ...types]} value={values.type} onPick={(type) => onChange({ type })} />
              {environments.length > 0 ? (
                <OptionGrid label="Environment" columns={3} options={[{ value: '', label: 'All' }, ...environments]} value={values.env} onPick={(env) => onChange({ env })} />
              ) : null}
              <OptionGrid label="Sort by" columns={3} options={sorts} value={values.sort} onPick={(sort) => onChange({ sort })} />
            </div>
            <div className="flex justify-end border-t border-line bg-panel-2 px-4 py-3">
              <button type="button" className={pillButton('primary', 'h-9 px-5')} onClick={() => setOpen(false)}>Show results</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Removable chips of the active filters (shown under the toolbar); null when none is active. */
export function ActiveFilterChips({ values, statuses, types, sorts, onChange }: { values: IssueFilterValues; statuses: Option[]; types: Option[]; sorts: Option[]; onChange: (changes: Partial<IssueFilterValues>) => void }): ReactNode {
  const labelOf = (options: Option[], value: string): string => options.find((o) => o.value === value)?.label ?? value;
  const chips: Array<{ key: keyof IssueFilterValues; text: string }> = [];
  if (values.status !== DEFAULT_ISSUE_FILTERS.status) chips.push({ key: 'status', text: `Status: ${labelOf(statuses, values.status)}` });
  if (values.type) chips.push({ key: 'type', text: `Type: ${labelOf(types, values.type)}` });
  if (values.env) chips.push({ key: 'env', text: `Environment: ${values.env}` });
  if (values.sort !== DEFAULT_ISSUE_FILTERS.sort) chips.push({ key: 'sort', text: `Sort: ${labelOf(sorts, values.sort)}` });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
      <span className="mr-1 text-xs text-muted">Filters</span>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange({ [c.key]: DEFAULT_ISSUE_FILTERS[c.key] })}
          aria-label={`Remove filter ${c.text}`}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border-0 bg-(--chip) px-2.5 text-xs font-medium text-fg-2 shadow-none hover:bg-(--hover)"
        >
          {c.text}<Icon name="close" className="size-3 text-muted" />
        </button>
      ))}
    </div>
  );
}
