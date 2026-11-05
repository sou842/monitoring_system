'use client';

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { api } from '@/lib/client/api';
import type { Draft } from '@/lib/client/chat';
import { applyFormat, insideCodeFence, type Format } from '@/lib/chatText';
import { queryString } from '@/lib/format';
import type { ChatIssueView, ChatMessageView, IssuesResponse, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar } from '../../ui/bits';
import { Icon, type IconName } from '../../ui/Icon';
import { snippetOf } from './MessageRow';
import { ICON_BUTTON, IssueCard, issueIcon, issueTile, onMenuKeyDown, POPOVER, useDismiss, useFocusFirst } from './shared';

/** Most issues one message can carry (the server enforces the same). */
const MAX_ISSUES = 5;
/** Longest message the server accepts; the counter appears near it. */
const MAX_LENGTH = 4000;
const COUNTER_FROM = 3600;
/** Issues listed in the "/" picker, and how long typing pauses before it searches. */
const ISSUE_RESULTS = 6;
const ISSUE_SEARCH_DELAY_MS = 200;
const MENTION_RESULTS = 6;
/** Tallest the message box grows before it scrolls (px). */
const MAX_HEIGHT = 220;
/** Unsent text is kept per project for this tab only (sessionStorage: gone when the tab closes, never shared). */
const DRAFT_KEY = (projectId: string) => `et_chat_draft:${projectId}`;
const DRAFT_SAVE_DELAY_MS = 400;

/** Common reactions and work emoji, with names for screen readers and search. */
const EMOJI: Array<[string, string]> = [
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['👏', 'clap'], ['🙏', 'thanks'], ['🙌', 'raised hands'], ['💪', 'strong'], ['👀', 'eyes'], ['🤝', 'handshake'],
  ['😀', 'grin'], ['😂', 'laughing'], ['🙂', 'smile'], ['😉', 'wink'], ['🤔', 'thinking'], ['😅', 'sweat smile'], ['😬', 'grimace'], ['😢', 'sad'],
  ['✅', 'done'], ['❌', 'no'], ['⚠️', 'warning'], ['❗', 'important'], ['❓', 'question'], ['🔥', 'fire'], ['🚀', 'ship it'], ['🎉', 'party'],
  ['🐛', 'bug'], ['🛠️', 'fixing'], ['🔍', 'investigating'], ['📌', 'pin'], ['📈', 'up'], ['📉', 'down'], ['⏳', 'waiting'], ['💡', 'idea'],
];

type Picker = { kind: 'mention' | 'issue'; query: string; index: number };

const FORMATS: Array<{ format: Format; icon: IconName; label: string; keys: string }> = [
  { format: 'bold', icon: 'bold', label: 'Bold', keys: 'Ctrl+B' },
  { format: 'italic', icon: 'italic', label: 'Italic', keys: 'Ctrl+I' },
  { format: 'strike', icon: 'strike', label: 'Strikethrough', keys: 'Ctrl+Shift+X' },
  { format: 'code', icon: 'code', label: 'Inline code', keys: 'Ctrl+E' },
  { format: 'codeblock', icon: 'codeBlock', label: 'Code block', keys: 'or type ```' },
  { format: 'quote', icon: 'quote', label: 'Quote', keys: 'Ctrl+Shift+9' },
];

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readDraft(projectId: string): string {
  try { return sessionStorage.getItem(DRAFT_KEY(projectId)) ?? ''; } catch { return ''; }
}
function writeDraft(projectId: string, text: string) {
  try { if (text) sessionStorage.setItem(DRAFT_KEY(projectId), text); else sessionStorage.removeItem(DRAFT_KEY(projectId)); } catch { /* private mode / storage off */ }
}

/** `text` with each "@Name" wrapped by `wrap`. */
function withMentions(text: string, names: string[], wrap: (part: string, key: number) => ReactNode): ReactNode[] {
  if (names.length === 0) return [text];
  const parts = text.split(new RegExp(`(@(?:${[...names].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')}))`, 'g'));
  return parts.map((part, i) => (i % 2 === 1 ? wrap(part, i) : part));
}

export interface ComposerHandle { focus: () => void }

