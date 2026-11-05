'use client';

import Link from 'next/link';
import { Fragment, memo, useState, type ReactNode } from 'react';
import { parseBlocks, parseInline, type Inline } from '@/lib/chatText';
import { cn } from '@/lib/utils';
import { Icon } from '../../ui/Icon';
import { withEmoji } from './shared';

/** A link to this dashboard (opened in place) or to somewhere else (new tab, no referrer, no opener). */
function MessageLink({ url }: { url: string }) {
  const className = 'font-medium text-(--mention-fg) underline decoration-(--mention-fg)/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-(--mention-fg)';
  let internal: string | null = null;
  try {
    const parsed = new URL(url);
    if (typeof window !== 'undefined' && parsed.origin === window.location.origin) internal = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { /* shown as typed */ }
  if (internal) return <Link href={internal} className={className}>{url}</Link>;
  return <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={className} title={`${url} (opens in a new tab)`}>{url}</a>;
}

function renderInline(nodes: Inline[], myName: string | null, keyPrefix = ''): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`;
    switch (node.kind) {
      case 'text': return <Fragment key={key}>{withEmoji(node.text, key)}</Fragment>;
      case 'code': return <code key={key} className="rounded-md border border-line bg-(--chip) px-1 py-px font-mono text-[0.86em] text-fg">{node.text}</code>;
      case 'link': return <MessageLink key={key} url={node.url} />;
      case 'mention': {
        const me = myName !== null && node.name === myName;
        return <span key={key} className={cn('rounded px-0.5 font-medium', me ? 'bg-(--mention-me-line)/20 text-fg' : 'bg-(--mention-bg) text-(--mention-fg)')}>{node.text}</span>;
      }
      case 'bold': return <strong key={key} className="font-semibold text-fg">{renderInline(node.children, myName, `${key}.`)}</strong>;
      case 'italic': return <em key={key}>{renderInline(node.children, myName, `${key}.`)}</em>;
      case 'strike': return <s key={key} className="text-muted">{renderInline(node.children, myName, `${key}.`)}</s>;
      default: return null;
    }
  });
}

/** A fenced code block: monospace, scrolls sideways instead of wrapping, with a copy button. */
function CodeBlock({ lang, text }: { lang: string | null; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative my-1 max-w-full overflow-hidden rounded-lg border border-line bg-panel-2">
      <div className="flex h-7 items-center justify-between border-b border-line px-3 text-[11px] text-muted">
        <span className="font-mono">{lang ?? 'code'}</span>
        <button type="button"
          onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {}); }}
          className="inline-flex cursor-pointer items-center gap-1 rounded border-0 bg-transparent p-0 text-[11px] text-muted shadow-none hover:text-fg focus-visible:outline-2 focus-visible:outline-(--mention)"
          aria-label={copied ? 'Copied' : 'Copy code'}>
          <Icon name={copied ? 'check' : 'copy'} className="size-3" />{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="m-0 max-h-96 overflow-auto p-3 font-mono text-[12.5px] leading-5 whitespace-pre text-fg" tabIndex={0} aria-label={`${lang ?? 'Code'} snippet`}><code>{text}</code></pre>
    </div>
  );
}

/**
 * The text of a message with its formatting (see lib/chatText.ts). Rendered as React elements only, never
 * as HTML, so nothing a sender types can run or style the page. `dir="auto"` lets right-to-left text
 * (Arabic, Hebrew) read correctly.
 */
export const MessageBody = memo(function MessageBody({ text, names, myName, trailing, bubble }: {
  text: string; names: readonly string[]; myName: string | null;
  /** Inline content put at the end of the last line (a bubble's time); on its own line after a code block. */
  trailing?: ReactNode;
  /** Inside a chat bubble: bubble text size, colour from the bubble. */
  bubble?: boolean;
}) {
  const blocks = parseBlocks(text);
  const lastIndex = blocks.length - 1;
  const endsInline = lastIndex >= 0 && blocks[lastIndex].kind !== 'code';
  return (
    <div className={cn('min-w-0 [overflow-wrap:anywhere]', bubble ? 'text-[15px] leading-[21px]' : 'text-[14px] leading-[22px] text-fg')}>
      {blocks.map((block, i) => {
        const tail = i === lastIndex && endsInline ? trailing : null;
        if (block.kind === 'code') return <CodeBlock key={i} lang={block.lang} text={block.text} />;
        if (block.kind === 'list') {
          // One flat list with indentation per level: simple to read, and screen readers still hear a list of N items.
          return (
            <ul key={i} className="my-0.5 list-none p-0" dir="auto">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2" style={{ paddingInlineStart: `${item.level * 20}px` }}>
                  <span className="min-w-4 shrink-0 text-right text-fg-2 tabular-nums select-none" aria-hidden="true">{item.ordered ? `${item.number}.` : item.level % 2 === 0 ? '•' : '◦'}</span>
                  <span className="min-w-0">{renderInline(parseInline(item.text, names), myName)}{j === block.items.length - 1 ? tail : null}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'quote') {
          return <blockquote key={i} dir="auto" className="my-1 border-0 border-l-[3px] border-solid border-line-strong py-0.5 pl-3 whitespace-pre-wrap text-fg-2">{renderInline(parseInline(block.text, names), myName)}{tail}</blockquote>;
        }
        return <p key={i} dir="auto" className="m-0 whitespace-pre-wrap">{renderInline(parseInline(block.text, names), myName)}{tail}</p>;
      })}
      {trailing && !endsInline ? <div className="text-right leading-[14px]">{trailing}</div> : null}
    </div>
  );
});
