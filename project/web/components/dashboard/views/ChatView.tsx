'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, useApi } from '@/lib/client/api';
import { useChat } from '@/lib/client/chat';
import { queryString } from '@/lib/format';
import type { ChatIssueView, ChatMessageView, IssuesResponse, MembersResponse, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, ErrorNotice, Loading } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { Pill, pillButton, type Tone } from '../../ui/kit';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { useSession } from '../Shell';

/** A message goes under the previous one without a new header when it's by the same person within this many minutes. */
const GROUP_MINUTES = 5;
/** Pixels from the bottom within which a new message keeps the list scrolled down. */
const STICK_PX = 120;
/** Most issues one message can carry (the server enforces the same). */
const MAX_ISSUES = 5;
/** Issues listed in the "/" picker, and how long typing pauses before it searches. */
const ISSUE_RESULTS = 6;
const ISSUE_SEARCH_DELAY_MS = 200;
/** Tallest the message box grows before it scrolls (px). */
const COMPOSER_MAX_HEIGHT = 168;

const EVENT_TONE: Record<string, Tone> = { crash: 'dark', error: 'red', performance: 'amber', message: 'neutral' };
const STATUS_TONE: Record<string, Tone> = { open: 'neutral', resolved: 'green', ignored: 'muted' };

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with every "@Name" (for the given names) wrapped by `wrap`, the rest left as is. */
function withMentions(text: string, names: string[], wrap: (part: string, key: number) => ReactNode): ReactNode[] {
  if (names.length === 0) return [text];
  const parts = text.split(new RegExp(`(@(?:${names.map(escapeRegex).join('|')}))`, 'g'));
  return parts.map((part, i) => (i % 2 === 1 ? wrap(part, i) : part));
}

/** An attached issue: a small card that opens the issue. */
function IssueCard({ issue, onRemove }: { issue: ChatIssueView; onRemove?: () => void }) {
  const body = (
    <>
      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', issue.eventType === 'crash' ? 'bg-fg' : issue.eventType === 'performance' ? 'bg-amber-500' : issue.eventType === 'message' ? 'bg-muted' : 'bg-red-500')} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
          {issue.errorType}
          <Pill tone={EVENT_TONE[issue.eventType] ?? 'neutral'}>{issue.eventType}</Pill>
          {issue.status !== 'open' ? <Pill tone={STATUS_TONE[issue.status] ?? 'muted'}>{issue.status}</Pill> : null}
        </span>
        <span className="mt-0.5 block truncate text-xs text-fg-2">{issue.message || '(no message)'}</span>
        <span className="mt-0.5 block text-xs text-muted">{issue.count.toLocaleString()} {issue.count === 1 ? 'event' : 'events'}</span>
      </span>
    </>
  );
  const frame = 'flex max-w-md items-start gap-2.5 rounded-2xl border border-line bg-panel px-3.5 py-2.5 text-fg no-underline';
  return onRemove ? (
    <span className={cn(frame, 'relative pr-9')}>
      {body}
      <button type="button" onClick={onRemove} aria-label={`Remove ${issue.errorType}`} title="Remove"
        className="absolute top-2 right-2 grid size-6 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-muted shadow-none hover:bg-(--chip) hover:text-fg">
        <Icon name="close" className="size-3.5" />
      </button>
    </span>
  ) : (
    <Link href={`/issues/${issue.id}`} className={cn(frame, 'w-full transition-colors hover:bg-(--hover) hover:no-underline')}>{body}</Link>
  );
}

