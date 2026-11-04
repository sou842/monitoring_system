/**
 * What a project member may do (docs/MEMBERS_AND_CHAT.md). Being a member always
 * allows viewing the project; each permission adds one kind of change. The owner
 * has every permission and alone may delete the project. Shared by the server
 * (checks) and the browser (which buttons to show).
 */
export const PERMISSIONS = ['issues.update', 'issues.delete', 'chat.post', 'ai.use', 'settings.manage', 'key.manage', 'members.manage'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Label and one-line explanation of each permission, for the members screen. */
export const PERMISSION_INFO: Record<Permission, { label: string; text: string }> = {
  'issues.update': { label: 'Resolve issues', text: 'Resolve, ignore and reopen issues' },
  'issues.delete': { label: 'Delete issues', text: 'Delete issues and their events' },
  'chat.post': { label: 'Chat', text: 'Write in the project chat (everyone can read it)' },
  'ai.use': { label: 'Ask AI', text: 'Use the AI assistant on issues' },
  'settings.manage': { label: 'Settings', text: 'Change allowed origins and issue insights' },
  'key.manage': { label: 'API key', text: 'Rotate the project API key' },
  'members.manage': { label: 'Manage members', text: 'Add and remove members and change their permissions' },
};

/** What a newly added member can do unless the person adding them picks otherwise. */
export const DEFAULT_MEMBER_PERMISSIONS: readonly Permission[] = ['issues.update', 'chat.post', 'ai.use'];

/** Whether `value` is a known permission name. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/** A clean permission list (known names, no repeats, in PERMISSIONS order), or null if `value` is not a list of known names. */
export function cleanPermissions(value: unknown): Permission[] | null {
  if (!Array.isArray(value) || !value.every(isPermission)) return null;
  return PERMISSIONS.filter((p) => value.includes(p));
}
