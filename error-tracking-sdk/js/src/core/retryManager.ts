import { RETRY_DELAYS_MS } from '../constants';

/** Outcome of a single delivery attempt. */
export interface AttemptResult {
  ok: boolean;
  /** Whether trying again could succeed (network error, 5xx, 408, 429). */
  retryable: boolean;
  status: number | null;
}

/** Final outcome after all attempts. */
export interface RetryOutcome extends AttemptResult {
  attempts: number;
}

export type Scheduler = (fn: () => void, delayMs: number) => void;

const defaultScheduler: Scheduler = function schedule(fn, delayMs) {
  setTimeout(fn, delayMs);
};

/**
 * Runs `attempt` until it succeeds, fails non-retryably, or the backoff
 * schedule (1s, 2s, 4s by default) is exhausted. Never rejects: a rejected
 * attempt is treated as a retryable network failure.
 */
export function retryWithBackoff(
  attempt: () => Promise<AttemptResult>,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
  schedule: Scheduler = defaultScheduler,
): Promise<RetryOutcome> {
  return new Promise<RetryOutcome>(function run(resolve) {
    let attempts = 0;

    function next(): void {
      attempts++;
      let pending: Promise<AttemptResult>;
      try {
        pending = attempt();
      } catch (_e) {
        pending = Promise.resolve<AttemptResult>({ ok: false, retryable: true, status: null });
      }

      pending
        .then(
          function onResult(result) {
            return result;
          },
          function onReject(): AttemptResult {
            return { ok: false, retryable: true, status: null };
          },
        )
        .then(function decide(result) {
          const retriesUsed = attempts - 1;
          if (result.ok || !result.retryable || retriesUsed >= delaysMs.length) {
            resolve({ ok: result.ok, retryable: result.retryable, status: result.status, attempts: attempts });
            return;
          }
          schedule(next, delaysMs[retriesUsed]);
        });
    }

    next();
  });
}
