/**
 * Pure helpers for the project chat (no React, no DOM), so they can be unit-tested with `node --test`:
 * the small Markdown subset messages are written in, how messages group, and turning the composer's
 * document (Tiptap JSON) into that Markdown.
 *
 * Supported formatting (deliberately small, Slack-like): ```code blocks```, `inline code`, **bold**,
 * *italic* / _italic_, ~~strike~~, "> " quotes, "- " / "1. " lists, bare http(s) links and @mentions. There is no
 * [text](url) syntax on purpose: the visible text of a link must be the address it opens (phishing).
 */

/** A run of consecutive messages from one person shows one header; a pause longer than this starts a new one. */
export const GROUP_GAP_MS = 5 * 60_000;
/** Deepest nesting of bold / italic / strike that is still parsed (deeper markers stay as text). */
const MAX_INLINE_DEPTH = 3;
/** Longest language tag accepted after an opening ``` fence. */
const MAX_LANG_LENGTH = 20;

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; url: string }
  | { kind: 'mention'; text: string; name: string }
  | { kind: 'bold' | 'italic' | 'strike'; children: Inline[] };

/** One line of a bulleted ("- ") or numbered ("1. ") list; `level` = nesting from the indentation (2 spaces each). */
export interface ListItem { ordered: boolean; number: number; level: number; text: string }

export type Block =
  | { kind: 'para'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'code'; lang: string | null; text: string };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FENCE = new RegExp(`\`\`\`(?:([\\w+#.-]{1,${MAX_LANG_LENGTH}})?\\n)?([\\s\\S]*?)\\n?\`\`\``, 'g');
const LIST_LINE = /^( *)(?:([-*•])|(\d{1,4})[.)]) +(\S.*)$/;
/** Deepest list nesting shown (deeper items are drawn at this level). */
const MAX_LIST_LEVEL = 4;

/** Splits a message into code blocks, quotes, lists and plain paragraphs (paragraph text keeps its line breaks). */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const pushProse = (prose: string) => {
    if (!prose) return;
    // Consecutive lines of the same kind ("> " quote, "- " / "1. " list, other) become one block.
    const lines = prose.split('\n');
    let buffer: string[] = [];
    let items: ListItem[] = [];
    let kind: 'para' | 'quote' | 'list' = 'para';
    const flush = () => {
      if (kind === 'list') { if (items.length > 0) blocks.push({ kind: 'list', items }); items = []; return; }
      if (buffer.length === 0) return;
      const joined = buffer.join('\n');
      if (kind === 'quote') blocks.push({ kind: 'quote', text: joined });
      else if (joined.trim()) blocks.push({ kind: 'para', text: joined.replace(/^\n+|\n+$/g, '') });
      buffer = [];
    };
    for (const line of lines) {
      const quote = /^>\s?(.*)$/.exec(line);
      const list = quote ? null : LIST_LINE.exec(line);
      const next = quote ? 'quote' : list ? 'list' : 'para';
      if (next !== kind) { flush(); kind = next; }
      if (list) items.push({ ordered: !list[2], number: list[3] ? Number(list[3]) : 0, level: Math.min(MAX_LIST_LEVEL, Math.floor(list[1].length / 2)), text: list[4] });
      else buffer.push(quote ? quote[1] : line);
    }
    flush();
  };
  let last = 0;
  FENCE.lastIndex = 0;
  for (let m = FENCE.exec(text); m; m = FENCE.exec(text)) {
    if (!m[2].trim()) continue; // "``````" is just text
    pushProse(text.slice(last, m.index));
    blocks.push({ kind: 'code', lang: m[1] ?? null, text: m[2] });
    last = m.index + m[0].length;
  }
  pushProse(text.slice(last));
  return blocks;
}

/** Characters that end a sentence rather than a URL. */
const URL_TRAILING = /[.,;:!?'"\]>*_~]+$/;

/** A bare URL without the punctuation that follows it in a sentence; a closing ")" stays only when the URL opened one. */
function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const before = out;
    out = out.replace(URL_TRAILING, '');
    if (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) out = out.slice(0, -1);
    if (out === before) return out;
  }
}

/**
 * Inline formatting of one paragraph. `names` are the people who may be @mentioned (longest names win, so
 * "@Ann Lee" beats "@Ann"). snake_case words and 2*3*4 are left alone: markers must sit at word edges.
 */