/** The message box: formatting, @mentions, "/" issues, emoji, replies, drafts. */
export function Composer({ ref, projectId, projectName, people, me, replyTo, onCancelReply, onSend, offline }: {
  ref?: Ref<ComposerHandle>;
  projectId: string;
  projectName: string;
  people: PersonView[];
  me: { id: string; name: string };
  replyTo: ChatMessageView | null;
  onCancelReply: () => void;
  onSend: (draft: Draft) => void;
  offline: boolean;
}) {
  const [text, setText] = useState(() => readDraft(projectId));
  const [picked, setPicked] = useState<PersonView[]>([]);
  const [attached, setAttached] = useState<ChatIssueView[]>([]);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [issueResults, setIssueResults] = useState<ChatIssueView[]>([]);
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const emojiWrap = useRef<HTMLDivElement>(null);
  const emojiPanel = useRef<HTMLDivElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const listId = `chat-picker-${projectId}`;

  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), []);
  useDismiss(emojiOpen, emojiWrap, () => setEmojiOpen(false), emojiButton);
  useFocusFirst(emojiOpen, emojiPanel);

  // Focus on open (not on phones, where it would pop the keyboard over the conversation).
  useEffect(() => {
    if (!window.matchMedia?.('(hover: none)').matches) box.current?.focus();
  }, [projectId]);

  // Keep the draft while the person moves around (debounced).
  useEffect(() => {
    const timer = setTimeout(() => writeDraft(projectId, text), DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, projectId]);

  // The box grows with its text, up to MAX_HEIGHT.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const mentionOptions = picker?.kind === 'mention'
    ? people.filter((p) => p.id !== me.id && p.name.toLowerCase().includes(picker.query.toLowerCase())).slice(0, MENTION_RESULTS)
    : [];
  const options: Array<PersonView | ChatIssueView> = picker?.kind === 'mention' ? mentionOptions : picker?.kind === 'issue' ? issueResults : [];
  const pickerShown = picker !== null && (options.length > 0 || (picker.kind === 'issue' && !searching) || (picker.kind === 'mention' && picker.query.length > 0));

  // "/" searches the project's issues as the person types.
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

  function caretAt(start: number, end = start) {
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, end);
    });
  }

  function onChange(value: string) {
    setText(value);
    const upToCaret = value.slice(0, box.current?.selectionStart ?? value.length);
    const mention = /(?:^|\s)@([^\s@]{0,30})$/.exec(upToCaret);
    const issue = /(?:^|\s)\/([^\s/]{0,40})$/.exec(upToCaret);
    setPicker(mention ? { kind: 'mention', query: mention[1], index: 0 } : issue && attached.length < MAX_ISSUES ? { kind: 'issue', query: issue[1], index: 0 } : null);
  }

  function replaceTyped(marker: '@' | '/', replacement: string) {
    const caret = box.current?.selectionStart ?? text.length;
    const head = text.slice(0, caret).replace(new RegExp(`${escapeRegex(marker)}[^\\s@/]{0,40}$`), replacement);
    setText(head + text.slice(caret));
    setPicker(null);
    caretAt(head.length);
  }

  function insertAtCaret(insert: string, open?: Picker['kind']) {
    const el = box.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const gap = open && start > 0 && !/\s/.test(text[start - 1]) ? ' ' : '';
    setText(text.slice(0, start) + gap + insert + text.slice(end));
    if (open) setPicker({ kind: open, query: '', index: 0 });
    caretAt(start + gap.length + insert.length);
  }

  function format(kind: Format) {
    const el = box.current;
    const result = applyFormat(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, kind);
    if (result.text.length > MAX_LENGTH) return;
    setText(result.text);
    caretAt(result.start, result.end);
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

  function submit() {
    const body = text.trim();
    if (!body && attached.length === 0) return;
    onSend({ text: body, mentions: picked.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id), issues: attached, replyTo });
    setText('');
    writeDraft(projectId, '');
    setPicked([]);
    setAttached([]);
    setPicker(null);
    setEmojiOpen(false);
    box.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (picker && options.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + 1) % options.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicker({ ...picker, index: (picker.index + options.length - 1) % options.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[picker.index]); return; }
    }
    if (e.key === 'Escape') {
      if (picker) { e.preventDefault(); setPicker(null); return; }
      if (replyTo) { e.preventDefault(); onCancelReply(); return; }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      const shortcut: Format | null = !e.shiftKey && k === 'b' ? 'bold' : !e.shiftKey && k === 'i' ? 'italic' : !e.shiftKey && k === 'e' ? 'code'
        : e.shiftKey && k === 'x' ? 'strike' : e.shiftKey && (k === '9' || k === '(') ? 'quote' : null;
      if (shortcut) { e.preventDefault(); format(shortcut); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      // Inside an open ``` block Enter adds a line, so code can be typed naturally.
      if (insideCodeFence(text, e.currentTarget.selectionStart)) return;
      e.preventDefault();
      submit();
    }
  }

  const pickedNames = picked.map((p) => p.name).filter((n) => text.includes(`@${n}`));
  const sendable = (text.trim().length > 0 || attached.length > 0) && text.length <= MAX_LENGTH;
  const activeId = pickerShown && options[picker.index] ? `${listId}-${options[picker.index].id}` : undefined;

  return (
    <div className="relative mx-auto w-full max-w-5xl px-4 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6">
      {pickerShown ? (
        <ul id={listId} role="listbox" aria-label={picker.kind === 'mention' ? 'People in this project' : 'Issues in this project'}
          className={cn(POPOVER, 'absolute right-4 bottom-full left-4 z-30 mb-1 max-h-80 max-w-xl list-none overflow-y-auto p-1.5 md:right-6 md:left-6')}>
          <li className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase" role="presentation">
            {picker.kind === 'mention' ? 'People in this project' : searching ? 'Searching issues…' : 'Issues in this project'}
          </li>
          {options.length === 0 ? (
            <li className="px-2.5 py-2 text-[13px] text-muted" role="presentation">
              {picker.kind === 'mention' ? `Nobody called “${picker.query}” is in this project.` : picker.query ? `No issues match “${picker.query}”.` : 'This project has no issues yet.'}
            </li>
          ) : null}
          {options.map((option, i) => (
            <li key={option.id} id={`${listId}-${option.id}`} role="option" aria-selected={i === picker.index}
              onMouseDown={(e) => { e.preventDefault(); choose(option); }} onMouseEnter={() => setPicker({ ...picker, index: i })}
              className={cn('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]', i === picker.index && 'bg-(--hover)')}>
              {'email' in option ? (
                <>
                  <Avatar name={option.name} size="sm" />
                  <span className="min-w-0"><b className="block truncate font-medium">{option.name}</b><span className="block truncate text-xs text-muted">{option.email}</span></span>
                </>
              ) : (
                <>
                  <span className={cn('grid size-7 shrink-0 place-items-center rounded-md', issueTile(option.eventType))} aria-hidden="true"><Icon name={issueIcon(option)} className="size-3.5" /></span>
                  <span className="min-w-0 flex-1"><b className="block truncate font-medium">{option.errorType}</b><span className="block truncate text-xs text-muted">{option.message || '(no message)'}</span></span>
                  <span className="shrink-0 text-xs text-muted tabular-nums">{option.count.toLocaleString()}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="rounded-xl border border-line-strong bg-panel transition-[border-color,box-shadow] focus-within:border-fg/40 focus-within:shadow-[0_0_0_3px_var(--ring)]">
        {replyTo ? (
          <div className="flex items-center gap-2.5 border-b border-line px-3 py-2">
            <Icon name="reply" className="size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1 text-xs leading-4">
              <span className="text-muted">Replying to </span>
              <span className="font-semibold text-fg">{replyTo.userId === me.id ? 'yourself' : (replyTo.userName ?? 'Deleted user')}</span>
              <div className="truncate text-fg-2">{snippetOf(replyTo)}</div>
            </div>
            <button type="button" onClick={onCancelReply} aria-label="Cancel reply" title="Cancel reply (Esc)" className={cn(ICON_BUTTON, 'size-7 rounded-full')}><Icon name="close" className="size-3.5" /></button>
          </div>
        ) : null}

        {attached.length > 0 ? (
          <div className="grid gap-1.5 border-b border-line p-2">
            {attached.map((issue) => <IssueCard key={issue.id} issue={issue} onRemove={() => setAttached((list) => list.filter((i) => i.id !== issue.id))} />)}
          </div>
        ) : null}

        <div className="relative px-3 pt-2.5">
          {/* Mirror under the transparent textarea, so @names show highlighted while typing. In Windows high-contrast
              mode (forced colours) the mirror is hidden and the textarea's own text is shown instead. */}
          <div ref={mirror} aria-hidden="true" className="pointer-events-none absolute inset-x-3 top-2.5 bottom-0 overflow-hidden text-[14px] leading-6 wrap-break-word whitespace-pre-wrap text-fg forced-colors:hidden">
            {withMentions(text, pickedNames, (part, i) => <span key={i} className="rounded-sm bg-(--mention-bg) text-(--mention-fg)">{part}</span>)}
            {'​'}
          </div>
          <textarea
            ref={box}
            rows={1}
            dir="auto"
            value={text}
            maxLength={MAX_LENGTH}
            placeholder={offline ? 'You’re offline — messages send when you’re back' : `Message #${projectName}`}
            aria-label={`Message #${projectName}`}
            aria-describedby={`${listId}-hint`}
            role="combobox"
            aria-expanded={pickerShown}
            aria-controls={pickerShown ? listId : undefined}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setPicker(null)}
            onScroll={(e) => { if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop; }}
            className="relative block w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-6 wrap-break-word whitespace-pre-wrap text-transparent caret-(--fg) shadow-none outline-none placeholder:text-muted forced-colors:text-[CanvasText]"
            style={{ maxHeight: MAX_HEIGHT }}
          />
        </div>

        <div className="flex items-center gap-0.5 px-1.5 pt-1 pb-1.5" role="toolbar" aria-label="Formatting">
          {FORMATS.map((f) => (
            <button key={f.format} type="button" className={cn(ICON_BUTTON, 'max-sm:hidden')} title={`${f.label} (${f.keys})`} aria-label={f.label}
              onMouseDown={(e) => e.preventDefault()} onClick={() => format(f.format)}>
              <Icon name={f.icon} className="size-4" />
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-line max-sm:hidden" aria-hidden="true" />
          <button type="button" className={ICON_BUTTON} title="Mention someone (@)" aria-label="Mention someone" onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCaret('@', 'mention')}>
            <Icon name="at" className="size-4" />
          </button>
          <button type="button" className={ICON_BUTTON} title={attached.length >= MAX_ISSUES ? `Up to ${MAX_ISSUES} issues per message` : 'Share an issue (/)'} aria-label="Share an issue"
            disabled={attached.length >= MAX_ISSUES} onMouseDown={(e) => e.preventDefault()} onClick={() => insertAtCaret('/', 'issue')}>
            <Icon name="bug" className="size-4" />
          </button>
          <div ref={emojiWrap} className="relative">
            <button ref={emojiButton} type="button" className={ICON_BUTTON} title="Emoji" aria-label="Emoji" aria-haspopup="menu" aria-expanded={emojiOpen}
              onClick={() => { setEmojiOpen((o) => !o); setPicker(null); }}>
              <Icon name="smile" className="size-4" />
            </button>
            {emojiOpen ? (
              <div ref={emojiPanel} role="menu" aria-label="Emoji" onKeyDown={onMenuKeyDown}
                className={cn(POPOVER, 'absolute bottom-full left-0 z-30 mb-2 grid w-74 grid-cols-8 gap-0.5 p-2 max-sm:-left-20')}>
                {EMOJI.map(([emoji, name]) => (
                  <button key={emoji} type="button" role="menuitem" aria-label={name} title={name} onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => { insertAtCaret(emoji); setEmojiOpen(false); }}
                    className="grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-lg shadow-none hover:bg-(--hover) focus-visible:bg-(--hover) focus-visible:outline-2 focus-visible:outline-(--mention)">{emoji}</button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="ml-auto" />
          {text.length >= COUNTER_FROM ? (
            <span className={cn('mr-2 text-[11px] tabular-nums', text.length >= MAX_LENGTH ? 'font-semibold text-danger' : 'text-muted')} aria-live="polite">
              {(MAX_LENGTH - text.length).toLocaleString()} left
            </span>
          ) : null}
          <button type="button" onClick={submit} disabled={!sendable} aria-label="Send message" title="Send (Enter)"
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-invert-bg p-0 text-invert-fg shadow-none transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mention) disabled:cursor-not-allowed disabled:bg-(--chip) disabled:text-muted">
            <Icon name="send" className="size-4" />
          </button>
        </div>
      </div>
      <p id={`${listId}-hint`} className="m-0 mt-1.5 px-1 text-[11px] text-muted max-sm:hidden">
        <kbd className="font-sans font-semibold">Enter</kbd> to send · <kbd className="font-sans font-semibold">Shift+Enter</kbd> new line · <b>**bold**</b> · <i>_italic_</i> · <code className="font-mono">`code`</code> · <code className="font-mono">```block```</code>
      </p>
    </div>
  );
}
