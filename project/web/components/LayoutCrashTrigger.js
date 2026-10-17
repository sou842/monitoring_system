'use client';

import { useEffect, useState } from 'react';

export const CRASH_LAYOUT_KEY = 'crash-layout';

/** Demo only: throws inside the root layout once, after "Crash root layout" is clicked. */
export default function LayoutCrashTrigger() {
  const [crash, setCrash] = useState(false);
  useEffect(() => {
    if (sessionStorage.getItem(CRASH_LAYOUT_KEY)) {
      sessionStorage.removeItem(CRASH_LAYOUT_KEY);
      setCrash(true);
    }
  }, []);
  if (crash) throw new Error('Root layout crashed');
  return null;
}
