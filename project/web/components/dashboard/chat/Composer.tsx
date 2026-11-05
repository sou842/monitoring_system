'use client';

import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import Mention from '@tiptap/extension-mention';
import { Placeholder } from '@tiptap/extensions';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api } from '@/lib/client/api';
import type { Draft } from '@/lib/client/chat';
import { docToMarkdown } from '@/lib/chatText';
import { queryString } from '@/lib/format';
import type { ChatIssueView, ChatMessageView, IssuesResponse, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar } from '../../ui/bits';
import { Icon, type IconName } from '../../ui/Icon';
import { snippetOf } from './MessageRow';
import { ICON_BUTTON, IssueCard, issueIcon, issueTile, onMenuKeyDown, POPOVER, useDismiss, useFocusFirst } from './shared';

/*
 * The message box, Teams-style: it opens as a plain one-line input, but it is a rich editor (Tiptap) inside.
 *  - Typing Markdown formats as you go (**bold**, _italic_, `code`, ``` code block, "> " quote, "- " / "1. " lists),
 *    and Ctrl+B / Ctrl+I / Ctrl+E / Ctrl+Shift+X / Ctrl+Z work everywhere.
 *  - "@" picks a person (the mention becomes a chip; Backspace removes it whole); "/" attaches an issue.
 *  - The "Format" button opens the toolbar and a bigger box; there Enter adds a line and Ctrl+Enter sends.
 * What is sent is the chat's Markdown + the mentioned ids (lib/chatText.ts docToMarkdown), so the server and
 * the message renderer are unchanged. No file or image uploads: pasted images and files are dropped.
 */

/** Most issues one message can carry (the server enforces the same). */
const MAX_ISSUES = 5;
/** Longest message the server accepts; the counter appears near it. */
const MAX_LENGTH = 4000;
const COUNTER_FROM = 3600;
/** Issues listed in the "/" picker, and how long typing pauses before it searches. */
const ISSUE_RESULTS = 6;
const ISSUE_SEARCH_DELAY_MS = 200;
const MENTION_RESULTS = 6;
/** Unsent text is kept per project for this tab only (sessionStorage: gone when the tab closes, never shared). */
const DRAFT_KEY = (projectId: string) => `et_chat_draft:${projectId}`;
const DRAFT_SAVE_DELAY_MS = 400;

/** Common reactions and work emoji, with names for screen readers. */
const EMOJI: Array<[string, string]> = [
  ['👍', 'thumbs up'], ['👎', 'thumbs down'], ['👏', 'clap'], ['🙏', 'thanks'], ['🙌', 'raised hands'], ['💪', 'strong'], ['👀', 'eyes'], ['🤝', 'handshake'],
  ['😀', 'grin'], ['😂', 'laughing'], ['🙂', 'smile'], ['😉', 'wink'], ['🤔', 'thinking'], ['😅', 'sweat smile'], ['😬', 'grimace'], ['😢', 'sad'],
  ['✅', 'done'], ['❌', 'no'], ['⚠️', 'warning'], ['❗', 'important'], ['❓', 'question'], ['🔥', 'fire'], ['🚀', 'ship it'], ['🎉', 'party'],
  ['🐛', 'bug'], ['🛠️', 'fixing'], ['🔍', 'investigating'], ['📌', 'pin'], ['📈', 'up'], ['📉', 'down'], ['⏳', 'waiting'], ['💡', 'idea'],
];

