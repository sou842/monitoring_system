import { MAX_CSS_PATH_DEPTH } from '../constants';

/** Returns true if `el` or an ancestor matches any selector. Invalid selectors are ignored. */
export function isMasked(el: Element, selectors: readonly string[]): boolean {
  for (let i = 0; i < selectors.length; i++) {
    try {
      if (el.closest(selectors[i]) !== null) return true;
    } catch (_e) {
      // Invalid selector supplied by the host app; skip it.
    }
  }
  return false;
}

/** Short CSS path such as `form#checkout > div.actions > button.primary`. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current !== null && parts.length < MAX_CSS_PATH_DEPTH) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(part + '#' + current.id);
      break;
    }
    const className = typeof current.className === 'string' ? current.className.trim() : '';
    if (className.length > 0) part += '.' + className.split(/\s+/).slice(0, 2).join('.');
    parts.unshift(part);
    if (current.tagName === 'BODY') break;
    current = current.parentElement;
  }
  return parts.join(' > ');
}
