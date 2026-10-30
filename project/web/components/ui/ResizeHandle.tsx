'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/** Pixels one arrow-key press moves a handle (Shift: KEY_STEP_LARGE). */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export interface PanelWidth {
  /** Current width in px. */
  width: number;
  /** Sets the width (clamped), and remembers it when `save` is true. */
  setWidth: (width: number, save?: boolean) => void;
  /** Back to the default width (and forgets the saved one). */
  reset: () => void;
  min: number;
  max: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A panel width the user can change, kept per browser in localStorage.
 * `maxWidth` may be a function of the window width; it is re-read on resize.
 */
export function usePanelWidth(storageKey: string, defaultWidth: number, minWidth: number, maxWidth: number | (() => number)): PanelWidth {
  const readMax = useCallback(() => Math.max(minWidth, typeof maxWidth === 'function' ? maxWidth() : maxWidth), [minWidth, maxWidth]);
  const [width, setState] = useState(defaultWidth);
  const [max, setMax] = useState(typeof maxWidth === 'number' ? maxWidth : defaultWidth);

  useEffect(() => {
    const fit = () => {
      const m = readMax();
      setMax(m);
      setState((w) => clamp(w, minWidth, m));
    };
    fit();
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (saved > 0) setState(clamp(saved, minWidth, readMax()));
    } catch { /* storage blocked */ }
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [storageKey, minWidth, readMax]);

  const setWidth = useCallback((next: number, save = false) => {
    const w = clamp(next, minWidth, readMax());
    setState(w);
    if (save) try { localStorage.setItem(storageKey, String(w)); } catch { /* storage blocked */ }
  }, [storageKey, minWidth, readMax]);

  const reset = useCallback(() => {
    setState(clamp(defaultWidth, minWidth, readMax()));
    try { localStorage.removeItem(storageKey); } catch { /* storage blocked */ }
  }, [storageKey, defaultWidth, minWidth, readMax]);

  return { width, setWidth, reset, min: minWidth, max };
}

/**
 * A vertical drag handle on a panel's edge. `edge` is the side of the panel it
 * sits on: dragging away from the panel makes it wider. Arrow keys resize too,
 * double-click restores the default width.
 */
export function ResizeHandle({ panel, edge, label }: { panel: PanelWidth; edge: 'left' | 'right'; label: string }) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const direction = edge === 'right' ? 1 : -1;

  const end = () => {
    if (!drag.current) return;
    panel.setWidth(drag.current.width, true);
    drag.current = null;
    document.documentElement.classList.remove('resizing');
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: panel.width, width: panel.width };
    document.documentElement.classList.add('resizing');
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clamp(drag.current.startWidth + (e.clientX - drag.current.startX) * direction, panel.min, panel.max);
    drag.current.width = next;
    panel.setWidth(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    // Right arrow moves the handle right: wider for a handle on a panel's right edge.
    if (e.key === 'ArrowRight') panel.setWidth(panel.width + step * direction, true);
    else if (e.key === 'ArrowLeft') panel.setWidth(panel.width - step * direction, true);
    else if (e.key === 'Home') panel.setWidth(panel.min, true);
    else if (e.key === 'End') panel.setWidth(panel.max, true);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`resize-handle resize-handle-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={panel.width}
      aria-valuemin={panel.min}
      aria-valuemax={panel.max}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={panel.reset}
      onKeyDown={onKeyDown}
    />
  );
}
