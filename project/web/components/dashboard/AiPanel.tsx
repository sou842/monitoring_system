'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools, type PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { AI_CHAT_MAX_AGE_DAYS, AI_CHATS_PER_USER, chatSignature, deleteChat, loadChat, saveChat } from '@/lib/client/aiChats';
import { Icon } from '../ui/Icon';
import { ResizeHandle, usePanelWidth } from '../ui/ResizeHandle';
import { ChatMessage, errorText } from './AiMessage';
import { useSession } from './Shell';

const WIDTH_KEY = 'et_ai_panel_width';
/** Panel width in px: default and smallest; the widest leaves AI_PANEL_PAGE_ROOM for the page. */
const AI_PANEL_WIDTH = 440;
const AI_PANEL_MIN_WIDTH = 320;
const AI_PANEL_MAX_WIDTH = 960;
const AI_PANEL_PAGE_ROOM = 560;
const aiPanelMaxWidth = () => Math.min(AI_PANEL_MAX_WIDTH, window.innerWidth - AI_PANEL_PAGE_ROOM);

const SUGGESTIONS = [
  'How can I fix it?',
  'Why did this happen?',
  'Where should I look in the code?',
  'Is this a valid error or a false positive?',
  'Walk me through the last moments before the error',
  'Does it happen on every screen, browser and version?',
  'How would you rate this issue: Low, Medium, or High?'
];

/**
 * The "Ask AI" side panel on the issue page. It knows the issue and the event
 * on screen (the server loads them; `eventId` follows the selection), can open
 * the issue's other events itself. The chat is saved in this browser's
 * IndexedDB (lib/client/aiChats.ts) and restored when the panel opens again.
 */
export function AiPanel({ issueId, eventId, open, onClose }: { issueId: string; eventId: string | null; open: boolean; onClose: () => void }) {
  const { user, rightSlot } = useSession();
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

  // Restore the saved chat once; a question asked before it loads wins over it.
  const [restored, setRestored] = useState(false);
  /** Signature of what is stored, so unchanged chats (just restored) aren't saved again. */
  const savedSignature = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    let cancelled = false;
    void loadChat(user.id, issueId).then((saved) => {
      if (cancelled) return;
      if (saved && saved.length > 0 && messagesRef.current.length === 0) {
        savedSignature.current = chatSignature(saved);
        setMessages(saved);
      }
      setRestored(true);
    });
    return () => { cancelled = true; };
  }, [user.id, issueId, setMessages]);

  // Save after each finished (or stopped / failed) answer, never mid-stream.
  useEffect(() => {
    if (!restored || busy || messages.length === 0) return;
    const signature = chatSignature(messages);
    if (signature === savedSignature.current) return;
    savedSignature.current = signature;
    void saveChat(user.id, issueId, messages);
  }, [restored, busy, messages, user.id, issueId]);

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
    savedSignature.current = null;
    void deleteChat(user.id, issueId);
  };

  // The panel docks into the frame's right slot (next to the page), not over it.
  if (rightSlot === null) return null;
  return createPortal(
    <aside className="ai-panel" data-open={open ? '' : undefined} hidden={!open} aria-label="AI assistant">
      <ResizeHandle panel={panel} edge="left" label="Resize AI panel" />
      <div className="ai-panel-head">
        <Icon name="ghost" />
        <b>Ask AI</b>
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={newChat} disabled={messages.length === 0 && !error} title="Start a new chat">
          <Icon name="plus" /><span>New chat</span>
        </button>
        <button type="button" className="icon-btn w-9.5 h-9.5" onClick={onClose} aria-label="Close the AI panel" title="Close (Esc)">
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
              description={`The assistant sees this issue, the event on screen and the issue's other events. Chats are saved in this browser only (your ${AI_CHATS_PER_USER} most recent, for ${AI_CHAT_MAX_AGE_DAYS} days).`}
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
              <span className="muted small">Press Enter to send</span>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={() => void stop()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </aside>,
    rightSlot,
  );
}
