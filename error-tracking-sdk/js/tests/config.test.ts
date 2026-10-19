import { describe, expect, it } from 'vitest';
import { resolveConfig, ResolvedConfig } from '../src/core/config';
import { ErrorTrackerConfig } from '../src/types';

const BASE: ErrorTrackerConfig = { apiKey: 'pk_test', endpoint: 'https://ingest.test/v1/events' };

function resolved(extra: Partial<ErrorTrackerConfig>): ResolvedConfig {
  const result = resolveConfig({ ...BASE, ...extra });
  if (!result.ok) throw new Error(result.reason);
  return result.config;
}

describe('resolveConfig performance thresholds', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(resolved({})).toMatchObject({
      slowApiCallMs: 2000,
      slowPageLoadMs: 3000,
      mainThreadBlockedMs: 1000,
      lowFrameRateFps: 20,
      memoryPollIntervalMs: 30000,
      memoryLeakGrowth: 0.2,
      memoryLeakReadings: 3,
    });
  });

  it('accepts values inside the allowed range', () => {
    expect(
      resolved({
        slowApiCallMs: 3000,
        slowPageLoadMs: 5000,
        mainThreadBlockedMs: 500,
        lowFrameRateFps: 30,
        memoryPollIntervalMs: 60000,
        memoryLeakGrowth: 0.5,
        memoryLeakReadings: 5,
      }),
    ).toMatchObject({
      slowApiCallMs: 3000,
      slowPageLoadMs: 5000,
      mainThreadBlockedMs: 500,
      lowFrameRateFps: 30,
      memoryPollIntervalMs: 60000,
      memoryLeakGrowth: 0.5,
      memoryLeakReadings: 5,
    });
  });

  it('clamps out-of-range values instead of failing', () => {
    expect(
      resolved({
        slowApiCallMs: -5,
        slowPageLoadMs: 99999999,
        mainThreadBlockedMs: 10,
        lowFrameRateFps: 500,
        memoryPollIntervalMs: 1,
        memoryLeakGrowth: 0,
        memoryLeakReadings: 1,
      }),
    ).toMatchObject({
      slowApiCallMs: 100,
      slowPageLoadMs: 600000,
      mainThreadBlockedMs: 50,
      lowFrameRateFps: 60,
      memoryPollIntervalMs: 5000,
      memoryLeakGrowth: 0.01,
      memoryLeakReadings: 2,
    });
  });

  it('falls back to the default for non-numbers, NaN and Infinity', () => {
    const bad = { slowApiCallMs: '3000', slowPageLoadMs: NaN, mainThreadBlockedMs: Infinity } as unknown as Partial<ErrorTrackerConfig>;
    expect(resolved(bad)).toMatchObject({ slowApiCallMs: 2000, slowPageLoadMs: 3000, mainThreadBlockedMs: 1000 });
  });

  it('rounds memoryLeakReadings to a whole number', () => {
    expect(resolved({ memoryLeakReadings: 4.6 }).memoryLeakReadings).toBe(5);
  });
});
