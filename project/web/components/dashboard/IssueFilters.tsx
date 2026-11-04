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

/** A filter's small heading. */
function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[11px] font-medium text-muted">{children}</div>;
}

/** Few, short options as one segmented control: the chosen one is a raised white pill on a grey track. */
function Segmented({ label, options, value, onPick }: { label: string; options: Option[]; value: string; onPick: (value: string) => void }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-0.5 rounded-full bg-(--chip) p-0.5" role="group" aria-label={label}>
        {options.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(o.value)}
              className={cn(
                'flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 rounded-full border-0 px-2 text-xs font-medium whitespace-nowrap transition-colors',
                on ? 'bg-panel text-fg shadow-[0_1px_2px_rgba(0,0,0,.12)]' : 'bg-transparent text-muted shadow-none hover:text-fg',
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.count !== undefined ? <span className={cn('text-[11px] font-normal tabular-nums', on ? 'text-muted' : 'opacity-70')}>{o.count.toLocaleString()}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Options of any number and length as small wrapping chips (event types, environments). */
function Chips({ label, options, value, onPick }: { label: string; options: Option[]; value: string; onPick: (value: string) => void }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {options.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(o.value)}
              className={cn(
                'inline-flex h-7 max-w-full cursor-pointer items-center rounded-full border px-3 text-xs font-medium shadow-none transition-colors',
                on ? 'border-fg bg-fg/5 text-fg' : 'border-line bg-transparent text-fg-2 hover:border-line-strong hover:bg-(--hover)',
              )}
            >
              <span className="truncate">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
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
  // Choices are held here until "Apply", so the list doesn't reload on every click.
  const [draft, setDraft] = useState<IssueFilterValues>(values);
  const draftActive = activeFilterCount(draft);
  const changed = (Object.keys(draft) as Array<keyof IssueFilterValues>).some((k) => draft[k] !== values[k]);
  const toggle = () => {
    if (!open) setDraft(values);
    setOpen((was) => !was);
  };
  const apply = () => {
    onChange(draft);
    setOpen(false);
  };

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
          onClick={toggle}
          className={pillButton('secondary', cn('gap-2', (open || active > 0) && 'border-fg'))}
        >
          <Icon name="sliders" className="size-4" />
          Filter
          {active > 0 ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-invert-bg px-1.5 text-[11px] leading-none text-invert-fg tabular-nums">{active}</span> : null}
        </button>

        {open ? (
          <div role="dialog" aria-label="Filter issues" className="absolute left-0 z-30 mt-2 w-[min(340px,calc(100vw-48px))] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--menu-shadow)">
            <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
              <h3 className="m-0 text-sm font-semibold">Filters</h3>
              <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-muted shadow-none enabled:hover:text-fg disabled:cursor-default disabled:opacity-40" disabled={draftActive === 0} onClick={() => setDraft({ ...DEFAULT_ISSUE_FILTERS })}>Reset</button>
            </div>
            <div className="grid max-h-[min(60vh,440px)] gap-3.5 overflow-y-auto px-4 py-3">
              <Segmented label="Status" options={statuses} value={draft.status} onPick={(status) => setDraft({ ...draft, status })} />
              <Chips label="Event type" options={[{ value: '', label: 'All' }, ...types]} value={draft.type} onPick={(type) => setDraft({ ...draft, type })} />
              {environments.length > 0 ? (
                <Chips label="Environment" options={[{ value: '', label: 'All' }, ...environments]} value={draft.env} onPick={(env) => setDraft({ ...draft, env })} />
              ) : null}
              <Segmented label="Sort by" options={sorts} value={draft.sort} onPick={(sort) => setDraft({ ...draft, sort })} />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
              <button type="button" className={pillButton('ghost', 'h-8 px-3 text-xs')} onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className={pillButton('primary', 'h-8 px-4 text-xs')} disabled={!changed} onClick={apply}>Apply</button>
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
