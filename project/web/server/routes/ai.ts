import { APICallError, convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText, type ModelMessage, type UIMessage } from 'ai';
import { isProduction } from '../env.ts';
import { forbidden, issueAccess } from '../access.ts';
import { issueContext, loadIssueContext } from '../ai/context.ts';
import { aiConfigured, chatModel } from '../ai/nvidia.ts';
import { SYSTEM_PROMPT } from '../ai/prompt.ts';
import { issueTools } from '../ai/tools.ts';
import { requireUser } from '../auth.ts';
import {
  AI_MAX_HISTORY_MESSAGES,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_QUESTION_CHARS,
  AI_MAX_REQUEST_BYTES,
  AI_MAX_STEPS,
  AI_MESSAGES_PER_USER,
  AI_RATE_WINDOW_MS,
  AI_REQUEST_TIMEOUT_MS,
} from '../constants.ts';
import { bodyObject, errorResponse, handle, parseObjectId, readJson } from '../http.ts';
import { consume } from '../rateLimit.ts';

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
function logPrompt(issueId: string, step: number, system: string, messages: readonly ModelMessage[]): void {
  const json = JSON.stringify(messages, null, 2);
  console.log([
    `\n========== [ai] prompt · issue ${issueId} · step ${step} · system ${system.length} chars · ${messages.length} messages (${json.length} chars) ==========`,
    '---------- system ----------',
    system,
    '---------- messages ----------',
    json,
    '========== [ai] end of prompt ==========\n',
  ].join('\n'));
}

/** What the chat panel shows when the model call fails (details go to the server log). */
function friendlyError(error: unknown): string {
  logModelError(error);
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return 'The AI service is busy (rate limit). Wait a minute and try again.';
    if (error.statusCode === 401 || error.statusCode === 403) return 'The AI service refused the API key. Check NVIDIA_API_KEY.';
    if (error.statusCode !== undefined && error.statusCode >= 500) return 'The AI service had a problem. Try again in a moment.';
  }
  return 'Something went wrong while answering. Try again.';
}

/**
 * POST /api/ai/chat `{ issueId, eventId?, messages }` — the issue assistant.
 * Streams the answer (AI SDK UI message stream, reasoning included). The project
 * owner and members with `ai.use` can ask; the chat isn't stored, the browser sends it each time.
 */
export const POST = handle(async (request) => {
  const auth = await requireUser(request);
  if (auth.response) return auth.response;
  if (!aiConfigured()) return errorResponse(503, 'ai_not_configured', 'The AI assistant is not set up (NVIDIA_API_KEY is missing)');

  const body = await readJson(request, AI_MAX_REQUEST_BYTES);
  if (!body.ok) return body.response;
  const input = bodyObject(body.value);
  const issueId = parseObjectId(input.issueId);
  if (issueId === null) return errorResponse(400, 'invalid_id', 'Missing or invalid issue id');
  const found = await issueAccess(auth.db, auth.user, issueId);
  if (found === null) return errorResponse(404, 'not_found', 'Issue not found');
  if (!found.access.can('ai.use')) return forbidden('ai.use');
  const { issue } = found;

  const validated = await safeValidateUIMessages<UIMessage>({ messages: input.messages });
  if (!validated.success) return errorResponse(400, 'invalid_messages', 'Invalid chat messages');
  // The browser sends the history; only the user's and the assistant's turns count (no injected system messages).
  const messages = validated.data.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-AI_MAX_HISTORY_MESSAGES);
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return errorResponse(400, 'invalid_messages', 'The last message must be a question');
  if (questionLength(last) > AI_MAX_QUESTION_CHARS) return errorResponse(400, 'question_too_long', `Questions are limited to ${AI_MAX_QUESTION_CHARS} characters`);

  const budget = await consume(auth.db, `ai:${auth.user._id}`, 1, AI_MESSAGES_PER_USER, AI_RATE_WINDOW_MS);
  if (!budget.allowed) {
    return errorResponse(429, 'rate_limited', `You've reached the AI question limit (${AI_MESSAGES_PER_USER} per hour). Try again later.`, { 'Retry-After': String(budget.retryAfterSeconds) });
  }

  const context = await loadIssueContext(auth.db, issue, parseObjectId(input.eventId));
  const tools = issueTools(auth.db, issue, context.project);
  const system = `${SYSTEM_PROMPT}\n\n${issueContext(context)}`;
  const debug = debugPromptEnabled();
  const result = streamText({
    model: chatModel(),
    system,
    // Runs before every model call (one per tool step), so the log shows each call's full input.
    prepareStep: debug ? ({ stepNumber, messages: stepMessages }) => { logPrompt(String(issue._id), stepNumber, system, stepMessages); return undefined; } : undefined,
    messages: await convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: stepCountIs(AI_MAX_STEPS),
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS)]),
    // Replaces the SDK's default, which logs the whole error (prompt included).
    onError: ({ error }) => logModelError(error),
  });
  return result.toUIMessageStreamResponse({ sendReasoning: true, onError: friendlyError });
});