type Mark = 'bold' | 'italic' | 'strike' | 'code' | 'bulletList' | 'orderedList' | 'blockquote' | 'codeBlock' | 'link';
const TOOLBAR: Array<{ id: Mark; icon: IconName; label: string; keys?: string; run: (e: Editor) => void } | 'sep'> = [
  { id: 'bold', icon: 'bold', label: 'Bold', keys: 'Ctrl+B', run: (e) => e.chain().focus().toggleBold().run() },
  { id: 'italic', icon: 'italic', label: 'Italic', keys: 'Ctrl+I', run: (e) => e.chain().focus().toggleItalic().run() },
  { id: 'strike', icon: 'strike', label: 'Strikethrough', keys: 'Ctrl+Shift+S', run: (e) => e.chain().focus().toggleStrike().run() },
  'sep',
  { id: 'bulletList', icon: 'list', label: 'Bulleted list', keys: 'Ctrl+Shift+8', run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: 'orderedList', icon: 'listOrdered', label: 'Numbered list', keys: 'Ctrl+Shift+7', run: (e) => e.chain().focus().toggleOrderedList().run() },
  'sep',
  { id: 'blockquote', icon: 'quote', label: 'Quote', keys: 'Ctrl+Shift+B', run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: 'code', icon: 'code', label: 'Inline code', keys: 'Ctrl+E', run: (e) => e.chain().focus().toggleCode().run() },
  { id: 'codeBlock', icon: 'codeBlock', label: 'Code block', keys: 'Ctrl+Alt+C', run: (e) => e.chain().focus().toggleCodeBlock().run() },
];

/** Where a suggestion ("@" or "/") is: what was typed after the trigger, and how to finish it. */
type Suggest = { kind: 'mention' | 'issue'; query: string; command: (item: { id: string; label?: string }) => void };

function readDraft(projectId: string): JSONContent | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY(projectId));
    if (!raw) return null;
    try {
      const doc = JSON.parse(raw) as JSONContent;
      if (doc && doc.type === 'doc') return doc;
    } catch { /* an older plain-text draft */ }
    // Plain text is wrapped as text (never handed to the editor as HTML).
    return { type: 'doc', content: raw.split('\n').map((line) => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) };
  } catch { return null; }
}
function writeDraft(projectId: string, doc: JSONContent | null) {
  try {
    if (doc) sessionStorage.setItem(DRAFT_KEY(projectId), JSON.stringify(doc)); else sessionStorage.removeItem(DRAFT_KEY(projectId));
  } catch { /* private mode / storage off */ }
}

const isTouch = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: none) and (pointer: coarse)').matches);

/** Builds the suggestion popup bridge: Tiptap tells React what is being typed; React draws the list. */
function bridge(kind: Suggest['kind'], set: (s: Suggest | null) => void, onKey: RefObject<(e: KeyboardEvent) => boolean>) {
  return () => ({
    onStart: (p: SuggestionProps) => set({ kind, query: p.query, command: p.command }),
    onUpdate: (p: SuggestionProps) => set({ kind, query: p.query, command: p.command }),
    onKeyDown: (p: SuggestionKeyDownProps) => onKey.current(p.event),
    onExit: () => set(null),
  });
}

export interface ComposerHandle { focus: () => void }

