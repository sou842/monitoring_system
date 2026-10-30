'use client';

import { useEffect, useState } from 'react';

const MB = 1024 * 1024;
/** A JS array of numbers costs 8 bytes per element on the V8 heap. */
const ELEMENTS_PER_MB = MB / 8;
const LEAK_MB_PER_TICK = 1;
const LEAK_TICK_MS = 2000;
/** Stops on its own here so the demo can't take the tab down. */
const LEAK_LIMIT_MB = 300;
const HEAVY_SCREEN_MB = 30;
const STATUS_REFRESH_MS = 1000;

// Module scope on purpose: this is what a real leak looks like, e.g. a cache or
// listener list that outlives the screen that filled it.
const leakedScreens: Array<{ openedAt: number; rows: number[] }> = [];
let leakTimer: ReturnType<typeof setInterval> | null = null;
let heavyScreen: number[] | null = null;

function allocateMb(mb: number): number[] {
  return new Array<number>(mb * ELEMENTS_PER_MB).fill(Math.random());
}

/** Chromium's non-standard heap size API. */
type PerformanceWithMemory = Performance & { memory?: { usedJSHeapSize: number } };

function readHeapMb(): number | null {
  const memory = typeof performance !== 'undefined' ? (performance as PerformanceWithMemory).memory : undefined;
  return memory ? Math.round((memory.usedJSHeapSize / MB) * 10) / 10 : null;
}

interface Status {
  leakedMb: number;
  running: boolean;
  heavy: boolean;
  /** undefined until the first read in the browser, null when the browser can't tell. */
  heapMb: number | null | undefined;
  startedAt: number | null;
}

/**
 * Memory-leak scenarios for the SDK's MemoryLeakSuspected detection
 * (Chromium only, since only Chromium exposes `performance.memory`).
 */
export default function MemoryLeakDemo() {
  const [status, setStatus] = useState<Status>({ leakedMb: 0, running: false, heavy: false, heapMb: undefined, startedAt: null });

  useEffect(() => {
    const refresh = () =>
      setStatus((s) => ({ ...s, leakedMb: leakedScreens.length * LEAK_MB_PER_TICK, running: leakTimer !== null, heavy: heavyScreen !== null, heapMb: readHeapMb() }));
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  function startLeak() {
    if (leakTimer !== null) return;
    leakTimer = setInterval(() => {
      leakedScreens.push({ openedAt: Date.now(), rows: allocateMb(LEAK_MB_PER_TICK) });
      if (leakedScreens.length * LEAK_MB_PER_TICK >= LEAK_LIMIT_MB) stopLeak();
      allocateMb(LEAK_MB_PER_TICK); // short-lived garbage, so the heap also saws up and down
    }, LEAK_TICK_MS);
    setStatus((s) => ({ ...s, running: true, startedAt: s.startedAt || Date.now() }));
  }

  function stopLeak() {
    if (leakTimer !== null) clearInterval(leakTimer);
    leakTimer = null;
    setStatus((s) => ({ ...s, running: false }));
  }

  function release() {
    stopLeak();
    leakedScreens.length = 0;
    heavyScreen = null;
    setStatus((s) => ({ ...s, leakedMb: 0, heavy: false, startedAt: null }));
  }

  function loadHeavyScreen() {
    heavyScreen = allocateMb(HEAVY_SCREEN_MB);
    setStatus((s) => ({ ...s, heavy: true }));
  }

  const minutes = status.startedAt !== null ? Math.floor((Date.now() - status.startedAt) / 60000) : 0;

  return (
    <div>
      <button onClick={startLeak} disabled={status.running}>Start memory leak (+{LEAK_MB_PER_TICK} MB / {LEAK_TICK_MS / 1000}s)</button>
      <button onClick={stopLeak} disabled={!status.running}>Stop leak</button>
      <button onClick={loadHeavyScreen}>Load heavy screen once ({HEAVY_SCREEN_MB} MB, not a leak)</button>
      <button onClick={release}>Release all memory</button>
      <p>
        {status.heapMb === undefined
          ? 'Reading heap size…'
          : status.heapMb === null
          ? 'This browser has no performance.memory, so leak detection is off (Chromium only).'
          : `JS heap: ${status.heapMb} MB · leaked: ${status.leakedMb} MB${status.running ? ` (running ${minutes} min)` : ''}${status.heavy ? ' · heavy screen loaded' : ''}`}
      </p>
      <p>
        Keep this tab open and visible. With this demo's 5 s memory polling, a running leak is reported as{' '}
        <code>MemoryLeakSuspected</code> after about 2–3 minutes (about 10 minutes with the default 30 s polling).
        A heavy screen loaded once is not reported.
      </p>
    </div>
  );
}
