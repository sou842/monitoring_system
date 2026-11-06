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
- **Chat v2 (2026-11-04, user feedback: "take inspiration from WhatsApp", optimistic sending, smaller errors):** WhatsApp-style bubbles (own = green on the right with the time and a status icon inside; others = white with a coloured name on the first message of a group; day chips, patterned background, round composer bar); **optimistic sending**: the message shows at once with a clock, is delivered in order in the background (`useChat` pending queue), and a failure is a small "Not sent · Retry · Delete" line under that bubble (no banner; the first-page load error is a small chip with "Try again"); **replies** (`replyTo`, quoted inside the bubble, click to jump), **reactions** (6 fixed emoji in `lib/chat.ts`, toggle per person, `message-updated` over Pusher), hover bar (react · reply · copy · delete; tap on phones), an **"N unread messages" divider** with the list starting at the first unread (`lastReadAt` from `GET /api/chat`), a jump-to-latest button with a count of new messages, and an emoji picker. The first-page request is shared across React StrictMode's double effect so the unread time isn't overwritten.
- **Chat v3 (2026-11-05, UI only; user: "corporate use, 10M+ users, needs a standard"):** replaces the WhatsApp bubbles with Slack-style flat rows. Avatar + name + time on a group's first message; a group breaks on a new person, a new day or a pause over 5 min (`GROUP_GAP_MS`). Names are in the text colour, not random hues (contrast). No read ticks, because nothing tracks reads. Code is split into `components/dashboard/chat/` (`ChannelHeader`, memoised `MessageRow` with a stable actions object, `Composer` with its own state so typing doesn't re-render the list, `MessageBody`, `shared`). Pure logic is in `lib/chatText.ts` (tests in `tests/chatText.test.ts`): a small Markdown subset (code blocks with copy, inline code, bold, italic, strike, quotes, bare http(s) links opened with `noopener noreferrer nofollow`) rendered as React elements, never HTML. There is no `[text](url)` syntax, so a link always shows its address (phishing). Hover/focus toolbar: 3 quick reactions, add reaction, reply, more (copy text, copy link `/chats?project=<id>#m-<id>`, delete). You can react to your own messages. On touch screens, tapping a message selects it. Sticky day labels, red "New" line, older messages load as you scroll up (keeps your place), "N new messages" pill, search over loaded messages (says when older ones aren't loaded), offline banner. Composer: format buttons + Ctrl+B/I/E, Ctrl+Shift+X, Ctrl+Shift+9; Enter inside an open fence adds a line; drafts per project in sessionStorage; counter near 4000 chars. Accessibility: `role=log`, arrow keys between messages, menus with arrow keys + Escape (focus returns), combobox semantics on the @// picker, `dir=auto` for RTL text, forced-colours fallback for the mention mirror, reduced motion respected. New tokens `--mention-fg/-bg`, `--mention-me`, `--mention-me-line`, `--unread` in both themes.
- **Chat v4 (2026-11-05, UI only; user: "clone the Telegram web chat look, background, behaviour, smoothness"):** messenger-style bubbles replace the Slack rows. Written from scratch with our own assets (Telegram Web is GPL-3.0 and its wallpapers/icons are brand assets, so none of its code or files are used). Scoped stylesheet `components/dashboard/chat/chat.css` (everything under `.tg`, tokens for both themes, imported by ChatView), own doodle tile `public/chat/pattern.svg` + bubble tail `public/chat/tail.svg`. `Wallpaper.tsx`: 4-colour gradient on a 48 px canvas (scaled up = smooth blur), points glide to the next of 8 spots on every send (520 ms, skipped with reduced motion), redrawn on theme change. Bubbles: yours right (light #effddf / dark #7766d2), others left with the sender name in a per-person colour (`peerColor(id)`, 7 readable colours per theme) and a gradient round avatar stuck to the bottom of the group (`ChatAvatar`); grouped corners, tail on the last bubble; time + clock/check/alert inside the bubble (invisible copy at the end of the last line keeps room: `MessageBody` `trailing`). Single check only (nothing tracks reads). Reply quotes use the quoted person's colour (`replyTo.userId` added to the API view). Reactions are chips inside the bubble. **Behaviour:** right-click / long-press (420 ms) / Enter / Menu key / Shift+F10 opens `ContextMenu.tsx` (portal into body inside its own `.tg`, frosted glass, reaction strip above, flips at screen edges, closes on scroll/resize/Escape/outside press); right-click on a link or selected text keeps the browser menu; double-click replies; swipe left replies on touch; failed messages get a red ! button (Try again / Copy / Discard). Motion: new bubbles slide in (others' new messages and your pending ones; a confirmed copy doesn't replay), menu scales in, reaction emojis pop, jump highlight pulses full width, date pills are frosted and the one stuck on top fades 0.9 s after scrolling stops, round jump-to-latest button with a count badge, "Unread messages" full-width bar. Composer: floating card with a tail + separate round send button (54 px); emoji left, format + share-issue right; Tiptap features unchanged. Column max 740 px. Verified 2026-11-05: typecheck, 187/187 tests (local mongod), headless Chrome on a seeded dev server (scratchpad `tg-e2e.mjs`, 25/25: layout, tails, unread bar, day pills, wallpaper paint + dark repaint, time placement, right-click menu + reaction, double-click reply, send + animation + check, jump button, 1440/390 px both themes, no overflow). Still to do: the chat-list pane (projects with last message preview; needs `lastMessage` on `/api/projects`), slide transition between list and chat on phones.
- **Noto emoji (2026-11-05, user chose Google Noto Animated Emoji over Fluent 3D; Telegram's own reaction art is not licensed for reuse):** `Emoji` in `components/dashboard/chat/shared.tsx` draws emoji from `public/chat/emoji/<codepoints>.svg` (Noto Emoji, Apache 2.0, 33 files: the 6 reactions + the composer panel) and `.webp` (Noto Animated Emoji, CC BY 4.0, the 6 reactions only, 90–620 KB each, 1.6 MB total, loaded only when the menu opens or a chip is hovered). The reaction strip in the menu always animates; reaction chips animate while hovered/focused; the composer panel is still; reduced motion → still. Unknown emoji fall back to the system glyph. Credit + sources in `public/chat/emoji/LICENSE.txt` (CC BY needs attribution: keep it, and mention it wherever third-party notices are listed). Message text itself still uses system emoji.
- **Composer on Tiptap (2026-11-05, user: "very close to the Teams input, no file upload"):** `components/dashboard/chat/Composer.tsx`, loaded with `next/dynamic` (`ssr: false`, a same-looking placeholder while it loads). It opens as a plain one-line box (format, emoji, share issue, send). Inside it is a rich editor: Markdown input rules (`**`, `_`, ``, ```` + space, `> `, `- `, `1. `), the StarterKit shortcuts, mention chips (`@`; Backspace removes one whole; you can't mention yourself) and `/` issue cards. Enter sends in the small box; it adds a line inside lists and code blocks and on touch screens; Ctrl/Cmd+Enter always sends. **Format** opens the toolbar (bold, italic, strike, lists, quote, code, code block, mention, clear) and a taller box where Enter adds a line. Links autolink (http/https only; other schemes are refused). Headings, underline and rules are off (the chat can't show them). Pasted or dropped files are ignored (no uploads). Drafts are the editor JSON in sessionStorage. Sending: `docToMarkdown(editor.getJSON())` in `lib/chatText.ts` gives the chat Markdown + mention ids, so the API and the message renderer are unchanged; the renderer gained lists (`- ` / `1. `, nested by 2 spaces).
- **Composer on Tiptap (2026-11-05, user: "very close to the Teams input, no file upload"):** `components/dashboard/chat/Composer.tsx`, loaded with `next/dynamic` (`ssr: false`, with a placeholder that looks the same while it loads). It opens as a plain one-line box (format, emoji, share issue, send). Inside it is a rich editor: Markdown input rules (`**`, `_`, backticks, ``` + space, `> `, `- `, `1. `), the StarterKit shortcuts, mention chips (`@`; Backspace removes one whole; you can't mention yourself) and `/` issue cards. Enter sends in the small box; it adds a line inside lists and code blocks and on touch screens; Ctrl/Cmd+Enter always sends. **Format** opens the toolbar (bold, italic, strike, lists, quote, code, code block, mention, clear) and a taller box where Enter adds a line. Links autolink (http/https only; other schemes are refused). Headings, underline and horizontal rules are off (the chat can't show them). Pasted or dropped files are ignored (no uploads). Drafts are the editor JSON in sessionStorage. Sending: `docToMarkdown(editor.getJSON())` in `lib/chatText.ts` gives the chat Markdown + mention ids, so the API and the message renderer are unchanged; the renderer gained lists (`- ` / `1. `, nested by 2 spaces).
- Polling mode does not show deletions made by other people until reload (only new messages are fetched); live mode does.
- The chat page shows the **active project's** channel; the sidebar's Channels group lists the projects with unread counts.
- Setup: `PUSHER_APP_ID`, `PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER` in `.env.local` and on Vercel (the public ones are baked in at build time). Without them the chat polls.

- **Editing happens in the message box (2026-11-06, user: "edit all messages, from the input, not from the message").** The inline editor in the bubble is gone. Edit (menu) on any of your own sent messages, including ones that are only issue cards, loads it into the composer: `markdownToDoc()` in `lib/chatText.ts` turns the stored text back into editor JSON (marks, lists, quotes, code blocks, mention chips for known people) and the attached issues appear as removable cards. An "Editing message" bar replaces the reply bar, the send button becomes a check, Enter / the check saves, Esc or the X cancels, the edited bubble gets an outline. Your unsent draft is set aside and comes back when the edit ends (drafts are not written while editing). Saving an unchanged message just closes the edit. `PATCH /api/chat { id, text, issues? }`: `issues` replaces the attached issues (omitted = unchanged; empty text is allowed when issues remain); `editedAt` is set when text or issues change. Known limit: blank lines right next to a code block are not kept when a message is reopened (the renderer drops them too).
