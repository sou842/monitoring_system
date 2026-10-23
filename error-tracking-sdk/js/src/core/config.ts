import {
  DEFAULT_ENVIRONMENT,
  DEFAULT_HTML2CANVAS_INTEGRITY,
  DEFAULT_HTML2CANVAS_URL,
  DEFAULT_MASK_SELECTORS,
  DEFAULT_MAX_BREADCRUMBS,
  DEFAULT_SAMPLE_RATE,
  LEAK_CONSECUTIVE_READINGS,
  LEAK_CONSECUTIVE_READINGS_MAX,
  LEAK_CONSECUTIVE_READINGS_MIN,
  LEAK_GROWTH_THRESHOLD,
  LEAK_GROWTH_THRESHOLD_MAX,
  LEAK_GROWTH_THRESHOLD_MIN,
  LEAK_MIN_GROWTH_MB,
  LEAK_MIN_GROWTH_MB_MAX,
  LEAK_MIN_GROWTH_MB_MIN,
  LONG_TASK_FREEZE_MAX_MS,
  LONG_TASK_FREEZE_MIN_MS,
  LONG_TASK_FREEZE_MS,
  LOW_FPS_THRESHOLD,
  LOW_FPS_THRESHOLD_MAX,
  LOW_FPS_THRESHOLD_MIN,
  MAX_BREADCRUMBS_LIMIT,
  MEMORY_POLL_INTERVAL_MAX_MS,
  MEMORY_POLL_INTERVAL_MIN_MS,
  MEMORY_POLL_INTERVAL_MS,
  SLOW_API_CALL_MS,
  SLOW_PAGE_LOAD_MS,
  SLOW_THRESHOLD_MAX_MS,
  SLOW_THRESHOLD_MIN_MS,
} from '../constants';
import { ErrorTrackerConfig, TrackerEvent } from '../types';

/** Config with defaults applied and values validated. */
export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  environment: string;
  appVersion: string | null;
  sampleRate: number;
  maxBreadcrumbs: number;
  maskSelectors: string[];
  debug: boolean;
  captureHttpErrors: boolean;
  captureNetworkErrors: boolean;
  captureConsoleErrors: boolean;
  captureScreenshots: boolean;
  detectPageNotFound: boolean;
  html2canvasUrl: string;
  html2canvasIntegrity: string;
  beforeSend: ((event: TrackerEvent) => TrackerEvent | null) | null;
  slowApiCallMs: number;
  slowPageLoadMs: number;
  mainThreadBlockedMs: number;
  lowFrameRateFps: number;
  memoryPollIntervalMs: number;
  memoryLeakGrowth: number;
  memoryLeakMinGrowthMb: number;
  memoryLeakReadings: number;
}

