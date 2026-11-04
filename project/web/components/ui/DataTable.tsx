'use client';

import { useRouter } from 'next/navigation';
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  functionalUpdate,
  globalFilteringFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './Icon';
import { CARD } from './kit';

/*
 * The one table of the app (TanStack Table v9). Every list that has columns uses it, so they all
 * look and behave the same: sortable headers, optional search box, optional row checkboxes, optional
 * clickable rows, a title row, an empty message and horizontal scrolling on narrow screens.
 *
 * Build columns with `columnHelper<Row>()` (re-exported below) and keep them stable (module scope or
 * useMemo): the table rebuilds its row models when `columns` or `data` change identity.
 */

/** Features every table in the app has registered. */
const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, datetime: sortFn_datetime, text: sortFn_text },
  filterFns: { includesString: filterFn_includesString },
});
type Features = typeof features;

/** Column definition type for a row type `T`. */
export type Column<T extends RowData> = ColumnDef<Features, T, unknown>;

/** `const h = columnHelper<Row>()`, then `h.accessor(...)`, `h.display(...)` and `h.columns([...])`. */
export function columnHelper<T extends RowData>() {
  return createColumnHelper<Features, T>();
}

/** Extra per-column options, set through `meta` in a column definition. */
export interface DataColumnMeta {
  /** Text alignment of header and cells (numbers: 'right'). */
  align?: 'left' | 'right';
  /** Extra classes on the header and every cell, e.g. 'max-sm:hidden' to drop the column on phones. */
  className?: string;
  /** Header and cell width, e.g. 'w-24'. */
  width?: string;
}
const metaOf = (column: { columnDef: { meta?: unknown } }): DataColumnMeta => (column.columnDef.meta ?? {}) as DataColumnMeta;

const SELECT_ID = '__select';
const SEARCH_ID = '__search';

interface DataTableProps<T extends RowData> {
  data: readonly T[] | null;
  columns: Array<Column<T>>;
  /** Stable id of a row (selection, React keys). */
  getRowId: (row: T, index: number) => string;
  /** Heading above the table, with an optional sentence beside it. */
  title?: ReactNode;
  description?: ReactNode;
  /** Extra controls in the toolbar (right side). */
  actions?: ReactNode;
  /** A search box over the text this returns for every row. */
  search?: { placeholder: string; text: (row: T) => string };
  /** Sort on load; sortable columns can be clicked. Pass `false` for a list the server has already ordered. */
  initialSort?: { id: string; desc?: boolean } | false;
  /** Adds a checkbox column. Pass `selected` + `onSelectionChange` to own the selection (e.g. to clear it after a delete). */
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  /** Rows open this URL when clicked (or on Enter); `onRowOpen` runs first. */
  rowHref?: (row: T) => string;
  onRowOpen?: (row: T) => void;
  /** Hover / focus on a row (prefetching). */
  onRowHover?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  /** Shown instead of rows when nothing matches. */
  empty?: ReactNode;
  /** Minimum table width in px before it scrolls sideways. */
  minWidth?: number;
  className?: string;
}