/** The message box (see the comment at the top of this file). */
export function Composer({ handle, projectId, projectName, people, me, replyTo, onCancelReply, onSend, offline }: {
  handle?: RefObject<ComposerHandle | null>;
  projectId: string;
  projectName: string;
  people: PersonView[];
  me: { id: string; name: string };
  replyTo: ChatMessageView | null;
  onCancelReply: () => void;
  onSend: (draft: Draft) => void;
  offline: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [attached, setAttached] = useState<ChatIssueView[]>([]);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [index, setIndex] = useState(0);
  const [issueResults, setIssueResults] = useState<ChatIssueView[]>([]);
  const [searching, setSearching] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [length, setLength] = useState(0);
  const emojiWrap = useRef<HTMLDivElement>(null);
  const emojiPanel = useRef<HTMLDivElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const listId = `chat-picker-${projectId}`;
  useDismiss(emojiOpen, emojiWrap, () => setEmojiOpen(false), emojiButton);
  useFocusFirst(emojiOpen, emojiPanel);

  // The editor is created once; it reads the latest React state through these refs.
  const latest = useRef({ expanded, replyTo, attached, onCancelReply, submit: () => {} });
  const suggestKey = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const suggestRef = useRef<Suggest | null>(null);
  suggestRef.current = suggest;
  const placeholder = useRef('');
  placeholder.current = offline ? 'You’re offline. Messages send when you’re back.' : expanded ? `Message #${projectName}` : 'Type a message';

  const attachRef = useRef<(issue: ChatIssueView) => void>(() => {});
  attachRef.current = (issue) => setAttached((list) => (list.length >= MAX_ISSUES || list.some((i) => i.id === issue.id) ? list : [...list, issue]));

  const editor = useEditor({
    immediatelyRender: false, // rendered in the browser only (Next.js hydration)
    content: readDraft(projectId),
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        underline: false, // the chat has no way to show it
        link: {
          autolink: true,
          linkOnPaste: true,
          openOnClick: false,
          markdownLinks: false,
          defaultProtocol: 'https',
          protocols: ['http', 'https'],
          isAllowedUri: (url) => /^https?:\/\//i.test(url),
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null, class: 'text-(--mention-fg) underline underline-offset-2' },
        },
      }),
      Placeholder.configure({ placeholder: () => placeholder.current }),
      Mention.configure({
        HTMLAttributes: { class: 'rounded px-0.5 font-medium bg-(--mention-bg) text-(--mention-fg)' },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
        renderHTML: ({ node, options }) => ['span', { ...options.HTMLAttributes, 'data-type': 'mention', 'data-id': node.attrs.id }, `@${node.attrs.label ?? node.attrs.id}`],
        suggestion: { char: '@', pluginKey: new PluginKey('chatMention'), items: () => [], render: bridge('mention', setSuggest, suggestKey) },
      }),
      // "/" searches the project's issues; picking one attaches it as a card (it does not stay in the text).
      Extension.create({
        name: 'issueSuggestion',
        addProseMirrorPlugins() {
          return [Suggestion({
            editor: this.editor,
            char: '/',
            pluginKey: new PluginKey('chatIssue'),
            items: () => [],
            command: ({ editor: e, range, props }) => { e.chain().focus().deleteRange(range).run(); attachRef.current(props as ChatIssueView); },
            render: bridge('issue', setSuggest, suggestKey),
          })];
        },
      }),
      // Keys: Enter sends in the small box (a line in lists, code, the big box and on phones); Ctrl+Enter always sends.
      Extension.create({
        name: 'chatKeys',
        priority: 1000,
        addKeyboardShortcuts() {
          return {
            Enter: ({ editor: e }) => {
              if (suggestRef.current) return false;
              if (latest.current.expanded || isTouch() || e.isActive('codeBlock') || e.isActive('listItem')) return false;
              latest.current.submit();
              return true;
            },
            'Mod-Enter': () => { latest.current.submit(); return true; },
            Escape: () => {
              if (suggestRef.current) return false;
              if (latest.current.replyTo) { latest.current.onCancelReply(); return true; }
              return false;
            },
          };
        },
      }),
    ],
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': `Message #${projectName}`,
        'aria-describedby': `${listId}-hint`,
        'aria-autocomplete': 'list',
        spellcheck: 'true',
        dir: 'auto',
        class: cn(
          'min-h-6 text-[14px] leading-6 text-fg outline-none [overflow-wrap:anywhere] whitespace-pre-wrap',
          '[&_p]:m-0 [&_ul]:my-0.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_li>p]:m-0',
          '[&_blockquote]:my-1 [&_blockquote]:border-0 [&_blockquote]:border-l-[3px] [&_blockquote]:border-solid [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-2',
          '[&_code]:rounded-md [&_code]:border [&_code]:border-line [&_code]:bg-(--chip) [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.86em]',
          '[&_pre]:my-1 [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-panel-2 [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[12.5px] [&_pre]:leading-5 [&_pre]:whitespace-pre-wrap',
          '[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
          '[&_strong]:font-semibold [&_s]:text-muted',
          '[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0',
          '[&_.is-editor-empty:first-child]:before:text-muted [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]',
        ),
      },
      // No uploads: files and images pasted or dropped into the box are ignored.
      handlePaste: (_view, event) => Boolean(event.clipboardData?.files.length),
      handleDrop: (_view, event) => Boolean((event as DragEvent).dataTransfer?.files.length),
    },
    onCreate: ({ editor: e }) => setLength(docToMarkdown(e.getJSON()).text.length),
    onUpdate: ({ editor: e }) => setLength(docToMarkdown(e.getJSON()).text.length),
  }, []);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? Object.fromEntries((['bold', 'italic', 'strike', 'code', 'bulletList', 'orderedList', 'blockquote', 'codeBlock'] as Mark[]).map((m) => [m, e.isActive(m)])) as Record<Mark, boolean> : null),
  });

  useImperativeHandle(handle, () => ({ focus: () => editor?.commands.focus('end') }), [editor]);

  // Focus on open (not on phones, where it would pop the keyboard over the conversation).
  useEffect(() => {
    if (editor && !isTouch()) editor.commands.focus('end');
  }, [editor]);

  // Keep the draft while the person moves around (debounced).
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout>;
    const save = () => { clearTimeout(timer); timer = setTimeout(() => writeDraft(projectId, editor.isEmpty ? null : editor.getJSON()), DRAFT_SAVE_DELAY_MS); };
    editor.on('update', save);
    return () => { clearTimeout(timer); editor.off('update', save); };
  }, [editor, projectId]);

  // Placeholder text follows offline / expanded.
  useEffect(() => { if (editor) editor.view.dispatch(editor.state.tr.setMeta('placeholder', placeholder.current)); }, [editor, offline, expanded]);

  // "/" searches the project's issues as the person types.
  const issueQuery = suggest?.kind === 'issue' ? suggest.query : null;
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
  useEffect(() => setIndex(0), [suggest?.kind, suggest?.query]);

  const mentionOptions = suggest?.kind === 'mention'
    ? people.filter((p) => p.id !== me.id && p.name.toLowerCase().includes(suggest.query.toLowerCase())).slice(0, MENTION_RESULTS)
    : [];
  const options: Array<PersonView | ChatIssueView> = suggest?.kind === 'mention' ? mentionOptions : suggest?.kind === 'issue' ? issueResults : [];
  const shown = suggest !== null && (options.length > 0 || (suggest.kind === 'issue' && !searching) || (suggest.kind === 'mention' && suggest.query.length > 0));

  function choose(option: PersonView | ChatIssueView) {
    if (!suggest) return;
    if ('email' in option) suggest.command({ id: option.id, label: option.name });
    else if (attached.length < MAX_ISSUES) suggest.command(option);
  }

  // Keys while a suggestion list is open (Tiptap asks before it handles them itself).
  suggestKey.current = (e) => {
    if (e.key === 'Escape') { if (editor) exitSuggestion(editor.view); setSuggest(null); return true; }
    if (options.length === 0) {
      if (e.key !== 'Enter' || e.shiftKey) return false;
      if (suggest?.kind === 'issue') return true; // nothing to attach: don't send "/query"
      // "@word" that matches nobody: Enter does what it does anywhere else.
      if (latest.current.expanded || isTouch() || editor?.isActive('listItem') || editor?.isActive('codeBlock')) return false;
      submit();
      return true;
    }
    if (e.key === 'ArrowDown') { setIndex((i) => (i + 1) % options.length); return true; }
    if (e.key === 'ArrowUp') { setIndex((i) => (i + options.length - 1) % options.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { choose(options[Math.min(index, options.length - 1)]); return true; }
    return false;
  };

  // Screen readers: the box controls the open list, and the highlighted option is announced.
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const activeId = shown && options[index] ? `${listId}-${options[index].id}` : null;
    dom.setAttribute('aria-expanded', String(shown));
    if (shown) dom.setAttribute('aria-controls', listId); else dom.removeAttribute('aria-controls');
    if (activeId) dom.setAttribute('aria-activedescendant', activeId); else dom.removeAttribute('aria-activedescendant');
  });

  function submit() {
    if (!editor) return;
    const { text, mentions } = docToMarkdown(editor.getJSON());
    if (!text.trim() && attached.length === 0) return;
    if (text.length > MAX_LENGTH) return;
    onSend({ text: text.trim(), mentions, issues: attached, replyTo });
    editor.commands.clearContent(true);
    writeDraft(projectId, null);
    setAttached([]);
    setEmojiOpen(false);
    editor.commands.focus();
  }
  latest.current = { expanded, replyTo, attached, onCancelReply, submit };

  /** Types `text` at the caret; a trigger ("@", "/") gets a space before it when it would stick to a word. */
  function insert(text: string, trigger = false) {
    if (!editor) return;
    const { from } = editor.state.selection;
    const before = from > 1 ? editor.state.doc.textBetween(from - 1, from, '\n', '\n') : '';
    editor.chain().focus().insertContent(trigger && before && !/\s/.test(before) ? ` ${text}` : text).run();
  }

  const sendable = (length > 0 || attached.length > 0) && length <= MAX_LENGTH;

  const actions: ReactNode = (
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" className={ICON_BUTTON} title={expanded ? 'Hide formatting' : 'Format'} aria-label={expanded ? 'Hide formatting' : 'Show formatting'} aria-pressed={expanded}
        onMouseDown={(e) => e.preventDefault()} onClick={() => { setExpanded((x) => !x); editor?.commands.focus(); }}>
        <Icon name="format" className="size-4" />
      </button>
      <div ref={emojiWrap} className="relative">
        <button ref={emojiButton} type="button" className={ICON_BUTTON} title="Emoji" aria-label="Emoji" aria-haspopup="menu" aria-expanded={emojiOpen}
          onClick={() => setEmojiOpen((o) => !o)}>
          <Icon name="smile" className="size-4" />
        </button>
        {emojiOpen ? (
          <div ref={emojiPanel} role="menu" aria-label="Emoji" onKeyDown={onMenuKeyDown}
            className={cn(POPOVER, 'absolute right-0 bottom-full z-30 mb-2 grid w-74 grid-cols-8 gap-0.5 p-2')}>
            {EMOJI.map(([emoji, name]) => (
              <button key={emoji} type="button" role="menuitem" aria-label={name} title={name} onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => { insert(emoji); setEmojiOpen(false); }}
                className="grid size-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-lg shadow-none hover:bg-(--hover) focus-visible:bg-(--hover) focus-visible:outline-2 focus-visible:outline-(--mention)">{emoji}</button>
            ))}
          </div>
        ) : null}
      </div>
      <button type="button" className={ICON_BUTTON} title={attached.length >= MAX_ISSUES ? `Up to ${MAX_ISSUES} issues per message` : 'Share an issue (/)'} aria-label="Share an issue"
        disabled={attached.length >= MAX_ISSUES} onMouseDown={(e) => e.preventDefault()} onClick={() => insert('/', true)}>
        <Icon name="bug" className="size-4" />
      </button>
      {length >= COUNTER_FROM ? (
        <span className={cn('mx-1 text-[11px] tabular-nums', length > MAX_LENGTH ? 'font-semibold text-danger' : 'text-muted')} aria-live="polite">
          {length > MAX_LENGTH ? `${(length - MAX_LENGTH).toLocaleString()} over` : `${(MAX_LENGTH - length).toLocaleString()} left`}
        </span>
      ) : null}
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={submit} disabled={!sendable} aria-label="Send message" title={expanded ? 'Send (Ctrl+Enter)' : 'Send (Enter)'}
        className="ml-0.5 grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border-0 bg-invert-bg p-0 text-invert-fg shadow-none transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mention) disabled:cursor-not-allowed disabled:bg-transparent disabled:text-muted">
        <Icon name="send" className="size-4" />
      </button>
    </div>
  );

  return (
    <div className="relative mx-auto w-full max-w-5xl px-4 pt-1 pb-[max(12px,env(safe-area-inset-bottom))] md:px-6">
      {shown ? (
        <ul id={listId} role="listbox" aria-label={suggest.kind === 'mention' ? 'People in this project' : 'Issues in this project'}
          className={cn(POPOVER, 'absolute right-4 bottom-full left-4 z-30 mb-1 max-h-80 max-w-xl list-none overflow-y-auto p-1.5 md:right-6 md:left-6')}>
          <li className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase" role="presentation">
            {suggest.kind === 'mention' ? 'People in this project' : searching ? 'Searching issues…' : 'Issues in this project'}
          </li>
          {options.length === 0 ? (
            <li className="px-2.5 py-2 text-[13px] text-muted" role="presentation">
              {suggest.kind === 'mention' ? `Nobody called “${suggest.query}” is in this project.` : suggest.query ? `No issues match “${suggest.query}”.` : 'This project has no issues yet.'}
            </li>
          ) : null}
          {options.map((option, i) => (
            <li key={option.id} id={`${listId}-${option.id}`} role="option" aria-selected={i === index}
              onMouseDown={(e) => { e.preventDefault(); choose(option); }} onMouseEnter={() => setIndex(i)}
              className={cn('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px]', i === index && 'bg-(--hover)')}>
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

      <div className={cn(
        'rounded-xl border border-line-strong bg-panel transition-[border-color,box-shadow] focus-within:border-fg/40 focus-within:shadow-[0_0_0_3px_var(--ring)]',
      )}>
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

        {expanded ? (
          <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1" role="toolbar" aria-label="Formatting">
            {TOOLBAR.map((item, i) => item === 'sep' ? <span key={`s${i}`} className="mx-1 h-5 w-px bg-line" aria-hidden="true" /> : (
              <button key={item.id} type="button" className={ICON_BUTTON} title={item.keys ? `${item.label} (${item.keys})` : item.label} aria-label={item.label}
                aria-pressed={Boolean(active?.[item.id])} disabled={!editor} onMouseDown={(e) => e.preventDefault()} onClick={() => editor && item.run(editor)}>
                <Icon name={item.icon} className="size-4" />
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
            <button type="button" className={ICON_BUTTON} title="Mention someone (@)" aria-label="Mention someone" onMouseDown={(e) => e.preventDefault()} onClick={() => insert('@', true)}>
              <Icon name="at" className="size-4" />
            </button>
            <button type="button" className={ICON_BUTTON} title="Clear formatting" aria-label="Clear formatting" onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}>
              <Icon name="clearFormat" className="size-4" />
            </button>
          </div>
        ) : null}

        {/* Small box: editor and actions on one line. Big box (Format): a taller editor, actions under it. */}
        <div className={cn('flex gap-1 px-1.5 py-1', expanded ? 'flex-col' : 'items-end')}>
          <div className={cn('min-w-0 flex-1 cursor-text overflow-y-auto px-1.5 py-1', expanded ? 'max-h-[min(360px,45vh)] min-h-24' : 'max-h-[min(220px,35vh)]')}
            onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); editor?.commands.focus('end'); } }}>
            {editor ? <EditorContent editor={editor} /> : <div className="text-[14px] leading-6 text-muted">{placeholder.current}</div>}
          </div>
          {expanded ? (
            <div className="flex items-center justify-between gap-2 pl-1.5">
              <span id={`${listId}-hint`} className="truncate text-[11px] text-muted max-sm:hidden"><kbd className="font-sans font-semibold">Enter</kbd> new line · <kbd className="font-sans font-semibold">Ctrl+Enter</kbd> send</span>
              {actions}
            </div>
          ) : actions}
        </div>
      </div>
      {!expanded ? <span id={`${listId}-hint`} className="sr-only">Enter to send, Shift+Enter for a new line. Type @ to mention someone and / to share an issue.</span> : null}
    </div>
  );
}
