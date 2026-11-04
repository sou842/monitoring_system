# Project members and project chat: plan

Status: **v1 built and verified 2026-11-04** (backend, Members tab, chat page with Pusher + polling fallback; 18 integration tests in `tests/members.test.ts`; real-Chrome check with an owner and a member, both themes, 390 px). Decisions by the user on 2026-11-04:

| Question | Decision |
| --- | --- |
| How is someone added? | By the **email of an existing account**; access is immediate (no email is sent, the app has no email service). |
| Roles | **Owner + Member**, **permission based**: every member gets their own set of permissions. |
| Chat scope (v1) | **One chat channel per project.** No issue threads, reactions, files or pins yet. |
| Realtime | **Pusher** (Channels). Packages `pusher` (server) and `pusher-js` (browser). |

## 1. Data model

**`projects.ownerId`** stays the owner (one per project, existing data needs no migration). The owner implicitly has every permission and is the only one who can delete the project.

**`project_members`** (new), one row per non-owner member:

```ts
{ _id, projectId, userId, permissions: Permission[], addedBy, createdAt, updatedAt }
// unique index (projectId, userId); index (userId) for "my projects"
```

**Permissions** (`lib/permissions.ts`, shared with the browser). Being a member always allows *viewing* the project (issues, events, performance, stats).

