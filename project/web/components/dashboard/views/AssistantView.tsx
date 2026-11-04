'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { nanoid } from 'nanoid';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools, type PromptInputMessage } from '@/components/ai-elements/prompt-input';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { AI_CHAT_MAX_AGE_DAYS, AI_CHATS_PER_USER, assistantChatKey, chatSignature, deleteChat, listAssistantChats, loadChat, saveChat, type AssistantChatInfo } from '@/lib/client/aiChats';
import { timeAgo } from '@/lib/format';
import { Icon } from '../../ui/Icon';
import { Menu } from '../../ui/Menu';
import { pillButton } from '../../ui/kit';
import { ChatMessage, errorText } from '../AiMessage';
import { Page } from '../Page';
import { useSession } from '../Shell';

const SUGGESTIONS = [
  'What happened in my projects in the last 24 hours?',
  'Which open issues should I fix first?',
  'What new issues started this week?',
  'Which API endpoints are the slowest?',
  'How are the Web Vitals of my pages?',
  'Who are the members of each project?',
];

/** Longest history title, in characters (the first question, cut). */
const TITLE_CHARS = 80;
/** Chat ids in the URL are nanoid()s; anything else starts a new chat. */
const CHAT_ID = /^[\w-]{10,40}$/;

/** The first question of a chat, for the history list. */
function chatTitle(messages: readonly UIMessage[]): string | undefined {
  const first = messages.find((m) => m.role === 'user');
  const text = first ? first.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, TITLE_CHARS) : undefined;
}