/** The project chat: the active project's single channel, using the whole page (docs/MEMBERS_AND_CHAT.md). */
export function ChatView() {
  const { user, projects, projectId } = useSession();
  const project = projects && projectId ? projects.find((p) => p.id === projectId) : undefined;
  const crumbs = [{ label: 'Chats' }, ...(project ? [{ label: `# ${project.name}` }] : [])];

  if (!projects) return <Page crumbs={crumbs} fill><Loading /></Page>;
  if (!project) {
    return (
      <Page crumbs={crumbs} fill>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-sm">
            <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-(--chip) text-muted"><Icon name="chat" className="size-6" /></div>
            <h2 className="m-0 mb-1 text-base font-semibold text-fg">No chats yet</h2>
            <p className="m-0 text-[13px] text-muted">Every project has a chat for the people who have access to it. Create a project, then add your teammates.</p>
          </div>
        </div>
      </Page>
    );
  }
  return <Channel key={project.id} projectId={project.id} projectName={project.name} canPost={project.permissions.includes('chat.post')} isOwner={project.role === 'owner'} userId={user.id} crumbs={crumbs} />;
}

type Picker = { kind: 'mention' | 'issue'; query: string; index: number };

function Channel({ projectId, projectName, canPost, isOwner, userId, crumbs }: {
  projectId: string; projectName: string; canPost: boolean; isOwner: boolean; userId: string; crumbs: Array<{ label: string }>;
}) {
  const chat = useChat(projectId);
  const people = useApi<MembersResponse>(`/api/projects/members?projectId=${projectId}`);
  const openDialog = useDialog();
  const { toast, action } = useToast();

  const everyone = useMemo<PersonView[]>(() => (people.data ? [...(people.data.owner ? [people.data.owner] : []), ...people.data.members] : []), [people.data]);
  const byId = useMemo(() => new Map(everyone.map((p) => [p.id, p])), [everyone]);

  // Keep the list scrolled to the newest message, unless the reader scrolled up.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const added = chat.messages.length - lastCount.current;
    lastCount.current = chat.messages.length;
    if (added > 0 && (atBottom.current || lastCount.current === added)) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const [text, setText] = useState('');
  const [picked, setPicked] = useState<PersonView[]>([]);
  const [attached, setAttached] = useState<ChatIssueView[]>([]);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [issueResults, setIssueResults] = useState<ChatIssueView[]>([]);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  useEffect(() => { if (canPost) box.current?.focus(); }, [canPost, projectId]);

  // The box grows with its text (up to COMPOSER_MAX_HEIGHT, then scrolls).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [text]);

  const mentionOptions = picker?.kind === 'mention' ? everyone.filter((p) => p.id !== userId && p.name.toLowerCase().includes(picker.query.toLowerCase())).slice(0, 6) : [];
  const options: Array<PersonView | ChatIssueView> = picker?.kind === 'mention' ? mentionOptions : picker?.kind === 'issue' ? issueResults : [];

  // "/" opens the issue picker: search the project's issues as the person types.
  const issueQuery = picker?.kind === 'issue' ? picker.query : null;
  useEffect(() => {
    if (issueQuery === null) return;
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api<IssuesResponse>(`/api/issues${queryString({ projectId, status: 'all', sort: 'lastSeen', q: issueQuery })}`)
        .then((res) => { if (!cancelled) setIssueResults(res.issues.slice(0, ISSUE_RESULTS).map((i) => ({ id: i.id, eventType: i.eventType, errorType: i.errorType, message: i.message, status: i.status, count: i.count }))); })
        .catch(() => { if (!cancelled) setIssueResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, ISSUE_SEARCH_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [issueQuery, projectId]);

  function onChange(value: string) {
    setText(value);
    setSendError(null);
    // "@" or "/" at the start of a word opens a picker for what is typed after it.
    const upToCaret = value.slice(0, box.current?.selectionStart ?? value.length);
    const mention = /(?:^|\s)@([^\s@]{0,30})$/.exec(upToCaret);
    const issue = /(?:^|\s)\/([^\s/]{0,40})$/.exec(upToCaret);
    setPicker(mention ? { kind: 'mention', query: mention[1], index: 0 } : issue && attached.length < MAX_ISSUES ? { kind: 'issue', query: issue[1], index: 0 } : null);
  }

  /** Replaces the "@query" or "/query" being typed with `replacement`. */
  function replaceTyped(marker: '@' | '/', replacement: string) {
    const caret = box.current?.selectionStart ?? text.length;
    const head = text.slice(0, caret).replace(new RegExp(`${escapeRegex(marker)}[^\\s${marker === '@' ? '@' : '/'}]{0,40}$`), replacement);
    setText(head + text.slice(caret));
    setPicker(null);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(head.length, head.length);
    });
  }

  function choose(option: PersonView | ChatIssueView) {
    if ('email' in option) {
      replaceTyped('@', `@${option.name} `);
      setPicked((list) => (list.some((p) => p.id === option.id) ? list : [...list, option]));
    } else {
      replaceTyped('/', '');
      setAttached((list) => (list.length >= MAX_ISSUES || list.some((i) => i.id === option.id) ? list : [...list, option]));
    }
  }

  async function submit() {
    const body = text.trim();
    if ((!body && attached.length === 0) || sending) return;
    setSending(true);
    try {
      // Only people whose @name is still in the text count as mentioned.
      await chat.send(body, picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id), attached.map((i) => i.id));
      setText('');
      setPicked([]);
      setAttached([]);
      setPicker(null);
      atBottom.current = true;
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setSending(false);
      box.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker && options.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + 1) % options.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + options.length - 1) % options.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[picker.index]); return; }
    }
    if (picker && e.key === 'Escape') { e.preventDefault(); setPicker(null); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  }

  const removeMessage = (m: ChatMessageView) => action(async () => {
    const ok = await openDialog({
      title: 'Delete this message?',
      message: 'It disappears for everyone in this project.',
      confirmText: 'Delete',
      danger: true,
      onConfirm: () => chat.remove(m.id),
    });
    if (ok) toast('Message deleted');
  });

  // Rows: day dividers and messages; a message continues the previous one when the author and time match.
  const rows: ReactNode[] = [];
  let previous: ChatMessageView | null = null;
  for (const m of chat.messages) {
    const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(m.createdAt);
    if (newDay) {
      rows.push(
        <div key={`d-${m.id}`} className="sticky top-0 z-10 my-4 flex justify-center">
          <span className="rounded-full border border-line bg-panel px-3 py-1 text-xs font-medium text-muted shadow-sm">{dayLabel(m.createdAt)}</span>
        </div>,
      );
    }
    const continued = !newDay && previous !== null && previous.userId === m.userId && !previous.deleted && !m.deleted
      && new Date(m.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_MINUTES * 60000;
    const mine = m.userId === userId;
    const author = m.userName ?? 'Deleted user';
    const names = m.mentions.map((id) => byId.get(id)?.name).filter((n): n is string => Boolean(n));
    rows.push(
      <div key={m.id} className={cn('group flex gap-3 rounded-2xl px-3 py-1 hover:bg-(--hover)', continued ? '' : 'mt-3')}>
        <div className="w-9 shrink-0 pt-0.5">{continued ? null : <Avatar name={author} />}</div>
        <div className="min-w-0 flex-1">
          {continued ? null : (
            <div className="flex items-baseline gap-2">
              <b className="text-sm font-semibold">{author}</b>
              {mine ? <Pill tone="muted">You</Pill> : null}
              <span className="text-xs text-muted" title={new Date(m.createdAt).toLocaleString()}>{clock(m.createdAt)}</span>
            </div>
          )}
          {m.deleted ? (
            <p className="m-0 text-[13px] text-muted italic">This message was deleted</p>
          ) : (
            <>
              {m.text ? (
                <p className="m-0 text-sm leading-relaxed break-words whitespace-pre-wrap">
                  {withMentions(m.text, names, (part, i) => <span key={i} className="rounded bg-(--mention)/10 px-0.5 font-medium text-(--mention)">{part}</span>)}
                </p>
              ) : null}
              {m.issues.length > 0 ? <div className={cn('grid gap-2', m.text && 'mt-2')}>{m.issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)}</div> : null}
            </>
          )}
        </div>
        {!m.deleted && (mine || isOwner) ? (
          <button type="button" aria-label="Delete message" title="Delete" onClick={removeMessage(m)}
            className="size-7 shrink-0 cursor-pointer self-start rounded-full border-0 bg-transparent p-0 text-muted opacity-0 shadow-none group-hover:opacity-100 hover:bg-(--chip) hover:text-danger focus-visible:opacity-100 max-sm:opacity-100">
            <Icon name="close" className="mx-auto size-3.5" />
          </button>
        ) : null}
      </div>,
    );
    previous = m;
  }

  // The text behind the transparent box: the same text, with picked @names in blue (no padding or weight, so the caret lines up).
  const pickedNames = picked.map((p) => p.name).filter((n) => text.includes(`@${n}`));

  return (
    <Page crumbs={crumbs} fill>
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}>
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-3 pb-4 md:px-6">
            {chat.error ? <ErrorNotice error={new Error(chat.error)} /> : chat.loading ? <Loading /> : (
              <>
                {chat.hasMore ? <div className="py-3 text-center"><button type="button" className={pillButton('secondary', 'h-8')} onClick={() => void chat.loadOlder()}>Load older messages</button></div> : null}
                {chat.messages.length === 0 ? (
                  <div className="grid flex-1 place-items-center py-10 text-center">
                    <div className="max-w-sm">
                      <div className="mx-auto mb-4 grid size-16 place-items-center rounded-3xl bg-(--chip) text-muted"><Icon name="chat" className="size-7" /></div>
                      <h2 className="m-0 mb-1 text-lg font-semibold text-fg"># {projectName}</h2>
                      <p className="m-0 text-[13px] text-muted">This is the start of the chat for this project. Say hello, mention a teammate with <b>@</b>, or share an issue with <b>/</b>.</p>
                    </div>
                  </div>
                ) : <div className="mt-auto pt-4">{rows}</div>}
              </>
            )}
          </div>
        </div>

        <footer className="shrink-0 px-3 pb-4 md:px-6 md:pb-6">
          <div className="relative mx-auto w-full max-w-3xl">
            {canPost ? (
              <>
                {picker && (options.length > 0 || (picker.kind === 'issue' && !searching)) ? (
                  <ul role="listbox" aria-label={picker.kind === 'mention' ? 'Mention someone' : 'Attach an issue'}
                    className="absolute right-0 bottom-full left-0 z-20 mb-2 max-h-80 list-none overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-(--menu-shadow)">
                    <li className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-muted" role="presentation">
                      {picker.kind === 'mention' ? 'People in this project' : searching ? 'Searching issues…' : 'Issues in this project'}
                    </li>
                    {options.length === 0 ? <li className="px-2.5 py-2 text-[13px] text-muted" role="presentation">No issues match “{picker.query}”.</li> : null}
                    {options.map((option, i) => (
                      <li key={option.id} role="option" aria-selected={i === picker.index}>
                        <button type="button" onMouseDown={(e) => { e.preventDefault(); choose(option); }} onMouseEnter={() => setPicker({ ...picker, index: i })}
                          className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 py-2 text-left text-[13px] shadow-none', i === picker.index && 'bg-(--hover)')}>
                          {'email' in option ? (
                            <>
                              <Avatar name={option.name} size="sm" />
                              <span className="min-w-0"><b className="block truncate font-medium">{option.name}</b><span className="block truncate text-xs text-muted">{option.email}</span></span>
                            </>
                          ) : (
                            <>
                              <Pill tone={EVENT_TONE[option.eventType] ?? 'neutral'}>{option.eventType}</Pill>
                              <span className="min-w-0 flex-1"><b className="block truncate font-medium">{option.errorType}</b><span className="block truncate text-xs text-muted">{option.message || '(no message)'}</span></span>
                              <span className="shrink-0 text-xs text-muted tabular-nums">{option.count.toLocaleString()}</span>
                            </>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="rounded-3xl border border-line bg-panel shadow-[0_1px_2px_rgba(0,0,0,.04),0_8px_24px_rgba(0,0,0,.06)] transition-colors focus-within:border-line-strong">
                  {attached.length > 0 ? (
                    <div className="grid gap-2 px-3 pt-3 sm:grid-cols-2">
                      {attached.map((issue) => <IssueCard key={issue.id} issue={issue} onRemove={() => setAttached((list) => list.filter((i) => i.id !== issue.id))} />)}
                    </div>
                  ) : null}
                  <div className="relative px-4 pt-3">
                    <div ref={mirror} aria-hidden="true" className="pointer-events-none absolute inset-x-4 top-3 overflow-hidden text-sm leading-6 break-words whitespace-pre-wrap text-fg"
                      style={{ maxHeight: COMPOSER_MAX_HEIGHT }}>
                      {withMentions(text, pickedNames, (part, i) => <span key={i} className="rounded-[4px] bg-(--mention)/15 text-(--mention)">{part}</span>)}
                      {'​'}
                    </div>
                    <textarea
                      ref={box}
                      rows={1}
                      value={text}
                      maxLength={4000}
                      placeholder={`Message # ${projectName}`}
                      aria-label={`Message ${projectName}`}
                      onChange={(e) => onChange(e.target.value)}
                      onKeyDown={onKeyDown}
                      onScroll={(e) => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; }}
                      className="relative block w-full resize-none border-0 bg-transparent p-0 text-sm leading-6 break-words whitespace-pre-wrap text-transparent caret-(--fg) outline-none placeholder:text-faint"
                      style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
                    />
                  </div>
                  <div className="flex items-center gap-1.5 px-3 pt-1 pb-3">
                    <button type="button" title="Mention someone" aria-label="Mention someone" onClick={() => { const el = box.current; if (!el) return; const caret = el.selectionStart; const gap = caret > 0 && !/\s/.test(text[caret - 1]) ? ' ' : ''; setText(text.slice(0, caret) + gap + '@' + text.slice(caret)); setPicker({ kind: 'mention', query: '', index: 0 }); el.focus(); requestAnimationFrame(() => el.setSelectionRange(caret + gap.length + 1, caret + gap.length + 1)); }}
                      className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-sm font-semibold text-muted shadow-none hover:bg-(--hover) hover:text-fg">@</button>
                    <button type="button" title="Attach an issue" aria-label="Attach an issue" disabled={attached.length >= MAX_ISSUES} onClick={() => { const el = box.current; if (!el) return; const caret = el.selectionStart; const gap = caret > 0 && !/\s/.test(text[caret - 1]) ? ' ' : ''; setText(text.slice(0, caret) + gap + '/' + text.slice(caret)); setPicker({ kind: 'issue', query: '', index: 0 }); el.focus(); requestAnimationFrame(() => el.setSelectionRange(caret + gap.length + 1, caret + gap.length + 1)); }}
                      className="grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-sm font-semibold text-muted shadow-none hover:bg-(--hover) hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">/</button>
                    <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted">
                      {sendError ? <span className="text-danger" role="alert">{sendError}</span> : 'Enter to send · Shift+Enter for a new line'}
                    </span>
                    <Link href={`/projects/${projectId}?tab=members`} className="hidden text-xs text-muted no-underline hover:text-fg hover:no-underline sm:block">
                      {everyone.length > 0 ? `${everyone.length} ${everyone.length === 1 ? 'person' : 'people'}` : 'Members'}{chat.live ? ' · live' : ''}
                    </Link>
                    <button type="button" onClick={() => void submit()} disabled={sending || (text.trim().length === 0 && attached.length === 0)} aria-label="Send message" title="Send (Enter)"
                      className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-invert-bg p-0 text-invert-fg shadow-none disabled:cursor-not-allowed disabled:opacity-30">
                      <Icon name="send" className="size-4" />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <p className="m-0 rounded-2xl border border-line bg-panel px-4 py-3 text-[13px] text-muted">You can read this chat but you don&apos;t have permission to write in it. Ask the project owner.</p>
            )}
          </div>
        </footer>
      </div>
    </Page>
  );
}
