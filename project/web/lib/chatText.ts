/**
 * Pure helpers for the project chat (no React, no DOM), so they can be unit-tested with `node --test`:
 * the small Markdown subset messages are written in, how messages group, and the composer's text edits.
 *
 * Supported formatting (deliberately small, Slack-like): ```code blocks```, `inline code`, **bold**,
 * *italic* / _italic_, ~~strike~~, "> " quotes, bare http(s) links and @mentions. There is no
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

export type Block =
  | { kind: 'para'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; lang: string | null; text: string };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const FENCE = new RegExp(`\`\`\`(?:([\\w+#.-]{1,${MAX_LANG_LENGTH}})?\\n)?([\\s\\S]*?)\\n?\`\`\``, 'g');

/** Splits a message into code blocks, quotes and plain paragraphs (paragraph text keeps its line breaks). */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const pushProse = (prose: string) => {
    if (!prose) return;
    // Consecutive "> " lines become one quote; everything else stays a paragraph.
    const lines = prose.split('\n');
    let buffer: string[] = [];
    let quoting = false;
    const flush = () => {
      if (buffer.length === 0) return;
      const joined = buffer.join('\n');
      if (quoting) blocks.push({ kind: 'quote', text: joined });
      else if (joined.trim()) blocks.push({ kind: 'para', text: joined.replace(/^\n+|\n+$/g, '') });
      buffer = [];
    };
    for (const line of lines) {
      const quote = /^>\s?(.*)$/.exec(line);
      if (Boolean(quote) !== quoting) { flush(); quoting = Boolean(quote); }
      buffer.push(quote ? quote[1] : line);
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

/** Whether the caret sits inside an unclosed ``` block (then Enter adds a line instead of sending). */
export function insideCodeFence(text: string, caret: number): boolean {
  return ((text.slice(0, caret).match(/```/g)?.length ?? 0) % 2) === 1;
}

export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'codeblock' | 'quote';
const MARKERS: Record<Exclude<Format, 'codeblock' | 'quote'>, string> = { bold: '**', italic: '_', strike: '~~', code: '`' };

/**
 * Applies a formatting button to the selection [start, end): wraps it (or removes the markers when it is
 * already wrapped), or with no selection inserts an empty pair with the caret in between. Returns the new
 * text and selection.
 */
export function applyFormat(text: string, start: number, end: number, format: Format): { text: string; start: number; end: number } {
  const selected = text.slice(start, end);
  if (format === 'codeblock') {
    const before = start > 0 && text[start - 1] !== '\n' ? '\n' : '';
    const open = `${before}\`\`\`\n`;
    const close = '\n```';
    const after = end < text.length && text[end] !== '\n' ? '\n' : '';
    return { text: text.slice(0, start) + open + selected + close + after + text.slice(end), start: start + open.length, end: start + open.length + selected.length };
  }
  if (format === 'quote') {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const block = text.slice(lineStart, end);
    const quoted = block.split('\n').map((l) => `> ${l}`).join('\n');
    const added = quoted.length - block.length;
    return { text: text.slice(0, lineStart) + quoted + text.slice(end), start: start + 2, end: end + added };
  }
  const marker = MARKERS[format];
  const n = marker.length;
  // Already wrapped (markers just outside the selection): unwrap.
  if (start >= n && text.slice(start - n, start) === marker && text.slice(end, end + n) === marker) {
    return { text: text.slice(0, start - n) + selected + text.slice(end + n), start: start - n, end: end - n };
  }
  return { text: text.slice(0, start) + marker + selected + marker + text.slice(end), start: start + n, end: end + n };
}
