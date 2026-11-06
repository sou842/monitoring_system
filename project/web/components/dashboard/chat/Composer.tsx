'use client';

import { Extension, type Editor, type JSONContent } from '@tiptap/core';
import Mention from '@tiptap/extension-mention';
import { Placeholder } from '@tiptap/extensions';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import type { Draft } from '@/lib/client/chat';
import { docToMarkdown, markdownToDoc } from '@/lib/chatText';
import type { ChatIssueView, ChatMessageView, PersonView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from '../../ui/Icon';
import { snippetOf } from './MessageRow';
import { ChatAvatar, ICON_BUTTON, IssueCard, issueIcon, issueTile, onMenuKeyDown, SendIcon, useDismiss } from './shared';
import { EmojiPicker } from './EmojiPicker';
import { prefetchIssues, useIssuePicker } from './useIssuePicker';

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
/** Scrolling within this many px of the end of the "/" list loads the next page of issues. */
const ISSUE_LOAD_MORE_PX = 96;
/** Placeholder rows shown while the first page of the "/" list loads. */
const ISSUE_SKELETON_ROWS = 4;
/** Unsent text is kept per project for this tab only (sessionStorage: gone when the tab closes, never shared). */
const DRAFT_KEY = (projectId: string) => `et_chat_draft:${projectId}`;
const DRAFT_SAVE_DELAY_MS = 400;

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
export function Composer({ handle, projectId, projectName, people, me, replyTo, onCancelReply, onSend, offline, editing, onCancelEdit, onSaveEdit, onTyping }: {
  /** Called as you type (the page turns it into "is typing…" for the others, rate-limited there). */
  onTyping?: () => void;
  handle?: RefObject<ComposerHandle | null>;
  projectId: string;
  projectName: string;
  people: PersonView[];
  me: { id: string; name: string };
  replyTo: ChatMessageView | null;
  onCancelReply: () => void;
  onSend: (draft: Draft) => void;
  offline: boolean;
  /** Your own message opened for editing: its text and issues fill the box, and sending saves them instead. */
  editing: ChatMessageView | null;
  onCancelEdit: () => void;
  /** Saves the edit; rejects when it could not be saved (the box keeps the text). */
  onSaveEdit: (text: string, issues: ChatIssueView[]) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [attached, setAttached] = useState<ChatIssueView[]>([]);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [index, setIndex] = useState(0);
  /** What is in the issue picker's search box: what was typed after "/" in the message, or typed in the box itself. */
  const [pickerText, setPickerText] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [length, setLength] = useState(0);
  /** The unsent draft (text and issues) set aside while a message is being edited, put back afterwards. */
  const stash = useRef<{ doc: JSONContent | null; attached: ChatIssueView[] } | null>(null);
  const saving = useRef(false);
  const emojiWrap = useRef<HTMLDivElement>(null);
  const emojiPanel = useRef<HTMLDivElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const listId = `chat-picker-${projectId}`;
  useDismiss(emojiOpen, emojiWrap, () => setEmojiOpen(false), emojiButton);

  // The editor is created once; it reads the latest React state through these refs.
  const latest = useRef({ expanded, replyTo, attached, onCancelReply, editing, onCancelEdit, submit: () => {} });
  const suggestKey = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const suggestRef = useRef<Suggest | null>(null);
  suggestRef.current = suggest;
  const placeholder = useRef('');
  placeholder.current = offline ? 'You’re offline. Messages send when you’re back.' : editing ? 'Edit message' : 'Message';

  // Editing an old message isn't "typing a message": nothing is announced then.
  const onTypingRef = useRef<(() => void) | undefined>(undefined);
  onTypingRef.current = editing ? undefined : onTyping;

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
              if (latest.current.editing) { latest.current.onCancelEdit(); return true; }
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
          'min-h-6 text-[16px] leading-6 text-(--tg-text) outline-none [overflow-wrap:anywhere] whitespace-pre-wrap',
          '[&_p]:m-0 [&_ul]:my-0.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_li>p]:m-0',
          '[&_blockquote]:my-1 [&_blockquote]:border-0 [&_blockquote]:border-l-[3px] [&_blockquote]:border-solid [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-2',
          '[&_code]:rounded-md [&_code]:border [&_code]:border-line [&_code]:bg-(--chip) [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.86em]',
          '[&_pre]:my-1 [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-panel-2 [&_pre]:p-2.5 [&_pre]:font-mono [&_pre]:text-[12.5px] [&_pre]:leading-5 [&_pre]:whitespace-pre-wrap',
          '[&_pre_code]:border-0 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
          '[&_strong]:font-semibold [&_s]:text-muted',
          '[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0',
          '[&_.is-editor-empty:first-child]:before:text-(--tg-in-meta) [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]',
        ),
      },
      // No uploads: files and images pasted or dropped into the box are ignored.
      handlePaste: (_view, event) => Boolean(event.clipboardData?.files.length),
      handleDrop: (_view, event) => Boolean((event as DragEvent).dataTransfer?.files.length),
    },
    onCreate: ({ editor: e }) => setLength(docToMarkdown(e.getJSON()).text.length),
    onUpdate: ({ editor: e }) => {
      setLength(docToMarkdown(e.getJSON()).text.length);
      if (!e.isEmpty) onTypingRef.current?.();
    },
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
    const save = () => { clearTimeout(timer); timer = setTimeout(() => { if (!stash.current) writeDraft(projectId, editor.isEmpty ? null : editor.getJSON()); }, DRAFT_SAVE_DELAY_MS); };
    editor.on('update', save);
    return () => { clearTimeout(timer); editor.off('update', save); };
  }, [editor, projectId]);

  // Editing a message: it fills the box (your unsent draft waits aside); when the edit ends the draft comes back.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (!editor) return;
    if (editing) {
      saving.current = false;
      if (!stash.current) stash.current = { doc: editor.isEmpty ? null : editor.getJSON(), attached: latest.current.attached };
      editor.commands.setContent(markdownToDoc(editing.text, people), { emitUpdate: false });
      setAttached(editing.issues);
      setLength(editing.text.length);
      editor.commands.focus('end');
    } else if (stash.current) {
      const back = stash.current;
      stash.current = null;
      editor.commands.setContent(back.doc ?? '', { emitUpdate: false });
      setAttached(back.attached);
      setLength(back.doc ? docToMarkdown(back.doc).text.length : 0);
      saving.current = false;
    }
    // Only when a different message is opened (or the edit ends), not when its text changes underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, editingId]);

  // Placeholder text follows offline / expanded / editing.
  useEffect(() => { if (editor) editor.view.dispatch(editor.state.tr.setMeta('placeholder', placeholder.current)); }, [editor, offline, expanded, editingId]);

  // "/" lists the project's issues (already fetched when the chat opened) and searches them as the person types;
  // scrolling to the end of the list loads the next page.
  useEffect(() => { prefetchIssues(projectId); }, [projectId]);
  const issueQuery = suggest?.kind === 'issue' ? pickerText : null;
  useEffect(() => { if (suggest) setPickerText(suggest.query); }, [suggest?.kind, suggest?.query]);
  const picker = useIssuePicker(projectId, issueQuery);
  const issueResults = picker.items;
  useEffect(() => setIndex(0), [suggest?.kind, suggest?.query, pickerText]);

  // Everyone else in the project; the search box filters by name or email (the list scrolls, it is not cut short).
  const others = people.filter((p) => p.id !== me.id);
  const needle = pickerText.trim().toLowerCase();
  const mentionOptions = suggest?.kind === 'mention'
    ? others.filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle))
    : [];
  const options: Array<PersonView | ChatIssueView> = suggest?.kind === 'mention' ? mentionOptions : suggest?.kind === 'issue' ? issueResults : [];
  const shown = suggest !== null;
  // Keep the highlighted option in view, and fetch more issues when the highlight nears the end of what is loaded.
  const { hasMore: moreIssues, loadMore: loadMoreIssues } = picker;
  useEffect(() => {
    if (!shown || !options[index]) return;
    document.getElementById(`${listId}-${options[index].id}`)?.scrollIntoView({ block: 'nearest' });
    if (suggest?.kind === 'issue' && moreIssues && index >= options.length - 3) loadMoreIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, shown]);

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
      if (suggest?.kind === 'issue' || e.target instanceof HTMLInputElement) return true; // nothing to attach: don't send "/query" (or send the message from the search box)
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
    if (editing) {
      const body = text.trim();
      const unchanged = body === editing.text && attached.length === editing.issues.length && attached.every((a, i) => a.id === editing.issues[i].id);
      if (unchanged) { onCancelEdit(); return; }
      if (saving.current) return;
      saving.current = true;
      onSaveEdit(body, attached).catch(() => { saving.current = false; });
      return;
    }
    onSend({ text: text.trim(), mentions, issues: attached, replyTo });
    editor.commands.clearContent(true);
    writeDraft(projectId, null);
    setAttached([]);
    setEmojiOpen(false);
    editor.commands.focus();
  }
  latest.current = { expanded, replyTo, attached, onCancelReply, editing, onCancelEdit, submit };

  /** Types `text` at the caret; a trigger ("@", "/") gets a space before it when it would stick to a word. */
  function insert(text: string, trigger = false) {
    if (!editor) return;
    const { from } = editor.state.selection;
    const before = from > 1 ? editor.state.doc.textBetween(from - 1, from, '\n', '\n') : '';
    editor.chain().focus().insertContent(trigger && before && !/\s/.test(before) ? ` ${text}` : text).run();
  }

  const sendable = (length > 0 || attached.length > 0) && length <= MAX_LENGTH;

  // The box: emoji on the left, the editor, format + issue on the right; the round send button sits outside it.
  const side = cn(ICON_BUTTON, 'size-9 rounded-full text-(--tg-in-meta) transition-colors hover:bg-(--tg-menu-hover) hover:text-(--tg-text) aria-pressed:bg-(--tg-menu-hover) aria-pressed:text-(--tg-accent) aria-expanded:bg-(--tg-menu-hover) aria-expanded:text-(--tg-accent) sm:size-10 [&_svg]:size-5');

  const emoji: ReactNode = (
    <div ref={emojiWrap} className="relative shrink-0 self-end">
      <button ref={emojiButton} type="button" className={side} title="Emoji" aria-label="Emoji" aria-haspopup="menu" aria-expanded={emojiOpen}
        onClick={() => setEmojiOpen((o) => !o)}>
        <Icon name="smile" className="size-4" />
      </button>
      {emojiOpen ? (
        <div ref={emojiPanel} role="menu" aria-label="Emoji" onKeyDown={onMenuKeyDown}
          className="tg-fade-in absolute bottom-full left-0 z-30 mb-3 max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl bg-(--tg-menu-solid) shadow-[0_6px_24px_rgb(0_0_0/0.2)]">
          <EmojiPicker onPick={(e) => { insert(e); setEmojiOpen(false); }} />
        </div>
      ) : null}
    </div>
  );

  const right: ReactNode = (
    <div className="flex shrink-0 items-center self-end">
      {length >= COUNTER_FROM ? (
        <span className={cn('mx-1 text-[12px] tabular-nums', length > MAX_LENGTH ? 'font-semibold text-(--tg-danger)' : 'text-(--tg-in-meta)')} aria-live="polite">
          {length > MAX_LENGTH ? `${(length - MAX_LENGTH).toLocaleString()} over` : `${(MAX_LENGTH - length).toLocaleString()} left`}
        </span>
      ) : null}
      <button type="button" className={cn(side, '[&_svg]:size-4.5')} title={expanded ? 'Hide formatting' : 'Format'} aria-label={expanded ? 'Hide formatting' : 'Show formatting'} aria-pressed={expanded}
        onMouseDown={(e) => e.preventDefault()} onClick={() => { setExpanded((x) => !x); editor?.commands.focus(); }}>
        <Icon name="format" className="size-4" />
      </button>
      <button type="button" className={cn(side, '[&_svg]:size-4.5')} title={attached.length >= MAX_ISSUES ? `Up to ${MAX_ISSUES} issues per message` : 'Share an issue (/)'} aria-label="Share an issue"
        disabled={attached.length >= MAX_ISSUES} onMouseDown={(e) => e.preventDefault()} onClick={() => insert('/', true)}>
        <Icon name="wrench" className="size-4" />
      </button>
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={submit} disabled={!sendable} aria-label={editing ? 'Save changes' : 'Send message'} title={`${editing ? 'Save' : 'Send'} (${expanded ? 'Ctrl+Enter' : 'Enter'})`}
        className="tg-fab tg-send ml-0.5 size-9 sm:size-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--tg-accent)">
        {editing ? <Icon name="check" className="size-5" /> : <SendIcon className="size-5" />}
      </button>
    </div>
  );

  return (
    <div className="relative mx-auto flex w-full max-w-185 items-end gap-2 px-2.5 pt-1.5 pb-[max(10px,env(safe-area-inset-bottom))] sm:gap-2.5 md:px-4 md:pb-[max(14px,env(safe-area-inset-bottom))]">
      {shown ? (
        <ul id={listId} role="listbox" aria-label={suggest.kind === 'mention' ? 'People in this project' : 'Issues in this project'}
          onScroll={(e) => { const el = e.currentTarget; if (suggest.kind === 'issue' && el.scrollHeight - el.scrollTop - el.clientHeight < ISSUE_LOAD_MORE_PX) loadMoreIssues(); }}
          className="tg-fade-in absolute right-18 bottom-full left-2 z-30 mb-1 max-h-80 max-w-xl list-none overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-2xl bg-(--tg-menu) p-1.5 text-(--tg-text) shadow-[0_6px_24px_rgb(0_0_0/0.2)] backdrop-blur-xl md:left-4">
          {(
            <li role="presentation" className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-1 flex items-center gap-2 rounded-t-2xl border-0 border-b border-solid border-(--tg-bar-line) bg-(--tg-menu-solid) px-3.5 py-2.5 text-[14px]">
              <Icon name="search" className="size-4 shrink-0 text-(--tg-in-meta)" />
              <input type="text" value={pickerText} onChange={(e) => setPickerText(e.target.value)} placeholder={suggest.kind === 'mention' ? 'Search people by name or email' : 'Search issues by type, message or id'} aria-label={suggest.kind === 'mention' ? 'Search people' : 'Search issues'} autoComplete="off" spellCheck={false}
                role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={options[index] ? `${listId}-${options[index].id}` : undefined}
                onKeyDown={(e) => { if (suggestKey.current(e.nativeEvent)) { e.preventDefault(); if (e.key === 'Escape') editor?.commands.focus(); } }}
                className="min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[14px] text-(--tg-text) shadow-none outline-none placeholder:text-(--tg-in-meta)" />
              <span className="shrink-0 text-[12px] text-(--tg-in-meta) tabular-nums" aria-live="polite">{suggest.kind === 'mention' ? (others.length > 0 ? `${options.length} of ${others.length}` : '') : picker.loading ? 'Searching…' : picker.total > 0 ? `${options.length} of ${picker.total.toLocaleString()}` : ''}</span>
            </li>
          )}
          {options.length === 0 && suggest.kind === 'issue' && picker.loading ? (
            Array.from({ length: ISSUE_SKELETON_ROWS }, (_, k) => (
              <li key={k} role="presentation" aria-hidden="true" className="flex items-center gap-3 px-2.5 py-1.5">
                <span className="size-8.5 shrink-0 animate-pulse rounded-full bg-(--tg-text)/10 motion-reduce:animate-none" />
                <span className="grid flex-1 gap-1.5"><span className="h-3 w-1/3 animate-pulse rounded-full bg-(--tg-text)/10 motion-reduce:animate-none" /><span className="h-2.5 w-2/3 animate-pulse rounded-full bg-(--tg-text)/10 motion-reduce:animate-none" /></span>
              </li>
            ))
          ) : options.length === 0 ? (
            <li className="px-2.5 py-2 text-[14px] text-(--tg-in-meta)" role="presentation">
              {suggest.kind === 'mention' ? (pickerText ? `Nobody matches “${pickerText}”.` : 'No one else is in this project yet.') : picker.failed ? 'Couldn’t load issues. Type again to retry.' : pickerText ? `No issues match “${pickerText}”.` : 'This project has no issues yet.'}
            </li>
          ) : null}
          {options.map((option, i) => (
            <li key={option.id} id={`${listId}-${option.id}`} role="option" aria-selected={i === index}
              onMouseDown={(e) => { e.preventDefault(); choose(option); }} onMouseEnter={() => setIndex(i)}
              className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-1.5 text-[14px]', i === index && 'bg-(--tg-menu-hover)')}>
              {'email' in option ? (
                <>
                  <ChatAvatar id={option.id} name={option.name} size={34} />
                  <span className="min-w-0"><b className="block truncate font-medium">{option.name}</b><span className="block truncate text-[13px] text-(--tg-in-meta)">{option.email}</span></span>
                </>
              ) : (
                <>
                  <span className={cn('grid size-8.5 shrink-0 place-items-center rounded-full', issueTile(option.eventType))} aria-hidden="true"><Icon name={issueIcon(option)} className="size-4" /></span>
                  <span className="min-w-0 flex-1"><b className="block truncate font-medium">{option.errorType}</b><span className="block truncate text-[13px] text-(--tg-in-meta)">{option.message || '(no message)'}</span></span>
                  <span className="shrink-0 text-[13px] text-(--tg-in-meta) tabular-nums">{option.count.toLocaleString()}</span>
                </>
              )}
            </li>
          ))}
          {suggest.kind === 'issue' && picker.loadingMore ? (
            <li role="presentation" className="px-2.5 py-2 text-[12px] text-(--tg-in-meta)">Loading more…</li>
          ) : null}
        </ul>
      ) : null}

      <div className="tg-input min-w-0 flex-1">
        {editing ? (
          <div className="tg-fade-in flex items-center gap-1 pt-1.5 pr-1 pl-1">
            <span className="grid size-10 shrink-0 place-items-center text-(--tg-accent)"><Icon name="pencil" className="size-5" /></span>
            <button type="button" onClick={() => document.getElementById(`m-${editing.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className="tg-quote m-0 flex-1 cursor-pointer" style={{ '--peer': 'var(--tg-accent)' } as CSSProperties} title="Show the message">
              <span className="truncate font-medium text-(--tg-accent)">Editing message</span>
              <span className="truncate font-normal opacity-90">{snippetOf(editing) || 'Message'}</span>
            </button>
            <button type="button" onClick={onCancelEdit} aria-label="Cancel editing" title="Cancel editing (Esc)" className={side}><Icon name="close" className="size-4" /></button>
          </div>
        ) : replyTo ? (
          <div className="tg-fade-in flex items-center gap-1 pt-1.5 pr-1 pl-1">
            <span className="grid size-10 shrink-0 place-items-center text-(--tg-accent)"><Icon name="reply" className="size-5.5" /></span>
            <button type="button" onClick={() => document.getElementById(`m-${replyTo.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
              className="tg-quote m-0 flex-1 cursor-pointer" style={{ '--peer': 'var(--tg-accent)' } as CSSProperties} title="Show the message">
              <span className="truncate font-medium text-(--tg-accent)">Reply to {replyTo.userId === me.id ? 'yourself' : (replyTo.userName ?? 'Deleted user')}</span>
              <span className="truncate font-normal opacity-90">{snippetOf(replyTo) || 'Message'}</span>
            </button>
            <button type="button" onClick={onCancelReply} aria-label="Cancel reply" title="Cancel reply (Esc)" className={side}><Icon name="close" className="size-4" /></button>
          </div>
        ) : null}

        {attached.length > 0 ? (
          <div className="grid gap-1.5 px-2.5 pt-2.5">
            {attached.map((issue) => <IssueCard key={issue.id} issue={issue} inBubble onRemove={() => setAttached((list) => list.filter((i) => i.id !== issue.id))} />)}
          </div>
        ) : null}

        {expanded ? (
          <div className="tg-fade-in mx-2 mt-1.5 flex flex-wrap items-center gap-0.5 border-0 border-b border-solid border-(--tg-bar-line) pb-1" role="toolbar" aria-label="Formatting">
            {TOOLBAR.map((item, i) => item === 'sep' ? <span key={`s${i}`} className="mx-1 h-5 w-px bg-(--tg-bar-line)" aria-hidden="true" /> : (
              <button key={item.id} type="button" className={cn(ICON_BUTTON, 'rounded-full')} title={item.keys ? `${item.label} (${item.keys})` : item.label} aria-label={item.label}
                aria-pressed={Boolean(active?.[item.id])} disabled={!editor} onMouseDown={(e) => e.preventDefault()} onClick={() => editor && item.run(editor)}>
                <Icon name={item.icon} className="size-4" />
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-(--tg-bar-line)" aria-hidden="true" />
            <button type="button" className={cn(ICON_BUTTON, 'rounded-full')} title="Mention someone (@)" aria-label="Mention someone" onMouseDown={(e) => e.preventDefault()} onClick={() => insert('@', true)}>
              <Icon name="at" className="size-4" />
            </button>
            <button type="button" className={cn(ICON_BUTTON, 'rounded-full')} title="Clear formatting" aria-label="Clear formatting" onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}>
              <Icon name="clearFormat" className="size-4" />
            </button>
            <span id={`${listId}-hint`} className="ml-auto truncate pr-1 text-[11px] text-(--tg-in-meta) max-sm:hidden"><kbd className="font-sans font-semibold">Enter</kbd> new line · <kbd className="font-sans font-semibold">Ctrl+Enter</kbd> send</span>
          </div>
        ) : null}

        <div className="flex items-end gap-0.5 px-1 py-1 sm:px-1.5">
          {emoji}
          <div className={cn('min-w-0 flex-1 cursor-text overflow-y-auto px-1 py-1.5 sm:py-2', expanded ? 'max-h-[min(360px,45vh)] min-h-24' : 'max-h-[min(260px,38vh)]')}
            onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); editor?.commands.focus('end'); } }}>
            {editor ? <EditorContent editor={editor} /> : <div className="text-[16px] leading-6 text-(--tg-in-meta)">{placeholder.current}</div>}
          </div>
          {right}
        </div>
      </div>

      {!expanded ? <span id={`${listId}-hint`} className="sr-only">Enter to send, Shift+Enter for a new line. Type @ to mention someone and / to share an issue.</span> : null}
    </div>
  );
}
