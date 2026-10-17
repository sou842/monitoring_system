/**
 * Keeps a copy of every SDK event in localStorage so the Issues page can show
 * them. Temporary, until a real backend and dashboard exist.
 */
const KEY = 'web_issues';
const MAX_ISSUES = 30;
const CHANGE_EVENT = 'web-issues-changed';

export function getIssues() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveIssue(event) {
  let issues = [event, ...getIssues()].slice(0, MAX_ISSUES);
  try {
    localStorage.setItem(KEY, JSON.stringify(issues));
  } catch {
    // Storage full (screenshots are large): keep the newest screenshot only.
    issues = issues.map((e, i) => (i === 0 ? e : { ...e, screenshot: null }));
    try {
      localStorage.setItem(KEY, JSON.stringify(issues));
    } catch {
      return;
    }
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearIssues() {
  localStorage.removeItem(KEY);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Calls `onChange` when issues change in this tab or another tab. */
export function subscribe(onChange) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}
