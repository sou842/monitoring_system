'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A small popover menu: `trigger` draws the button (it gets `open` and `toggle`),
 * `children` are the items. A click on anything inside the menu closes it; so do
 * Escape and a click outside. `placement` says where the popover opens.
 */
export function Menu({ trigger, children, placement = 'bottom-start', className = '' }: {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode;
  placement?: 'bottom-start' | 'right-end' | 'top-stretch';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useCallback(() => setOpen((was) => !was), []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`menu-wrap ${className}`.trim()} ref={wrap}>
      {trigger({ open, toggle })}
      {open ? <div className={`menu menu-${placement}`} role="menu" onClick={() => setOpen(false)}>{children}</div> : null}
    </div>
  );
}