| Permission | Allows | Default for a new member |
| --- | --- | --- |
| `issues.update` | resolve / ignore / reopen issues | ✓ |
| `issues.delete` | delete issues (one, selected, or all of a status) | |
| `chat.post` | write in the project chat (everyone can read it) | ✓ |
| `ai.use` | Ask AI on issues | ✓ |
| `settings.manage` | allowed origins, issue insights | |
| `key.manage` | rotate the API key | |
| `members.manage` | add / remove members and change their permissions (never the owner's, never their own) | |

Owner-only, not grantable: delete the project.

**`chat_messages`** (new): `{ _id, projectId, userId, text, mentions: ObjectId[], createdAt, editedAt?, deletedAt? }`, index `(projectId, createdAt)`. Text max 4000 chars, plain text (rendered as text, never HTML). Messages are kept until the project is deleted.

**`chat_reads`** (new): `{ projectId, userId, lastReadAt }`, unique `(projectId, userId)`, for unread counts.

## 2. Access layer (`server/access.ts`)

Every dashboard route already goes through `ownedProject` / `ownedIssue` / `ownedEvent` / `ownedProjectIds`. They become:

- `projectAccess(db, user, projectId)` → `{ project, isOwner, permissions, can(p) }` or `null` (not owner and not member → callers keep answering **404**).
- `issueAccess` / `eventAccess` → the same plus the document.
- `accessibleProjectIds(db, user)` → owned ∪ member.
- A member without the needed permission gets **403 `forbidden`** (they know the project exists).

Route changes:

| Route | Check |
| --- | --- |
| `GET /api/projects` | owned + member projects, each with `role` (`owner`/`member`), `permissions`, `ownerName`, `unreadMessages` |
| `POST ?action=rotate-key` | `key.manage` |
| `PATCH /api/projects` | `settings.manage` |
| `DELETE /api/projects` | owner |
| `PATCH /api/issue`, `DELETE /api/issue`, `DELETE /api/issues` | `issues.update` / `issues.delete` |
| `POST /api/ai/chat` | `ai.use` |
| `GET` issue / issues / event / stats | membership |

Also: deleting an account removes its memberships, chat reads and keeps its messages shown as "Deleted user"; deleting a project removes members, messages and reads; a disabled account can't log in (already) so its memberships are inert. The admin page's project counts stay "owned".

## 3. Members API

`/api/projects/members?projectId=…`

- `GET` → `{ owner: { id, name, email }, members: [{ id, userId, name, email, permissions, addedAt }], canManage }` (any member can see who is in the project).
- `POST { email, permissions? }` → adds an existing active account. Errors: `not_found` "No account with this email" , `already_member`, `is_owner`. Rate-limited (30 adds per user per hour) because it reveals whether an email has an account.
- `PATCH { memberId, permissions }` → replaces permissions.
- `DELETE ?memberId=…` → removes a member. Any member may also remove **themselves** ("Leave project").

## 4. Chat API + Pusher

- `GET /api/chat?projectId=…&before=<id>` → newest 50 messages (older pages with `before`), with author names; also marks the channel read.
- `POST /api/chat { projectId, text }` (`chat.post`) → stores the message, then triggers `message` on the Pusher channel `private-project-<id>`; returns the message. Rate limit 30 messages/user/minute.
- `DELETE /api/chat?id=…` → own message (or the owner) → soft delete, Pusher `message-deleted`.
- `POST /api/chat/read { projectId }` → updates `chat_reads`.
- `POST /api/pusher/auth` → Pusher private-channel auth: logged-in **and** member of that project, else 403.
- `@mentions`: `@Name` typed from a member picker; stored as user ids; shown highlighted (blue `--mention`). (Notifications for mentions: later.)

**Without Pusher env vars** (local dev, tests): the chat page polls `GET /api/chat?after=<id>` every 3 s (15 s when the tab is hidden), so everything works without the service. Env vars: `PUSHER_APP_ID`, `PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER`. The CSP `connect-src` must allow `wss://ws-<cluster>.pusher.com` and `https://sockjs-<cluster>.pusher.com`.

Message payloads on Pusher carry only `{ id, projectId }`-sized data plus the text (Pusher limit 10 KB per event); the server is the source of truth, and a reconnect re-fetches with `after`.

## 5. Frontend

- **Project page** tabs become `Issues` · `Members` · `Settings`.
  - **Members**: owner row (badge `Owner`), member rows (avatar, name, email, permission chips, `⋯` → Edit permissions / Remove). `Add member` (needs `members.manage`): email field + permission checkboxes with the defaults ticked. `Leave project` for members.
  - Buttons the user can't use are hidden (Settings tab only with `settings.manage` or `key.manage`; delete buttons only with `issues.delete`; Ask AI only with `ai.use`); the server checks again.
- **Sidebar**: shared projects appear in the switcher and the Projects list (with a small "shared" marker), `Chats` loses its `Soon` tag and shows the unread count of the active project.
- **`/chats`**: the active project's channel: header `# <project>` + member avatars, message list (grouped by author and day, "New messages" divider), composer (pill, `Enter` sends, `Shift+Enter` new line, `@` member picker), disabled with a note when the user lacks `chat.post`. Right panel (≥1100 px): `Members` list.
- **Projects page**: cards of shared projects show "Shared by <owner>".

## 6. Build order

1. ✅ Plan (this file). Steps 2–6 are done.
2. Backend: permissions module, `project_members`, access layer, route checks, members API, deletion cascade, tests.
3. Frontend: project list with roles/permissions, Members tab, permission-aware buttons.
4. Backend: chat messages + reads + Pusher (server trigger + auth), polling fallback, tests.
5. Frontend: `/chats` page, composer, mentions, unread counts in the sidebar.
6. Browser check (both themes, 390 px), docs (CLAUDE.md, ARCHITECTURE, README env vars).

## 7. Later (not in v1)

Invite links for people without an account, email notifications, mention notifications, issue threads, reactions, files, transferring ownership, teams (DESIGN.md rail).

## 8. Differences from the plan above

- Reading the chat is done by `GET /api/chat` itself (no separate `/api/chat/read`); posting also marks it read for the author.
- Pusher events carry **only ids** (`{ id, projectId }`): browsers fetch the text through the API, which checks access. A removed member whose page is still open therefore learns nothing (Pusher cannot kick a subscribed socket).
- Delegation rule (production review 2026-11-04): a member with `members.manage` can only **grant permissions they hold themselves**, and cannot change or remove another member manager (only the owner can). Otherwise they could add a second account of their own with more power than they were given.
- **Chat page (2026-11-04, user feedback):** no channel header card; the chat uses the whole page below the top bar (`Page fill`), a centred 3xl column with a floating composer. Typing `@` picks a person (the name is highlighted inside the composer by a mirrored layer behind a transparent textarea, so the caret lines up); typing `/` searches the project's issues and attaches them as cards (max 5, stored as `issueIds` on the message, validated to be of the same project, shown live with current status and count; an empty message is allowed when an issue is attached).
- Polling mode does not show deletions made by other people until reload (only new messages are fetched); live mode does.
- The chat page shows the **active project's** channel (the sidebar switcher picks it); there is no channel list yet.
- Setup: `PUSHER_APP_ID`, `PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER` in `.env.local` and on Vercel (the public ones are baked in at build time). Without them the chat polls.
