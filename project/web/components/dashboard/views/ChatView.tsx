'use client';

import Link from 'next/link';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useApi } from '@/lib/client/api';
import { useChat } from '@/lib/client/chat';
import type { ChatMessageView, MembersResponse, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, EmptyState, ErrorNotice, Loading } from '../../ui/bits';
import { useDialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { CARD, Pill, pillButton } from '../../ui/kit';
import { useToast } from '../../ui/Toasts';
import { Page } from '../Page';
import { useSession } from '../Shell';

/** A message goes under the previous one without a new header when it's by the same person within this many minutes. */
const GROUP_MINUTES = 5;
/** Pixels from the bottom within which a new message keeps the list scrolled down. */
const STICK_PX = 120;

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The message text with the names of people it mentions picked out in blue. */
function MessageText({ message, people }: { message: ChatMessageView; people: Map<string, PersonView> }) {
  const names = message.mentions.map((id) => people.get(id)?.name).filter((n): n is string => Boolean(n));
  if (names.length === 0) return <>{message.text}</>;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = message.text.split(new RegExp(`(@(?:${escaped.join('|')}))`, 'g'));
  return <>{parts.map((part, i) => (i % 2 === 1 ? <span key={i} className="rounded bg-(--mention)/10 px-0.5 font-medium text-(--mention)">{part}</span> : <span key={i}>{part}</span>))}</>;
}

/** The project chat: the active project's single channel (docs/MEMBERS_AND_CHAT.md). */
export function ChatView() {
  const { user, projects, projectId } = useSession();
  const project = projects && projectId ? projects.find((p) => p.id === projectId) : undefined;
  const crumbs = [{ label: 'Chats' }, ...(project ? [{ label: `# ${project.name}` }] : [])];

  if (!projects) return <Page crumbs={crumbs}><Loading /></Page>;
  if (!project) {
    return (
      <Page crumbs={crumbs}>
        <EmptyState icon="chat" title="No chats yet" text="Every project has a chat for the people who have access to it. Create a project, then add your teammates." />
      </Page>
    );
  }
  return <Channel key={project.id} projectId={project.id} projectName={project.name} canPost={project.permissions.includes('chat.post')} isOwner={project.role === 'owner'} userId={user.id} crumbs={crumbs} />;
}

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
  const [picker, setPicker] = useState<{ query: string; index: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (canPost) box.current?.focus(); }, [canPost, projectId]);

  const matches = picker ? everyone.filter((p) => p.id !== userId && p.name.toLowerCase().includes(picker.query.toLowerCase())).slice(0, 6) : [];

  function onChange(value: string) {
    setText(value);
    setSendError(null);
    // An "@" at the start of a word opens the picker for what is typed after it.
    const upToCaret = value.slice(0, box.current?.selectionStart ?? value.length);
    const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(upToCaret);
    setPicker(m ? { query: m[1], index: 0 } : null);
  }

  function choose(person: PersonView) {
    const caret = box.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@[^\s@]{0,30}$/, `@${person.name} `);
    setText(before + text.slice(caret));
    setPicked((list) => (list.some((p) => p.id === person.id) ? list : [...list, person]));
    setPicker(null);
    box.current?.focus();
  }

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      // Only people whose @name is still in the text count as mentioned.
      await chat.send(body, picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id));
      setText('');
      setPicked([]);
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
    if (picker && matches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + 1) % matches.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + matches.length - 1) % matches.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[picker.index]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setPicker(null); return; }
    }
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
    if (newDay) rows.push(<div key={`d-${m.id}`} className="my-3 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" /><span>{dayLabel(m.createdAt)}</span><span className="h-px flex-1 bg-line" /></div>);
    const continued = !newDay && previous !== null && previous.userId === m.userId && !previous.deleted && !m.deleted
      && new Date(m.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_MINUTES * 60000;
    const mine = m.userId === userId;
    const author = m.userName ?? 'Deleted user';
    rows.push(
      <div key={m.id} className={cn('group flex gap-3 rounded-xl px-2 py-0.5 hover:bg-(--hover)', continued ? '' : 'mt-3')}>
        <div className="w-9 shrink-0">{continued ? null : <Avatar name={author} />}</div>
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
            <p className="m-0 text-sm leading-relaxed break-words whitespace-pre-wrap"><MessageText message={m} people={byId} /></p>
          )}
        </div>
        {!m.deleted && (mine || isOwner) ? (
          <button type="button" aria-label="Delete message" title="Delete" onClick={removeMessage(m)}
            className="h-7 w-7 shrink-0 cursor-pointer self-start rounded-full border-0 bg-transparent p-0 text-muted opacity-0 shadow-none group-hover:opacity-100 hover:bg-(--chip) hover:text-danger focus-visible:opacity-100 max-sm:opacity-100">
            <Icon name="close" className="mx-auto size-3.5" />
          </button>
        ) : null}
      </div>,
    );
    previous = m;
  }

  return (
    <Page crumbs={crumbs}>
      <div className={cn(CARD, 'flex h-[calc(100dvh-150px)] min-h-[420px] flex-col overflow-hidden')}>
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <Avatar name={projectName} shape="square" />
          <div className="min-w-0 flex-1">
            <h1 className="m-0 truncate text-base font-semibold"># {projectName}</h1>
            <p className="m-0 text-xs text-muted">{everyone.length > 0 ? `${everyone.length} ${everyone.length === 1 ? 'person' : 'people'} with access` : ' '}{chat.live ? ' · live' : ''}</p>
          </div>
          <div className="flex -space-x-2" aria-hidden="true">{everyone.slice(0, 3).map((p) => <span key={p.id} className="rounded-full ring-2 ring-panel"><Avatar name={p.name} size="sm" /></span>)}</div>
          <Link href={`/projects/${projectId}?tab=members`} className={pillButton('secondary', 'h-8 no-underline hover:no-underline')}><Icon name="users" className="size-3.5" />Members</Link>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 md:px-5" onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}>
          {chat.error ? <ErrorNotice error={new Error(chat.error)} /> : chat.loading ? <Loading /> : (
            <>
              {chat.hasMore ? <div className="py-2 text-center"><button type="button" className={pillButton('ghost', 'h-8')} onClick={() => void chat.loadOlder()}>Load older messages</button></div> : null}
              {chat.messages.length === 0 ? (
                <div className="grid h-full place-items-center text-center text-[13px] text-muted">
                  <div><b className="mb-1 block text-sm text-fg">This is the start of # {projectName}</b>Say hello to the people who have access to this project.</div>
                </div>
              ) : rows}
            </>
          )}
        </div>

        <footer className="relative border-t border-line p-3 md:px-5">
          {canPost ? (
            <>
              {picker && matches.length > 0 ? (
                <ul role="listbox" aria-label="Mention someone" className="absolute right-5 bottom-full left-5 mb-1 max-w-sm list-none overflow-hidden rounded-2xl border border-line bg-panel p-1 shadow-(--menu-shadow)">
                  {matches.map((p, i) => (
                    <li key={p.id} role="option" aria-selected={i === picker.index}>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); choose(p); }}
                        className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] shadow-none', i === picker.index && 'bg-(--hover)')}>
                        <Avatar name={p.name} size="sm" /><span className="min-w-0"><b className="block truncate font-medium">{p.name}</b><span className="block truncate text-xs text-muted">{p.email}</span></span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex items-end gap-2 rounded-3xl border border-line-strong bg-panel py-1.5 pr-1.5 pl-4 focus-within:border-fg/40">
                <textarea
                  ref={box}
                  rows={1}
                  value={text}
                  maxLength={4000}
                  placeholder={`Message # ${projectName}…  (type @ to mention)`}
                  aria-label={`Message ${projectName}`}
                  onChange={(e) => onChange(e.target.value)}
                  onKeyDown={onKeyDown}
                  className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent py-1.5 text-sm outline-none [field-sizing:content]"
                />
                <button type="button" onClick={() => void submit()} disabled={sending || text.trim().length === 0} aria-label="Send message" title="Send (Enter)"
                  className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-invert-bg p-0 text-invert-fg shadow-none disabled:cursor-not-allowed disabled:opacity-30">
                  <Icon name="send" className="size-4" />
                </button>
              </div>
              <p className="mt-1.5 mb-0 px-2 text-xs text-muted">{sendError ? <span className="text-danger" role="alert">{sendError}</span> : 'Enter to send · Shift+Enter for a new line'}</p>
            </>
          ) : (
            <p className="m-0 px-2 py-2 text-[13px] text-muted">You can read this chat but you don&apos;t have permission to write in it. Ask the project owner.</p>
          )}
        </footer>
      </div>
    </Page>
  );
}