export function parseInline(text: string, names: readonly string[] = [], depth = 0): Inline[] {
  const sorted = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  const mention = sorted.length > 0 ? `(@(?:${sorted.map(escapeRegex).join('|')}))(?![\\w])` : '(?!)()';
  const pattern = new RegExp([
    '`([^`\\n]+)`', // 1 inline code
    '(https?:\\/\\/[^\\s<>"`]+)', // 2 url
    mention, // 3 mention
    '\\*\\*(?=\\S)([^\\n]+?)(?<=\\S)\\*\\*', // 4 bold
    '~~(?=\\S)([^\\n]+?)(?<=\\S)~~', // 5 strike
    '(?<![\\w*])\\*(?=[^\\s*])([^\\n*]+?)(?<=\\S)\\*(?![\\w*])', // 6 italic *
    '(?<![A-Za-z0-9_])_(?=[^\\s_])([^\\n_]+?)(?<=\\S)_(?![A-Za-z0-9_])', // 7 italic _
  ].join('|'), 'g');

  const out: Inline[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += value; else out.push({ kind: 'text', text: value });
  };
  const nested = (inner: string) => (depth + 1 >= MAX_INLINE_DEPTH ? [{ kind: 'text', text: inner } as Inline] : parseInline(inner, sorted, depth + 1));

  let last = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    let length = m[0].length;
    if (m[1] !== undefined) {
      pushText(text.slice(last, m.index));
      out.push({ kind: 'code', text: m[1] });
    } else if (m[2] !== undefined) {
      const url = trimUrl(m[2]);
      if (!/^https?:\/\/[^/?#\s]+/.test(url)) continue; // "http://" alone
      pushText(text.slice(last, m.index));
      out.push({ kind: 'link', url });
      length = url.length;
      pattern.lastIndex = m.index + length;
    } else if (m[3] !== undefined) {
      pushText(text.slice(last, m.index));
      out.push({ kind: 'mention', text: m[3], name: m[3].slice(1) });
    } else {
      const kind = m[4] !== undefined ? 'bold' : m[5] !== undefined ? 'strike' : 'italic';
      pushText(text.slice(last, m.index));
      out.push({ kind, children: nested(m[4] ?? m[5] ?? m[6] ?? m[7]) });
    }
    last = m.index + length;
  }
  pushText(text.slice(last));
  return out;
}

/** The message as plain text for previews, quotes and search: formatting markers removed. */
export function plainText(text: string): string {
  return text
    .replace(/```(?:[\w+#.-]{1,20}\n)?([\s\S]*?)```/g, '$1')
    // A quote cut short (reply snippets are truncated) can leave an unclosed fence.
    .replace(/```(?:[\w+#.-]{1,20}(?=\n))?/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, '$1')
    .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, '$1')
    .replace(/(?<![\w*])\*(?=[^\s*])([^\n*]+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![A-Za-z0-9_])_(?=[^\s_])([^\n_]+?)(?<=\S)_(?![A-Za-z0-9_])/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^ *(?:[-*•]|\d{1,4}[.)]) +/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Local calendar day of an ISO time, for day separators and grouping. */
export const dayKey = (iso: string) => new Date(iso).toDateString();

/** Whether `current` starts a new visual group (header with avatar and name) after `previous`. */
export function startsGroup(previous: { userId: string; createdAt: string } | null, current: { userId: string; createdAt: string }): boolean {
  if (!previous || previous.userId !== current.userId) return true;
  if (dayKey(previous.createdAt) !== dayKey(current.createdAt)) return true;
  return new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime() > GROUP_GAP_MS;
}

/** The parts of the editor's JSON document (ProseMirror / Tiptap `getJSON()`) the serializer reads. */
export interface DocNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: DocNode[];
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** One text run with its marks, as Markdown. Whitespace stays outside the markers (`**a **` would not parse). */
function markText(text: string, marks: DocNode['marks'] = []): string {
  const has = (type: string) => marks.some((m) => m.type === type);
  if (has('code')) return `\`${text.replace(/`/g, 'ʼ')}\``;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? ['', '', text, ''];
  if (!core) return text;
  let out = core;
  const href = str(marks.find((m) => m.type === 'link')?.attrs?.href);
  // Links are sent as their address: a different visible text is kept, with the address after it in brackets.
  if (/^https?:\/\//i.test(href) && href !== core) out = `${core} (${href})`;
  if (has('strike')) out = `~~${out}~~`;
  if (has('italic')) out = `_${out}_`;
  if (has('bold')) out = `**${out}**`;
  return lead + out + trail;
}

/**
 * Turns the composer's document into the message format (the Markdown subset above) and the ids of the
 * people mentioned in it. Anything the chat can't show (images, tables, headings from a paste…) is
 * reduced to its text.
 */
export function docToMarkdown(doc: DocNode): { text: string; mentions: string[] } {
  const mentions: string[] = [];
  const inline = (nodes: DocNode[] = []): string => nodes.map((n) => {
    if (n.type === 'text') return markText(n.text ?? '', n.marks);
    if (n.type === 'hardBreak') return '\n';
    if (n.type === 'mention') {
      const id = str(n.attrs?.id);
      if (id && !mentions.includes(id)) mentions.push(id);
      return `@${str(n.attrs?.label) || str(n.attrs?.id)}`;
    }
    return inline(n.content);
  }).join('');

  const blocks = (nodes: DocNode[] = [], indent = ''): string[] => nodes.flatMap((n): string[] => {
    switch (n.type) {
      case 'paragraph': case 'heading': return [indent + inline(n.content).replace(/\n/g, `\n${indent}`)];
      case 'codeBlock': {
        const lang = str(n.attrs?.language).replace(/[^\w+#.-]/g, '').slice(0, MAX_LANG_LENGTH);
        return [`${indent}\`\`\`${lang}\n${(n.content ?? []).map((c) => c.text ?? '').join('')}\n${indent}\`\`\``];
      }
      case 'blockquote': return blocks(n.content).join('\n').split('\n').map((line) => `${indent}> ${line}`);
      case 'bulletList': case 'orderedList': {
        const start = typeof n.attrs?.start === 'number' ? n.attrs.start : 1;
        return (n.content ?? []).flatMap((item, i) => {
          const marker = n.type === 'orderedList' ? `${start + i}. ` : '- ';
          const [first, ...rest] = item.content ?? [];
          const head = first && (first.type === 'paragraph' || first.type === 'heading') ? inline(first.content).replace(/\n/g, ' ') : '';
          const tail = first && !(first.type === 'paragraph' || first.type === 'heading') ? [first, ...rest] : rest;
          return [`${indent}${marker}${head}`, ...blocks(tail, `${indent}  `)];
        });
      }
      case 'horizontalRule': return [`${indent}---`];
      default: return n.content ? blocks(n.content, indent) : n.text ? [indent + n.text] : [];
    }
  });

  const text = blocks(doc.content).join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return { text, mentions };
}


/** A person who can be mentioned: `markdownToDoc` turns "@name" of these into mention chips. */
export interface MentionTarget { id: string; name: string }

/**
 * The reverse of `docToMarkdown`: a message's text as the composer's document, so an existing message can be
 * opened in the box for editing. Formatting the chat can show becomes the same marks and nodes the box
 * produces; "@name" of a known person becomes a mention chip (anything else stays text).
 */
export function markdownToDoc(text: string, people: readonly MentionTarget[] = []): DocNode {
  const byName = new Map(people.map((p) => [p.name, p.id]));
  const names = [...byName.keys()];
  type Marks = NonNullable<DocNode['marks']>;

  /** Text runs with a hard break for each line break (an empty text node is not allowed). */
  const runs = (value: string, marks: Marks): DocNode[] => value.split('\n').flatMap((line, i): DocNode[] => {
    const run: DocNode[] = line ? [{ type: 'text', text: line, ...(marks.length ? { marks } : {}) }] : [];
    return i === 0 ? run : [{ type: 'hardBreak' }, ...run];
  });
  const inline = (parts: Inline[], marks: Marks = []): DocNode[] => parts.flatMap((part): DocNode[] => {
    switch (part.kind) {
      case 'text': return runs(part.text, marks);
      case 'code': return [{ type: 'text', text: part.text, marks: [{ type: 'code' }] }]; // code excludes other marks
      case 'link': return [{ type: 'text', text: part.url, marks: [...marks, { type: 'link', attrs: { href: part.url } }] }];
      case 'mention': {
        const id = byName.get(part.name);
        return id ? [{ type: 'mention', attrs: { id, label: part.name } }] : runs(part.text, marks);
      }
      default: return inline(part.children, [...marks, { type: part.kind }]);
    }
  });
  const paragraph = (value: string): DocNode => {
    const content = inline(parseInline(value, names));
    return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
  };

  const list = (items: ListItem[]): DocNode[] => {
    // A nested item can only sit one level below the item before it.
    const flat = items.map((item, i) => ({ ...item, level: i === 0 ? 0 : item.level }));
    for (let i = 1; i < flat.length; i++) flat[i].level = Math.min(flat[i].level, flat[i - 1].level + 1);
    let i = 0;
    const level = (depth: number): DocNode[] => {
      const lists: DocNode[] = [];
      while (i < flat.length && flat[i].level === depth) {
        const { ordered, number } = flat[i];
        const listItems: DocNode[] = [];
        while (i < flat.length && flat[i].level === depth && flat[i].ordered === ordered) {
          const item = flat[i++];
          const content: DocNode[] = [paragraph(item.text)];
          if (i < flat.length && flat[i].level > depth) content.push(...level(depth + 1));
          listItems.push({ type: 'listItem', content });
        }
        lists.push(ordered ? { type: 'orderedList', attrs: { start: number || 1 }, content: listItems } : { type: 'bulletList', content: listItems });
      }
      return lists;
    };
    return level(0);
  };

  const content = parseBlocks(text).flatMap((block): DocNode[] => {
    switch (block.kind) {
      case 'quote': return [{ type: 'blockquote', content: [paragraph(block.text)] }];
      case 'code': return [{ type: 'codeBlock', attrs: { language: block.lang }, ...(block.text ? { content: [{ type: 'text', text: block.text }] } : {}) }];
      case 'list': return list(block.items);
      default: return [paragraph(block.text)];
    }
  });
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
}
