import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { AI_BASE_URL, AI_MODEL } from '../constants.ts';

/**
 * The chat model behind the issue assistant: NVIDIA NIM's OpenAI-compatible
 * API. NVIDIA_API_KEY may hold several comma-separated keys; requests take
 * them in turn, and a key that answers 401/403/429 hands the request to the
 * next one, so one exhausted free-tier key doesn't stop the assistant.
 */

/** Statuses after which the same request is tried with the next key. */
const NEXT_KEY_STATUSES = [401, 403, 429];

/** The configured keys, in order; empty when the assistant isn't set up. */
export function apiKeys(raw = process.env.NVIDIA_API_KEY): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((k) => k.trim()).filter((k) => k.length > 0);
}

/** True when at least one key is configured. */
export function aiConfigured(): boolean {
  return apiKeys().length > 0;
}

let nextKey = 0;

/**
 * A fetch that adds `Authorization: Bearer <key>`, starting with the next key
 * in turn and moving on while keys answer with a status in NEXT_KEY_STATUSES.
 * The last answer is returned as is, so the AI SDK reports the real error.
 */
export function rotatingFetch(keys: readonly string[], baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    if (keys.length === 0) throw new Error('NVIDIA_API_KEY is not set');
    const start = nextKey++ % keys.length;
    let response: Response | null = null;
    for (let i = 0; i < keys.length; i++) {
      const headers = new Headers(init && init.headers);
      headers.set('Authorization', `Bearer ${keys[(start + i) % keys.length]}`);
      response = await baseFetch(input, { ...init, headers });
      if (!NEXT_KEY_STATUSES.includes(response.status) || i === keys.length - 1) return response;
      // Free the unused body before retrying with the next key.
      await response.body?.cancel().catch(() => {});
    }
    return response as Response;
  };
}

/** The language model, with the current keys. */
export function chatModel(): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'nvidia',
    baseURL: AI_BASE_URL,
    fetch: rotatingFetch(apiKeys()),
    includeUsage: true,
  });
  return provider.chatModel(AI_MODEL);
}
