import { forbidden, issueAccess } from '../access.ts';
import { chatHistory, spendQuestion, startChat, streamAnswer } from '../ai/chat.ts';
import { issueContext, loadIssueContext } from '../ai/context.ts';
import { SYSTEM_PROMPT } from '../ai/prompt.ts';
import { issueTools } from '../ai/tools.ts';
import { AI_MAX_STEPS } from '../constants.ts';
import { errorResponse, handle, parseObjectId } from '../http.ts';

/**
 * POST /api/ai/chat `{ issueId, eventId?, messages }` — the issue assistant.
 * Streams the answer (AI SDK UI message stream, reasoning included). The project
 * owner and members with `ai.use` can ask; the chat isn't stored, the browser sends it each time.
 */
export const POST = handle(async (request) => {
  const started = await startChat(request);
  if (started.response) return started.response;
  const { db, user, input } = started;

  const issueId = parseObjectId(input.issueId);
  if (issueId === null) return errorResponse(400, 'invalid_id', 'Missing or invalid issue id');
  const found = await issueAccess(db, user, issueId);
  if (found === null) return errorResponse(404, 'not_found', 'Issue not found');
  if (!found.access.can('ai.use')) return forbidden('ai.use');
  const { issue } = found;

  const history = await chatHistory(input.messages);
  if (history.response) return history.response;
  const limited = await spendQuestion(db, user);
  if (limited) return limited;

  const context = await loadIssueContext(db, issue, parseObjectId(input.eventId));
  return streamAnswer({
    request,
    label: `issue ${String(issue._id)}`,
    system: `${SYSTEM_PROMPT}\n\n${issueContext(context)}`,
    messages: history.messages,
    tools: issueTools(db, issue, context.project),
    maxSteps: AI_MAX_STEPS,
  });
});