/** One conversation. Re-mounted (key) when another chat is opened, so its state never leaks into the next. */
function AssistantChat({ chatId, userId, onSaved, onStarted }: { chatId: string; userId: string; onSaved: () => void; onStarted: () => void }) {
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/ai/assistant' }), []);
  const { messages, sendMessage, status, stop, error, setMessages, clearError } = useChat({ id: chatId, transport });
  const busy = status === 'submitted' || status === 'streaming';
  const key = assistantChatKey(chatId);

  // Restore the saved chat once; a question asked before it loads wins over it.
  const [restored, setRestored] = useState(false);
  const savedSignature = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    let cancelled = false;
    void loadChat(userId, key).then((saved) => {
      if (cancelled) return;
      if (saved && saved.length > 0 && messagesRef.current.length === 0) {
        savedSignature.current = chatSignature(saved);
        setMessages(saved);
      }
      setRestored(true);
    });
    return () => { cancelled = true; };
  }, [userId, key, setMessages]);

  // Save after each finished (or stopped / failed) answer, never mid-stream.
  useEffect(() => {
    if (!restored || busy || messages.length === 0) return;
    const signature = chatSignature(messages);
    if (signature === savedSignature.current) return;
    savedSignature.current = signature;
    void saveChat(userId, key, messages, chatTitle(messages)).then(onSaved);
  }, [restored, busy, messages, userId, key, onSaved]);

  const ask = (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    clearError();
    if (messages.length === 0) onStarted();
    void sendMessage({ text: question });
  };

  return (
    <div className="ai-page flex min-h-0 min-w-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full max-w-3xl gap-5 px-4 py-6">
          {messages.length === 0 ? (
            <ConversationEmptyState
              className="ai-empty"
              icon={<Icon name="ghost" />}
              title="Ask about your projects"
              description={`The assistant looks up your projects' issues, events, performance and members when a question needs them. Chats are saved in this browser only (your ${AI_CHATS_PER_USER} most recent, for ${AI_CHAT_MAX_AGE_DAYS} days).`}
            />
          ) : (
            messages.map((m, i) => <ChatMessage key={m.id} message={m} streaming={status === 'streaming' && i === messages.length - 1} />)
          )}
          {status === 'submitted' ? <div className="ai-thinking muted small">Thinking…</div> : null}
          {error ? <div className="ai-error" role="alert">{errorText(error)}</div> : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mx-auto w-full max-w-3xl flex-none px-4 pb-4">
        {messages.length === 0 ? (
          <Suggestions className="pb-2">
            {SUGGESTIONS.map((s) => <Suggestion key={s} suggestion={s} onClick={ask} />)}
          </Suggestions>
        ) : null}
        <PromptInput onSubmit={(message: PromptInputMessage) => ask(message.text)}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="Ask about your projects, issues, performance…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <span className="muted small">Enter to send · Shift+Enter for a new line</span>
            </PromptInputTools>
            <PromptInputSubmit status={status} onStop={() => void stop()} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

/**
 * The Assistant page: a workspace-wide AI chat (POST /api/ai/assistant) with
 * the user's saved chats on the left. `?chat=<id>` keeps the open chat across reloads.
 */
export function AssistantView() {
  const { user } = useSession();
  const router = useRouter();
  const query = useSearchParams();
  const fromUrl = query.get('chat');
  const [chatId, setChatId] = useState(() => (fromUrl && CHAT_ID.test(fromUrl) ? fromUrl : nanoid()));
  const [history, setHistory] = useState<AssistantChatInfo[]>([]);

  const reload = useCallback(() => { void listAssistantChats(user.id).then(setHistory); }, [user.id]);
  useEffect(reload, [reload]);

  // Back/forward between chats.
  useEffect(() => {
    if (fromUrl && CHAT_ID.test(fromUrl) && fromUrl !== chatId) setChatId(fromUrl);
    // Only the URL drives this; chatId changes push their own URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl]);

  const open = (id: string) => {
    setChatId(id);
    router.push(`/assistant?chat=${id}`, { scroll: false });
  };
  const newChat = () => {
    setChatId(nanoid());
    router.push('/assistant', { scroll: false });
  };
  const current = history.find((h) => h.chatId === chatId) ?? null;
  const remove = async (id: string) => {
    await deleteChat(user.id, assistantChatKey(id));
    if (id === chatId) newChat();
    reload();
  };

  return (
    <Page
      crumbs={[{ label: 'Assistant' }]}
      fill
      barLeft={(
        <>
          <Menu trigger={({ open, toggle }) => (
            <button type="button" className={pillButton('secondary', 'h-7 max-w-[min(60vw,300px)] gap-1.5 px-3 text-[12px] [&_svg]:h-3.5 [&_svg]:w-3.5')} onClick={toggle} aria-haspopup="menu" aria-expanded={open} title="Saved chats">
              <Icon name="chat" />
              <span className="truncate">{current ? current.title : 'New chat'}</span>
              <Icon name="chevron" />
            </button>
          )}>
            <div className="menu-label">Saved chats</div>
            {history.length === 0 ? <p className="px-3 py-2 text-[12.5px] text-muted">No saved chats yet.</p> : null}
            <div className="max-h-80 overflow-y-auto">
              {history.map((h) => (
                <div key={h.chatId} className="group flex items-center">
                  <button type="button" className="menu-item min-w-0 flex-1" role="menuitemradio" aria-checked={h.chatId === chatId} onClick={() => open(h.chatId)}>
                    <span className="min-w-0 flex-1 truncate text-left">{h.title}</span>
                    <span className="flex-none text-[11.5px] text-muted">{timeAgo(new Date(h.updatedAt))}</span>
                    {h.chatId === chatId ? <Icon name="check" className="menu-check" /> : null}
                  </button>
                  <button type="button" className="mr-1 grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted shadow-none hover:text-danger [&_svg]:h-3.5 [&_svg]:w-3.5" onClick={() => void remove(h.chatId)} aria-label={`Delete chat: ${h.title}`} title="Delete chat">
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
          </Menu>
          <button type="button" className={pillButton('secondary', 'h-7 gap-1.5 px-3 text-[12px] [&_svg]:h-3.5 [&_svg]:w-3.5')} onClick={newChat}><Icon name="plus" />New chat</button>
        </>
      )}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AssistantChat
          key={chatId}
          chatId={chatId}
          userId={user.id}
          onSaved={reload}
          onStarted={() => { if (fromUrl !== chatId) router.replace(`/assistant?chat=${chatId}`, { scroll: false }); }}
        />
      </div>
    </Page>
  );
}
