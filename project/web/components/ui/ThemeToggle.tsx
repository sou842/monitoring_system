'use client';

import { useEffect, useState } from 'react';
import { Icon } from './Icon';

type Theme = 'dark' | 'light';
const THEME_KEY = 'et_theme';
const THEME_EVENT = 'et-theme-change';

/**
 * Runs before first paint (inline in <head>, see app/layout.tsx) so the page
 * never flashes the wrong theme: the saved choice, else the system setting.
 */
export const THEME_SCRIPT = `(function(){var t=null;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.setAttribute('data-theme',t)})();`;

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Dark / light switch. Every toggle on the page stays in sync. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
    const sync = () => setTheme(currentTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  const choose = (next: Theme) => {
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage blocked: the theme just isn't remembered.
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button type="button" className={theme === 'dark' ? 'active' : ''} aria-label="Dark theme" title="Dark" onClick={() => choose('dark')}>
        <Icon name="moon" />
      </button>
      <button type="button" className={theme === 'light' ? 'active' : ''} aria-label="Light theme" title="Light" onClick={() => choose('light')}>
        <Icon name="sun" />
      </button>
    </div>
  );
}
