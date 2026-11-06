'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { EMOJI_PALETTE } from '@/lib/chat';
import type { EmojiGroup } from '@/lib/emojiData';
import { cn } from '@/lib/utils';
import { Icon } from '../../ui/Icon';
import { Emoji } from './shared';

/** Grid: columns and the size of one cell; the panel's size follows from these (popups position themselves with it). */
const COLUMNS = 8;
const CELL_PX = 36;
const VISIBLE_ROWS = 6;
const PAD_PX = 8;
const SEARCH_PX = 44;
const TABS_PX = 40;
export const PICKER_WIDTH_PX = COLUMNS * CELL_PX + PAD_PX * 2;
export const PICKER_HEIGHT_PX = SEARCH_PX + TABS_PX + VISIBLE_ROWS * CELL_PX + PAD_PX;

/** Recently used emoji are kept in this browser only. */
const RECENT_KEY = 'et_emoji_recent';
const RECENT_MAX = 16;
/** A section scrolled past by less than this still counts as the one in view (px). */
const ACTIVE_SLACK_PX = 12;

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function remember(emoji: string): string[] {
  const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* storage off: just not remembered */ }
  return next;
}

const cell = 'tg-emoji-cell';

/** One block of emoji; off-screen blocks are not laid out until scrolled near (there are ~1,900 emoji). */
function Grid({ emojis, mine, onPick }: { emojis: ReadonlyArray<readonly [string, string]>; mine: readonly string[]; onPick: (emoji: string) => void }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${COLUMNS}, ${CELL_PX}px)`, contentVisibility: 'auto', containIntrinsicSize: `auto ${Math.ceil(emojis.length / COLUMNS) * CELL_PX}px` }}>
      {emojis.map(([emoji, name]) => (
        <button key={emoji} type="button" role="menuitemradio" aria-checked={mine.includes(emoji)} aria-label={name} title={name} className={cell}
          onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(emoji)}>
          <Emoji emoji={emoji} size={24} />
        </button>
      ))}
    </div>
  );
}

/**
 * Every emoji, searchable by name, with category tabs and your recent ones on top. The list (about 70 KB) is
 * loaded when the picker first opens; until then the short built-in palette is shown. Pictures that are not
 * stored in the app come from Google's Noto host (see `Emoji`), and show as system emoji if that fails.
 */
export function EmojiPicker({ onPick, mine = [] }: { onPick: (emoji: string) => void; mine?: readonly string[] }) {
  const [groups, setGroups] = useState<ReadonlyArray<EmojiGroup> | null>(null);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    import('@/lib/emojiData').then((m) => { if (live) setGroups(m.EMOJI_GROUPS); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = useMemo(
    () => (groups && words.length > 0 ? groups.flatMap((g) => g.emojis.filter(([, name]) => words.every((w) => name.includes(w)))) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, words.join(' ')],
  );

  const pick = (emoji: string) => { setRecent(remember(emoji)); onPick(emoji); };
  const names = useMemo(() => new Map(groups?.flatMap((g) => g.emojis) ?? EMOJI_PALETTE), [groups]);
  const recentEntries = recent.map((e) => [e, names.get(e) ?? e] as const);

  const jump = (index: number) => {
    const box = scroller.current;
    const section = box?.querySelector<HTMLElement>(`[data-group="${index}"]`);
    if (box && section) box.scrollTop = section.offsetTop - box.offsetTop;
  };
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    const sections = [...box.querySelectorAll<HTMLElement>('[data-group]')];
    let current = 0;
    for (const s of sections) if (s.offsetTop - box.offsetTop <= box.scrollTop + ACTIVE_SLACK_PX) current = Number(s.dataset.group);
    setActive(current);
  };

  return (
    <div className="flex flex-col text-(--tg-text)" style={{ width: PICKER_WIDTH_PX }}>
      <div className="flex items-center gap-2 px-3" style={{ height: SEARCH_PX }}>
        <Icon name="search" className="size-4 shrink-0 text-(--tg-in-meta)" />
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus autoComplete="off" spellCheck={false}
          placeholder="Search emoji" aria-label="Search emoji"
          className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[14px] text-(--tg-text) shadow-none outline-none placeholder:text-(--tg-in-meta)" />
      </div>

      {groups && !results ? (
        <div className="flex items-center justify-between px-2 pb-1" style={{ height: TABS_PX - 4 }}>
          {groups.map((g, i) => (
            <button key={g.name} type="button" aria-label={g.name} title={g.name} onMouseDown={(e) => e.preventDefault()} onClick={() => jump(i)}
              className={cn('grid size-8 cursor-pointer place-items-center rounded-lg border-0 bg-transparent p-0 shadow-none transition-opacity', active === i ? 'bg-(--tg-menu-hover) opacity-100' : 'opacity-55 hover:opacity-100')}>
              <Emoji emoji={g.emojis[0][0]} size={18} />
            </button>
          ))}
        </div>
      ) : <div style={{ height: TABS_PX - 4 }} aria-hidden="true" />}

      <div ref={scroller} onScroll={onScroll} className="relative overflow-y-auto px-2 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ height: VISIBLE_ROWS * CELL_PX + 4 }}>
        {results ? (
          results.length > 0
            ? <Grid emojis={results} mine={mine} onPick={pick} />
            : <p className="m-0 px-1 py-6 text-center text-[13px] text-(--tg-in-meta)">No emoji match “{query.trim()}”.</p>
        ) : !groups ? (
          <Grid emojis={EMOJI_PALETTE} mine={mine} onPick={pick} />
        ) : (
          <>
            {recentEntries.length > 0 ? (
              <section>
                <h3 className="sticky top-0 z-[1] m-0 bg-(--tg-menu-solid) px-1 py-1 text-[12px] font-medium text-(--tg-in-meta)">Recent</h3>
                <Grid emojis={recentEntries} mine={mine} onPick={pick} />
              </section>
            ) : null}
            {groups.map((g, i) => (
              <section key={g.name} data-group={i}>
                <h3 className="sticky top-0 z-[1] m-0 bg-(--tg-menu-solid) px-1 py-1 text-[12px] font-medium text-(--tg-in-meta)">{g.name}</h3>
                <Grid emojis={g.emojis} mine={mine} onPick={pick} />
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
