import { MAX_HINT_TEXT_LENGTH, MAX_INSIGHT_ENTRIES, MAX_INSIGHT_PATTERN_LENGTH } from './constants.js';

/**
 * Per-project settings for the issue page's insights (public/insights.js):
 * - `libraryPaths`: text in a frame's file URL that marks it as third-party
 *   code, added to the built-in list (jQuery, React, …).
 * - `hiddenFrames`: function names (or paths, when they contain `/`) of
 *   wrappers such as a tracking snippet, left out of "where to look".
 * - `hints`: `{ match, text }`; shown when `match` appears in the error type,
 *   message or a context value.
 */

/** Empty settings, the shape every project has. */
export function emptyInsightSettings() {
  return { libraryPaths: [], hiddenFrames: [], hints: [] };
}

/** Stored settings in their public shape (missing lists → []). */
export function insightSettingsView(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    libraryPaths: Array.isArray(s.libraryPaths) ? s.libraryPaths : [],
    hiddenFrames: Array.isArray(s.hiddenFrames) ? s.hiddenFrames : [],
    hints: Array.isArray(s.hints) ? s.hints : [],
  };
}

/** The dashboard writes hints as `match => text` lines, so a match can't contain this. */
export const HINT_SEPARATOR = '=>';

/** Trimmed, de-duplicated list of short texts, or an error message. */
function cleanTextList(list, name) {
  if (list === undefined) return { ok: true, value: [] };
  if (!Array.isArray(list)) return { ok: false, message: `${name} must be a list` };
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') return { ok: false, message: `${name} must contain only text` };
    const text = item.trim();
    if (!text) continue;
    if (/[\r\n]/.test(text)) return { ok: false, message: `${name}: one entry per line, without line breaks` };
    if (text.length > MAX_INSIGHT_PATTERN_LENGTH) return { ok: false, message: `${name}: "${text.slice(0, 40)}…" is longer than ${MAX_INSIGHT_PATTERN_LENGTH} characters` };
    seen.add(text);
    // Stop at once: a large body of tiny entries must not cost CPU time.
    if (seen.size > MAX_INSIGHT_ENTRIES) return { ok: false, message: `${name}: at most ${MAX_INSIGHT_ENTRIES} entries` };
  }
  return { ok: true, value: [...seen] };
}

/**
 * Validates settings sent by the dashboard. Every list is optional; a missing
 * one is saved as empty (the dashboard always sends all three).
 *
 * @returns {{ ok: true, settings: object } | { ok: false, message: string }}
 */
export function cleanInsightSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'insights must be an object' };
  const libraryPaths = cleanTextList(input.libraryPaths, 'Library paths');
  if (!libraryPaths.ok) return libraryPaths;
  const hiddenFrames = cleanTextList(input.hiddenFrames, 'Frames to hide');
  if (!hiddenFrames.ok) return hiddenFrames;

  const hints = [];
  if (input.hints !== undefined && !Array.isArray(input.hints)) return { ok: false, message: 'Hints must be a list' };
  for (const hint of input.hints || []) {
    if (!hint || typeof hint.match !== 'string' || typeof hint.text !== 'string') return { ok: false, message: 'Each hint needs a match and a text' };
    const match = hint.match.trim();
    const text = hint.text.trim();
    if (!match || !text) return { ok: false, message: 'Each hint needs a match and a text' };
    if (match.includes(HINT_SEPARATOR)) return { ok: false, message: `A hint's match can't contain "${HINT_SEPARATOR}"` };
    if (match.length > MAX_INSIGHT_PATTERN_LENGTH) return { ok: false, message: `Hint match "${match.slice(0, 40)}…" is longer than ${MAX_INSIGHT_PATTERN_LENGTH} characters` };
    if (text.length > MAX_HINT_TEXT_LENGTH) return { ok: false, message: `The hint for "${match}" is longer than ${MAX_HINT_TEXT_LENGTH} characters` };
    hints.push({ match, text: text.replace(/\s*\r?\n\s*/g, ' ') });
    if (hints.length > MAX_INSIGHT_ENTRIES) return { ok: false, message: `Hints: at most ${MAX_INSIGHT_ENTRIES} entries` };
  }

  return { ok: true, settings: { libraryPaths: libraryPaths.value, hiddenFrames: hiddenFrames.value, hints } };
}
