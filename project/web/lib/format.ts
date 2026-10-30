/**
 * Display formatting for the dashboard (browser locale, so client-side only).
 */

export const SDK_PACKAGE = '@sourav732/error-tracker-js';
export const RANGE_LABELS = { '24h': '24H', '7d': '7 DAYS' } as const;
export type Range = keyof typeof RANGE_LABELS;

const MS_PER_SECOND = 1000;
/** Durations from this many ms up are shown in seconds. */
export const SECONDS_FROM_MS = 1000;

/** "just now", "5 min ago", "3 h ago", "2 d ago", "4 mo ago", "1 y ago". */
export function timeAgo(value: string | Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} h ago`;
  if (days < 30) return `${days} d ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

/** Full local date and time, or "–". */
export function formatDate(value: string | Date | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '–';
}

/** "850 ms", "2.5 s", "12 s", or "–". */
export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '–';
  return value >= SECONDS_FROM_MS ? `${(value / MS_PER_SECOND).toFixed(value >= 10 * SECONDS_FROM_MS ? 0 : 1)} s` : `${Math.round(value)} ms`;
}

/** 0.034 → "3%", 0.004 → "0.4%". */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.01 ? 1 : 0)}%`;
}

/** "512 B", "14 KB", "2.3 MB", or "–". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '–';
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

/** X-axis label for a chart bucket: weekday for 7 days, hour for 24 h. */
export function bucketLabel(iso: string, range: Range): string {
  const date = new Date(iso);
  return range === '7d'
    ? date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** The first word of a user's name, or "there". */
export function firstName(user: { name?: string } | null | undefined): string {
  return (user && user.name ? user.name.split(' ')[0] : '') || 'there';
}

/** A URL query string without empty values: `{ a: '1', b: '' }` → `?a=1` (or '' when nothing is left). */
export function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Install + init code for a project, shown with a new API key and on an empty project. */
export function setupSnippet(apiKey: string, origin: string): string {
  return [
    `npm install ${SDK_PACKAGE}`,
    '',
    `import ErrorTracker from '${SDK_PACKAGE}';`,
    '',
    'ErrorTracker.init({',
    `  apiKey: '${apiKey}',`,
    `  endpoint: '${origin}/api/v1/events',`,
    "  environment: 'production',",
    '});',
  ].join('\n');
}
