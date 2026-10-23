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
      memoryLeakMinGrowthMb: 10,
      memoryLeakReadings: 4,
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
        memoryLeakMinGrowthMb: 50,
        memoryLeakReadings: 5,
      }),
    ).toMatchObject({
      slowApiCallMs: 3000,
      slowPageLoadMs: 5000,
      mainThreadBlockedMs: 500,
      lowFrameRateFps: 30,
      memoryPollIntervalMs: 60000,
      memoryLeakGrowth: 0.5,
      memoryLeakMinGrowthMb: 50,
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
        memoryLeakMinGrowthMb: 0,
        memoryLeakReadings: 1,
      }),
    ).toMatchObject({
      slowApiCallMs: 100,
      slowPageLoadMs: 600000,
      mainThreadBlockedMs: 50,
      lowFrameRateFps: 60,
      memoryPollIntervalMs: 5000,
      memoryLeakGrowth: 0.01,
      memoryLeakMinGrowthMb: 1,
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

describe('resolveConfig httpErrorStatuses', () => {
  it('defaults to 5xx plus the 4xx codes that usually mean a client bug', () => {
    expect(resolved({}).httpErrorStatuses).toEqual([[400, 400], [404, 404], [405, 405], [413, 413], [500, 599]]);
  });

  it('accepts single codes and [min, max] ranges', () => {
    expect(resolved({ httpErrorStatuses: [401, [500, 503]] }).httpErrorStatuses).toEqual([[401, 401], [500, 503]]);
  });

  it('drops invalid entries and keeps the valid ones', () => {
    const input = [99, 600, 404.5, [503, 500], [400], '500', null, 418] as unknown as ErrorTrackerConfig['httpErrorStatuses'];
    expect(resolved({ httpErrorStatuses: input }).httpErrorStatuses).toEqual([[418, 418]]);
  });

  it('accepts readonly (as const) lists', () => {
    const statuses = [401, [500, 599]] as const;
    expect(resolved({ httpErrorStatuses: statuses }).httpErrorStatuses).toEqual([[401, 401], [500, 599]]);
  });

  it('reports nothing for an empty list and uses the default for a non-array', () => {
    expect(resolved({ httpErrorStatuses: [] }).httpErrorStatuses).toEqual([]);
    const notArray = '500' as unknown as ErrorTrackerConfig['httpErrorStatuses'];
    expect(resolved({ httpErrorStatuses: notArray }).httpErrorStatuses).toHaveLength(5);
  });
});