/** The shared table. See the file comment for how to build `columns`. */
export function DataTable<T extends RowData>({
  data, columns, getRowId, title, description, actions, search, initialSort, selectable, selected, onSelectionChange,
  rowHref, onRowOpen, onRowHover, rowClassName, empty, minWidth = 720, className,
}: DataTableProps<T>) {
  const router = useRouter();
  const h = useMemo(() => columnHelper<T>(), []);
  const rows = data ?? EMPTY;

  const [ownSelection, setOwnSelection] = useState<RowSelectionState>({});
  const controlled = selected !== undefined;
  const rowSelection = useMemo<RowSelectionState>(
    () => (controlled ? Object.fromEntries([...selected].map((id) => [id, true])) : ownSelection),
    [controlled, selected, ownSelection],
  );

  const allColumns = useMemo(() => {
    const list: Array<Column<T>> = [];
    if (selectable) {
      list.push(h.display({
        id: SELECT_ID,
        enableSorting: false,
        meta: { width: 'w-10' } satisfies DataColumnMeta,
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all rows"
            className="size-4 cursor-pointer accent-(--accent)"
            checked={table.getIsAllRowsSelected()}
            ref={(el) => { if (el) el.indeterminate = table.getIsSomeRowsSelected(); }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label="Select row"
            className="size-4 cursor-pointer accent-(--accent)"
            checked={row.getIsSelected()}
            onClick={(e) => e.stopPropagation()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      }) as Column<T>);
    }
    list.push(...columns);
    if (search) {
      list.push(h.accessor((row) => search.text(row), { id: SEARCH_ID, enableSorting: false }) as Column<T>);
    }
    return list;
  }, [columns, selectable, search, h]);

  const sorting: SortingState = initialSort ? [{ id: initialSort.id, desc: initialSort.desc ?? false }] : [];
  const table = useTable({
    features,
    columns: allColumns,
    data: rows as T[],
    getRowId,
    globalFilterFn: 'includesString',
    getColumnCanGlobalFilter: (column) => column.id === SEARCH_ID,
    enableSortingRemoval: false,
    initialState: { sorting },
    state: { rowSelection },
    onRowSelectionChange: (updater) => {
      const next = functionalUpdate(updater, rowSelection);
      if (!controlled) setOwnSelection(next);
      onSelectionChange?.(new Set(Object.keys(next).filter((id) => next[id])));
    },
  });

  // Rows that left the list (filtered by the server, deleted) can't stay selected.
  const ids = rows.map(getRowId).join('\u0000');
  useEffect(() => {
    if (controlled || Object.keys(ownSelection).length === 0) return;
    const present = new Set(ids.split('\u0000'));
    const kept = Object.fromEntries(Object.entries(ownSelection).filter(([id]) => present.has(id)));
    if (Object.keys(kept).length !== Object.keys(ownSelection).length) setOwnSelection(kept);
  }, [ids, controlled, ownSelection]);

  const visible = table.getRowModel().rows;
  const selectedCount = table.getSelectedRowModel().rows.length;
  const query = typeof table.state.globalFilter === 'string' ? table.state.globalFilter : '';
  const hasHead = Boolean(title || description || search || actions);
  const clickable = Boolean(rowHref || onRowOpen);
  const open = (row: T) => {
    onRowOpen?.(row);
    if (rowHref) router.push(rowHref(row));
  };

  return (
    <div className={cn(CARD, 'overflow-hidden', className)}>
      {hasHead ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
          {title || description ? (
            <div className="min-w-0">
              {title ? <h3 className="m-0 text-sm font-semibold">{title}</h3> : null}
              {description ? <p className="m-0 mt-0.5 text-xs text-muted">{description}</p> : null}
            </div>
          ) : null}
          {search ? (
            <div className="relative w-full max-w-xs min-w-48 flex-1">
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <input
                type="search"
                value={query}
                onChange={(e) => table.setGlobalFilter(e.target.value)}
                placeholder={search.placeholder}
                aria-label={search.placeholder}
                className="h-9 w-full rounded-full border border-line-strong bg-panel pr-3 pl-9 text-[13px]"
              />
            </div>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
            {selectedCount > 0 ? (
              <span>
                {selectedCount} selected ·{' '}
                <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-xs text-fg underline shadow-none" onClick={() => table.resetRowSelection()}>Clear</button>
              </span>
            ) : search ? <span>{visible.length} of {rows.length}</span> : null}
            {actions}
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]" style={{ minWidth }}>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="bg-panel-2">
                {group.headers.filter((header) => header.column.id !== SEARCH_ID).map((header) => {
                  const sorted = header.column.getIsSorted();
                  const canSort = Boolean(initialSort) && header.column.getCanSort();
                  const meta = metaOf(header.column);
                  const right = meta.align === 'right';
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                      className={cn('border-b border-line px-4 py-2.5 text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted uppercase', right ? 'text-right' : 'text-left', meta.width, meta.className)}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn('inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[11px] font-semibold tracking-wide text-inherit uppercase shadow-none hover:text-fg', right && 'flex-row-reverse', sorted && 'text-fg')}
                        >
                          <table.FlexRender header={header} />
                          <Icon name="chevron" className={cn('size-3.5 transition', sorted === 'asc' && 'rotate-180', !sorted && 'opacity-30')} />
                        </button>
                      ) : <table.FlexRender header={header} />}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((row) => (
              <tr
                key={row.id}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? (e) => { if (!(e.target as HTMLElement).closest('input,a,button,select,label')) open(row.original); } : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(row.original); } : undefined}
                onMouseEnter={onRowHover ? () => onRowHover(row.original) : undefined}
                onFocus={onRowHover ? () => onRowHover(row.original) : undefined}
                className={cn('transition-colors hover:bg-(--hover)', clickable && 'cursor-pointer focus-visible:bg-(--hover) focus-visible:outline-none', row.getIsSelected() && 'bg-(--hover)', rowClassName?.(row.original))}
              >
                {row.getAllCells().filter((cell) => cell.column.id !== SEARCH_ID).map((cell) => {
                  const meta = metaOf(cell.column);
                  return (
                    <td key={cell.id} className={cn('px-4 py-3 align-middle', meta.align === 'right' && 'text-right', meta.className)}>
                      <table.FlexRender cell={cell} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {data !== null && visible.length === 0 ? (
              <tr><td colSpan={allColumns.length - (search ? 1 : 0)} className="px-4 py-10 text-center text-muted">{empty ?? (query ? `Nothing matches “${query}”.` : 'No rows.')}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const EMPTY: readonly never[] = [];
