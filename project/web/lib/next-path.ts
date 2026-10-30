/**
 * Where to go after logging in: the page that asked for the login (`?next=`),
 * if it is a page of this site, otherwise the dashboard. Never another site
 * (`//evil.test`) and never the login pages themselves.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/dashboard';
  if (/^\/(login|signup)(?:[/?#]|$)/.test(next)) return '/dashboard';
  return next;
}
