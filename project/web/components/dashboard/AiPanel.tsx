'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, isToolUIPart, type UIMessage } from 'ai';
import { useEffect, useMemo, useRef } from 'react';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools, type PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool';
import { Icon } from '../ui/Icon';
import { ResizeHandle, usePanelWidth } from '../ui/ResizeHandle';

const WIDTH_KEY = 'et_ai_panel_width';
/** Panel width in px: default and smallest; the widest leaves AI_PANEL_PAGE_ROOM for the page. */
const AI_PANEL_WIDTH = 440;
const AI_PANEL_MIN_WIDTH = 320;
const AI_PANEL_MAX_WIDTH = 960;
const AI_PANEL_PAGE_ROOM = 560;
const aiPanelMaxWidth = () => Math.min(AI_PANEL_MAX_WIDTH, window.innerWidth - AI_PANEL_PAGE_ROOM);

const SUGGESTIONS = [
  'Why did this happen?',
  'Where should I look in the code?',
  'How can I fix it?',
  'Walk me through the last moments before the error',
  'Does it happen on every screen, browser and version?',
];

/** Labels for the assistant's tool steps. */
const TOOL_TITLES: Record<string, string> = {
  list_events: "Listed this issue's events",
  get_event: 'Opened an event',
};

/** The text of a failed request: the API's `{ error: { message } }` when there is one. */
function errorText(error: Error): string {
  try {
    const body = JSON.parse(error.message) as { error?: { message?: unknown } };
    if (body.error && typeof body.error.message === 'string') return body.error.message;
  } catch {
    // Not JSON: a stream error, already a readable sentence.
  }
  return error.message || 'Something went wrong. Try again.';
}

/** One message: text as Markdown, reasoning and tool steps folded. */
function ChatMessage({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  const lastIndex = message.parts.length - 1;
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => {
          const key = `${message.id}-${i}`;
          if (part.type === 'text') {
            return message.role === 'user'
              ? <p key={key} className="whitespace-pre-wrap">{part.text}</p>
              : <MessageResponse key={key}>{part.text}</MessageResponse>;
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

/**
 * The "Ask AI" side panel on the issue page. It knows the issue and the event
 * on screen (the server loads them; `eventId` follows the selection), can open
 * the issue's other events itself, and keeps the chat only while the page is open.
 */
export function AiPanel({ issueId, eventId, open, onClose }: { issueId: string; eventId: string | null; open: boolean; onClose: () => void }) {
  // Read when a question is sent, so each question goes with the event selected at that moment.
  const eventRef = useRef(eventId);
  useEffect(() => { eventRef.current = eventId; }, [eventId]);

  const transport = useMemo(() => new DefaultChatTransport({
    api: '/api/ai/chat',
    body: () => ({ issueId, eventId: eventRef.current }),
  }), [issueId]);
  const { messages, sendMessage, status, stop, error, setMessages, clearError } = useChat({ transport });
  const panel = usePanelWidth(WIDTH_KEY, AI_PANEL_WIDTH, AI_PANEL_MIN_WIDTH, aiPanelMaxWidth);
  // On <html>, so the page next to the panel (.content) can make room for it.
  useEffect(() => {
    document.documentElement.style.setProperty('--ai-panel-w', `${panel.width}px`);
    return () => { document.documentElement.style.removeProperty('--ai-panel-w'); };
  }, [panel.width]);
  const busy = status === 'submitted' || status === 'streaming';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const ask = (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    clearError();
    void sendMessage({ text: question });
  };

  const newChat = () => {
    void stop();
    clearError();
    setMessages([]);
  };

  return (
    <aside className="ai-panel" data-open={open ? '' : undefined} hidden={!open} aria-label="AI assistant">
      <ResizeHandle panel={panel} edge="left" label="Resize AI panel" />
      <div className="ai-panel-head">
        <Icon name="ghost" />
        <b>Ask AI</b>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={newChat} disabled={messages.length === 0 && !error} title="Start a new chat">
          <Icon name="plus" /><span>New chat</span>
        </button>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the AI panel" title="Close (Esc)">
          <Icon name="close" />
        </button>
      </div>

      <Conversation className="ai-panel-chat">
        <ConversationContent className="gap-5 px-4">
          {messages.length === 0 ? (
            <ConversationEmptyState
              className="ai-empty"
              icon={<Icon name="ghost" />}
              title="Ask about this issue"
              description="The assistant sees this issue, the event on screen and the issue's other events. Chats aren't saved."
            />
          ) : (
            messages.map((m, i) => <ChatMessage key={m.id} message={m} streaming={status === 'streaming' && i === messages.length - 1} />)
          )}
          {status === 'submitted' ? <div className="ai-thinking muted small">Thinking…</div> : null}
          {error ? <div className="ai-error" role="alert">{errorText(error)}</div> : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="ai-panel-input">
        {messages.length === 0 ? (
          <Suggestions className="pb-2">
            {SUGGESTIONS.map((s) => <Suggestion key={s} suggestion={s} onClick={ask} />)}
          </Suggestions>
        ) : null}
        <PromptInput onSubmit={(message: PromptInputMessage) => ask(message.text)}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask about this error…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="muted small">Enter to send · Shift+Enter for a new line</span>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={() => void stop()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </aside>
  );
}