export type ConfigResult = { ok: true; config: ResolvedConfig } | { ok: false; reason: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A finite number clamped to [min, max], or the default when the value is missing or not a number. */
function numberOption(value: unknown, fallback: number, min: number, max: number, integer: boolean): number {
  if (typeof value !== 'number' || !isFinite(value)) return fallback;
  return clamp(integer ? Math.round(value) : value, min, max);
}

function isValidUrl(value: string): boolean {
  try {
    // Relative endpoints are allowed in browsers (same-origin ingestion proxies).
    new URL(value, typeof document !== 'undefined' ? document.baseURI : undefined);
    return true;
  } catch (_e) {
    return false;
  }
}

/** Validates user config and fills in defaults. Never throws. */
export function resolveConfig(input: ErrorTrackerConfig | null | undefined): ConfigResult {
  if (input === null || typeof input !== 'object') return { ok: false, reason: 'config object is required' };
  if (typeof input.apiKey !== 'string' || input.apiKey.trim().length === 0) {
    return { ok: false, reason: 'apiKey must be a non-empty string' };
  }
  if (typeof input.endpoint !== 'string' || !isValidUrl(input.endpoint)) {
    return { ok: false, reason: 'endpoint must be a valid URL' };
  }

  const sampleRate =
    typeof input.sampleRate === 'number' && !isNaN(input.sampleRate) ? clamp(input.sampleRate, 0, 1) : DEFAULT_SAMPLE_RATE;
  const maxBreadcrumbs =
    typeof input.maxBreadcrumbs === 'number' && isFinite(input.maxBreadcrumbs)
      ? clamp(Math.floor(input.maxBreadcrumbs), 0, MAX_BREADCRUMBS_LIMIT)
      : DEFAULT_MAX_BREADCRUMBS;
  const userSelectors = Object.prototype.toString.call(input.maskSelectors) === '[object Array]' ? input.maskSelectors || [] : [];

  return {
    ok: true,
    config: {
      apiKey: input.apiKey,
      endpoint: input.endpoint,
      environment: typeof input.environment === 'string' && input.environment.length > 0 ? input.environment : DEFAULT_ENVIRONMENT,
      appVersion: typeof input.appVersion === 'string' && input.appVersion.length > 0 ? input.appVersion : null,
      sampleRate: sampleRate,
      maxBreadcrumbs: maxBreadcrumbs,
      maskSelectors: DEFAULT_MASK_SELECTORS.concat(
        userSelectors.filter(function isString(s): s is string {
          return typeof s === 'string' && s.length > 0;
        }),
      ),
      debug: input.debug === true,
      captureHttpErrors: input.captureHttpErrors !== false,
      captureNetworkErrors: input.captureNetworkErrors !== false,
      captureConsoleErrors: input.captureConsoleErrors === true,
      captureScreenshots: input.captureScreenshots !== false,
      detectPageNotFound: input.detectPageNotFound !== false,
      html2canvasUrl: typeof input.html2canvasUrl === 'string' && input.html2canvasUrl.length > 0 ? input.html2canvasUrl : DEFAULT_HTML2CANVAS_URL,
      html2canvasIntegrity:
        typeof input.html2canvasIntegrity === 'string'
          ? input.html2canvasIntegrity
          : typeof input.html2canvasUrl === 'string' && input.html2canvasUrl.length > 0
            ? '' // A custom URL cannot share the default file's hash.
            : DEFAULT_HTML2CANVAS_INTEGRITY,
      beforeSend: typeof input.beforeSend === 'function' ? input.beforeSend : null,
      slowApiCallMs: numberOption(input.slowApiCallMs, SLOW_API_CALL_MS, SLOW_THRESHOLD_MIN_MS, SLOW_THRESHOLD_MAX_MS, false),
      slowPageLoadMs: numberOption(input.slowPageLoadMs, SLOW_PAGE_LOAD_MS, SLOW_THRESHOLD_MIN_MS, SLOW_THRESHOLD_MAX_MS, false),
      mainThreadBlockedMs: numberOption(
        input.mainThreadBlockedMs,
        LONG_TASK_FREEZE_MS,
        LONG_TASK_FREEZE_MIN_MS,
        LONG_TASK_FREEZE_MAX_MS,
        false,
      ),
      lowFrameRateFps: numberOption(input.lowFrameRateFps, LOW_FPS_THRESHOLD, LOW_FPS_THRESHOLD_MIN, LOW_FPS_THRESHOLD_MAX, false),
      memoryPollIntervalMs: numberOption(
        input.memoryPollIntervalMs,
        MEMORY_POLL_INTERVAL_MS,
        MEMORY_POLL_INTERVAL_MIN_MS,
        MEMORY_POLL_INTERVAL_MAX_MS,
        false,
      ),
      memoryLeakGrowth: numberOption(
        input.memoryLeakGrowth,
        LEAK_GROWTH_THRESHOLD,
        LEAK_GROWTH_THRESHOLD_MIN,
        LEAK_GROWTH_THRESHOLD_MAX,
        false,
      ),
      memoryLeakMinGrowthMb: numberOption(
        input.memoryLeakMinGrowthMb,
        LEAK_MIN_GROWTH_MB,
        LEAK_MIN_GROWTH_MB_MIN,
        LEAK_MIN_GROWTH_MB_MAX,
        false,
      ),
      memoryLeakReadings: numberOption(
        input.memoryLeakReadings,
        LEAK_CONSECUTIVE_READINGS,
        LEAK_CONSECUTIVE_READINGS_MIN,
        LEAK_CONSECUTIVE_READINGS_MAX,
        true,
      ),
    },
  };
}
