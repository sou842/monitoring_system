import { chatHistory, spendQuestion, startChat, streamAnswer } from '../ai/chat.ts';
import { workspaceContext, workspaceScope, workspaceTools } from '../ai/workspace.ts';
import { WORKSPACE_PROMPT } from '../ai/workspacePrompt.ts';
import { AI_WORKSPACE_MAX_STEPS } from '../constants.ts';
import { handle } from '../http.ts';

/**
 * POST /api/ai/assistant `{ messages }` — the workspace assistant (/assistant page).
 * It can read every project the user owns or uses AI in (members with `ai.use`):
 * projects, issues, events, performance and members, through tools, so the
 * prompt itself stays small. Same question budget as the issue panel; nothing is stored.
 */
export const POST = handle(async (request) => {
  const started = await startChat(request);
  if (started.response) return started.response;
  const { db, user, input } = started;

  const history = await chatHistory(input.messages);
  if (history.response) return history.response;
  const limited = await spendQuestion(db, user);
  if (limited) return limited;

  const scope = await workspaceScope(db, user);
  return streamAnswer({
    request,
    label: 'workspace',
    system: `${WORKSPACE_PROMPT}\n\n${workspaceContext(user, scope)}`,
    messages: history.messages,
    tools: workspaceTools(db, scope),
    maxSteps: AI_WORKSPACE_MAX_STEPS,
  });
});
