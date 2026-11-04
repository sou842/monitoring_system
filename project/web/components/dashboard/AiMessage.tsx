'use client';

import { isToolUIPart, type UIMessage } from 'ai';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';

/** Labels for the assistants' tool steps (issue panel and Assistant page). */
const TOOL_TITLES: Record<string, string> = {
  list_events: "Listed this issue's events",
  get_event: 'Opened an event',
  list_projects: 'Listed projects',
  get_overview: 'Read error activity',
  search_issues: 'Searched issues',
  get_issue: 'Opened an issue',
  list_issue_events: "Listed an issue's events",
  get_performance: 'Read performance',
  get_performance_detail: 'Opened a performance detail',
  list_members: 'Listed members',
};

/** Dashboard links (relative paths) open without streamdown's "open external link?" dialog. */
const LINK_SAFETY = { enabled: true, onLinkCheck: (url: string) => (url.startsWith('/') && !url.startsWith('//')) || url.startsWith('./') };

/** The text of a failed request: the API's `{ error: { message } }` when there is one. */
export function errorText(error: Error): string {
  try {
    const body = JSON.parse(error.message) as { error?: { message?: unknown } };
    if (body.error && typeof body.error.message === 'string') return body.error.message;
  } catch {
    // Not JSON: a stream error, already a readable sentence.
  }
  return error.message || 'Something went wrong. Try again.';
}

/** One message: text as Markdown, reasoning and tool steps folded. */
export function ChatMessage({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  const lastIndex = message.parts.length - 1;
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => {
          const key = `${message.id}-${i}`;
          if (part.type === 'text') {
            return message.role === 'user'
              ? <p key={key} className="whitespace-pre-wrap">{part.text}</p>
              : <MessageResponse key={key} linkSafety={LINK_SAFETY}>{part.text}</MessageResponse>;
          }
          if (part.type === 'reasoning') {
            return (
              <Reasoning key={key} className="w-full" isStreaming={streaming && i === lastIndex}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          if (isToolUIPart(part)) {
            const name = part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length);
            return (
              <Tool key={key}>
                {part.type === 'dynamic-tool'
                  ? <ToolHeader type={part.type} state={part.state} toolName={part.toolName} title={TOOL_TITLES[name] ?? name} />
                  : <ToolHeader type={part.type} state={part.state} title={TOOL_TITLES[name] ?? name} />}
                <ToolContent>
                  <ToolInput input={part.input} />
                  <ToolOutput output={part.state === 'output-available' ? part.output : undefined} errorText={part.state === 'output-error' ? part.errorText : undefined} />
                </ToolContent>
              </Tool>
            );
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
}
