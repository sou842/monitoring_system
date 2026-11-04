import { APICallError, convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText, type ModelMessage, type ToolSet, type UIMessage } from 'ai';
import type { Db } from 'mongodb';
import { requireUser } from '../auth.ts';
import {
  AI_MAX_HISTORY_MESSAGES,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_QUESTION_CHARS,
  AI_MAX_REQUEST_BYTES,
  AI_MESSAGES_PER_USER,
  AI_RATE_WINDOW_MS,
  AI_REQUEST_TIMEOUT_MS,
} from '../constants.ts';
import { isProduction } from '../env.ts';
import { bodyObject, errorResponse, readJson } from '../http.ts';
import type { UserDoc } from '../models.ts';
import { consume } from '../rateLimit.ts';
import { aiConfigured, chatModel } from './nvidia.ts';

/**
 * What both assistants share (the issue panel, POST /api/ai/chat, and the
 * workspace assistant, POST /api/ai/assistant): request checks, the question
 * budget, and streaming the answer without leaking the prompt into logs.
 */

/** Characters of the text the user typed in their newest message. */
function questionLength(message: UIMessage | undefined): number {
  if (!message || message.role !== 'user') return 0;
  return message.parts.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 0), 0);
}

/**
 * Logs a model error without its request: an APICallError carries the whole
 * prompt (event data, user ids), which must not end up in the server logs.
 */
function logModelError(error: unknown): void {
  if (APICallError.isInstance(error)) console.error('[ai] model error', error.statusCode ?? 'no status', error.message);
  else if (error instanceof Error && error.name === 'AbortError') return; // the user stopped the answer or left the page
  else console.error('[ai] model error', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

/**
 * True when `AI_DEBUG_PROMPT=1` and this isn't production. The prompt holds
 * event data (user ids, URLs…), so it must never reach production logs.
 */
function debugPromptEnabled(): boolean {
  return process.env.AI_DEBUG_PROMPT === '1' && !isProduction();
}

/** Prints what one model call receives: the system prompt and every message, as sent. */
function logPrompt(label: string, step: number, system: string, messages: readonly ModelMessage[]): void {
  const json = JSON.stringify(messages, null, 2);
  console.log([
    `\n========== [ai] prompt · ${label} · step ${step} · system ${system.length} chars · ${messages.length} messages (${json.length} chars) ==========`,
    '---------- system ----------',
    system,
    '---------- messages ----------',
    json,
    '========== [ai] end of prompt ==========\n',
  ].join('\n'));
}

/** What the chat shows when the model call fails (details go to the server log). */
function friendlyError(error: unknown): string {
  logModelError(error);
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return 'The AI service is busy (rate limit). Wait a minute and try again.';
    if (error.statusCode === 401 || error.statusCode === 403) return 'The AI service refused the API key. Check NVIDIA_API_KEY.';
    if (error.statusCode !== undefined && error.statusCode >= 500) return 'The AI service had a problem. Try again in a moment.';
  }
  return 'Something went wrong while answering. Try again.';
}

type Started = { response: Response } | { response?: undefined; db: Db; user: UserDoc; input: Record<string, unknown> };

/** Login, AI configured, JSON body: the checks before anything route-specific. */
export async function startChat(request: Request): Promise<Started> {
  const auth = await requireUser(request);
  if (auth.response) return { response: auth.response };
  if (!aiConfigured()) return { response: errorResponse(503, 'ai_not_configured', 'The AI assistant is not set up (NVIDIA_API_KEY is missing)') };
  const body = await readJson(request, AI_MAX_REQUEST_BYTES);
  if (!body.ok) return { response: body.response };
  return { db: auth.db, user: auth.user, input: bodyObject(body.value) };
}

/**
 * The chat history the browser sent, checked: only user/assistant turns (no
 * injected system messages), the newest AI_MAX_HISTORY_MESSAGES, ending with a question.
 */
export async function chatHistory(raw: unknown): Promise<{ messages: UIMessage[]; response?: undefined } | { response: Response }> {
  const validated = await safeValidateUIMessages<UIMessage>({ messages: raw });
  if (!validated.success) return { response: errorResponse(400, 'invalid_messages', 'Invalid chat messages') };
  const messages = validated.data.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-AI_MAX_HISTORY_MESSAGES);
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return { response: errorResponse(400, 'invalid_messages', 'The last message must be a question') };
  if (questionLength(last) > AI_MAX_QUESTION_CHARS) return { response: errorResponse(400, 'question_too_long', `Questions are limited to ${AI_MAX_QUESTION_CHARS} characters`) };
  return { messages };
}

/** Takes one question from the user's hourly budget (shared by both assistants); a 429 response when it's used up. */
export async function spendQuestion(db: Db, user: UserDoc): Promise<Response | null> {
  const budget = await consume(db, `ai:${user._id}`, 1, AI_MESSAGES_PER_USER, AI_RATE_WINDOW_MS);
  if (budget.allowed) return null;
  return errorResponse(429, 'rate_limited', `You've reached the AI question limit (${AI_MESSAGES_PER_USER} per hour). Try again later.`, { 'Retry-After': String(budget.retryAfterSeconds) });
}

/** Streams the answer (AI SDK UI message stream, reasoning included). */
export async function streamAnswer({ request, label, system, messages, tools, maxSteps }: {
  request: Request;
  /** Names the chat in debug logs ("issue <id>", "workspace"). */
  label: string;
  system: string;
  messages: UIMessage[];
  tools: ToolSet;
  maxSteps: number;
}): Promise<Response> {
  const debug = debugPromptEnabled();
  const result = streamText({
    model: chatModel(),
    system,
    // Runs before every model call (one per tool step), so the log shows each call's full input.
    prepareStep: debug ? ({ stepNumber, messages: stepMessages }) => { logPrompt(label, stepNumber, system, stepMessages); return undefined; } : undefined,
    messages: await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)]),
    // Replaces the SDK's default, which logs the whole error (prompt included).
    onError: ({ error }) => logModelError(error),
  });
  return result.toUIMessageStreamResponse({ sendReasoning: true, onError: friendlyError });
}
