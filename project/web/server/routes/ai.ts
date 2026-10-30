import { APICallError, convertToModelMessages, safeValidateUIMessages, stepCountIs, streamText, type UIMessage } from 'ai';
import { ownedIssue } from '../access.ts';
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
 * Streams the answer (AI SDK UI message stream, reasoning included). Only the
 * issue's owner can ask; the chat isn't stored, the browser sends it each time.
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
  const issue = await ownedIssue(auth.db, auth.user, issueId);
  if (issue === null) return errorResponse(404, 'not_found', 'Issue not found');

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
  const result = streamText({
    model: chatModel(),
    system: `${SYSTEM_PROMPT}\n\n${issueContext(context)}`,
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
