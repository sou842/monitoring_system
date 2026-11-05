# Dashboard design pattern (draft 2)

Status: **draft, nothing implemented yet.** Two references: (1) a soft "AI workspace" look (calm neutrals, big radii, pills, one warm gradient), (2) a Slack-style team workspace (team rail, channel sidebar, threads, info panel). This file says **where things go and what the text says**. Colours and sizes are starting values to adjust while building.

Planned features this layout must hold: **teams with access to projects**, a **common AI panel** (not tied to one issue), a **team chats** section, plus the existing dashboard, issues, performance, projects, account and admin pages.

Text in `code style` below is the **exact label** to show.

---

## 1. App frame

One rounded container (radius 24) floats on a soft gradient page background. Inside it, four regions from left to right:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ┌────┐ ┌───────────────┐ ┌─────────────────────────────────┐ ┌──────────────┐  │
│ │RAIL│ │ SIDEBAR       │ │ MAIN                            │ │ RIGHT PANEL  │  │
│ │64px│ │ ~230 px       │ │ top bar                         │ │ ~320 px      │  │
│ │    │ │               │ │ page content                    │ │ (optional,   │  │
│ │    │ │               │ │ composer / AI input (chat pages)│ │  per page)   │  │
│ │ me │ │               │ │                                 │ │              │  │
│ └────┘ └───────────────┘ └─────────────────────────────────┘ └──────────────┘  │
└────────────────────────────────────────────────────────────────────────────────┘
```

| Region | Job | Visible |
| --- | --- | --- |
| Rail | Switch team | Always (hidden on mobile) |
| Sidebar | Navigation, or the channel list in Chats | Always (drawer on mobile) |
| Main | The page | Always |
| Right panel | Context for the current page (Info, AI chat, history) | Only when the page uses it; resizable, closable (Esc) |

The right panel is a **separate floating white card**, not a column joined by a border. On mobile (< 768 px) the container goes full-bleed, the sidebar becomes a drawer, and the right panel becomes a full-screen overlay.

---

## 2. Rail (far left): teams

Top to bottom:

| Item | Detail |
| --- | --- |
| Team icons | One square icon per team (first letter on a coloured tile). Active team = white tile with a soft shadow and a dark bar on the left. Tooltip = team name. |
| `+` | Opens "Create team". |
| (bottom) Avatar | Your avatar. Click = menu: `Account`, `Theme: Light / Dark`, `Log out`. |

The first icon is always **Personal** (your own projects). Switching team changes the projects, chats and AI history shown everywhere.

---

## 3. Sidebar: navigation (Workspace mode)

Header: **team name ▾** (menu: `Team settings`, `Invite people`, `Switch team`, `Create team`) and a search icon (opens `Search issues, projects, chats…`, shortcut `Ctrl K`).

```
Conceptzilla ▾                      🔍
─────────────────────────────────────
✦ Assistant                    NEW
⌂ Home
▦ Dashboard
◫ Projects
◔ Performance
✉ Chats                        3
🔔 Notifications               8

Favorites                         ▾
  ◫ Assistant app
  # Appzillon admin

Projects                       +  ▾
  ◫ Assistant app            12
  ◫ Appzillon admin           4
  ◫ Web demo

Team                              ▾
  ☺ Members
  ⚙ Team settings

Admin                             ▾   (admins only)
  ⛨ Admin
─────────────────────────────────────
 (avatar) Sourav S.
          sourav@company.com
```

Labels and behaviour:

| Label | Goes to | Note |
| --- | --- | --- |
| `Assistant` + `NEW` badge | `/assistant` | The common AI chat (section 6) |
| `Home` | `/home` | Greeting + suggestion cards + AI input (section 5) |
| `Dashboard` | `/dashboard` | Charts and recent issues for the team |
| `Projects` | `/projects` | All projects of the team |
| `Performance` | `/performance` | Page loads and API latency |
| `Chats` | `/chats` | Team chats (section 7); count = unread |
| `Notifications` | `/notifications` | Mentions, new regressions; count = unread |
| `Favorites` | the item | Pinned projects and channels; star toggle on any project |
| `Projects` list | `/projects/[id]` | Number = open issues; `+` = `New project` |
| `Members` | `/team/members` | Section 9 |
| `Team settings` | `/team/settings` | Name, project access, danger zone |
| `Admin` | `/admin` | Only for the `admin` role |

- Active item = **white pill with a soft shadow** (no coloured bar). Section labels are small, semibold, with a collapse chevron. Count badges are small grey pills; unread mentions use a black pill.
- Bottom card (translucent, slightly blurred): avatar, **name**, **email**; click goes to `Account`.

---

## 4. Sidebar: Chats mode

When the user opens `Chats`, the same sidebar column switches to the channel list (Slack-style). A `← Workspace` link at the top goes back.

```
Conceptzilla ▾                      🔍
─────────────────────────────────────
← Workspace
✦ Assistant                    NEW
✎ Drafts
☆ Saved items
✉ Inbox                        8
💬 Direct messages             1

Favorites                         ▾
  (avatar) Sophia Wilson      2
  # front-end                 4

Channels                       +  ▾
  # general                   1
  # front-end                 4
  ◫ Assistant app                   ← one channel per project
      ↳ TypeError in login          ← an issue thread under it
      ↳ HttpError 500 /api/profile
  ◫ Appzillon admin
  # announcements
  # events
─────────────────────────────────────
 (avatar) Sourav S.
```

- `#` = a normal channel. The project icon = a project channel (created with the project). `↳` = an **issue thread** (created when someone discusses an issue).
- Selected thread = grey rounded row. Unread = bold name + count badge.

---

## 5. Home page

Content is centred vertically, the AI input is anchored at the bottom.

```
                         ✦  (gradient mark)

                  Welcome, Sourav!
              How can I help you today?

 ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
 │ ★ Investigate   │ │ ✎ What changed  │ │ ▤ Summarise     │
 │ an issue        │ │ this week?      │ │ my team's       │
 │ Pick an issue   │ │ New and         │ │ errors          │
 │ and ask why it  │ │ regressed       │ │ Top issues,     │
 │ happened        │ │ issues by       │ │ users affected  │
 │                 │ │ version         │ │ and trends      │
 └─────────────────┘ └─────────────────┘ └─────────────────┘

 ┌──────────────────────────────────────────────────────────┐
 │ ✦ Ask about your projects, issues or performance…        │
 │ [📎 Attach context] [⚙ Options]                 (🎤) (↑) │
 └──────────────────────────────────────────────────────────┘
```

The three cards start a chat in the common AI panel with a prefilled question. `Attach context` picks a project, an issue and a time range.

---

## 6. Assistant page (common AI chat)

Main = the conversation; right panel = chat history.

**Main**
- Header: `Assistant` and a scope chip, for example `Project: Assistant app · Last 7 days ▾`. The chip shows exactly what the AI can see.
- Messages centred at ~720 px. Reasoning and tool steps are folded (same AI Elements components as the issue panel).
- Composer (pill-shaped box): text on top; below it `📎 Attach context`, `⚙ Options` on the left; round black send button on the right. Placeholder: `Ask about your projects, issues or performance…`
- Hint under the composer: `Press Enter to send`.

**Right panel: `Chat history`**
```
Chat history                        [🗑]
┌──────────────────────────────────┐
│ 🔍 Search chats…                 │
└──────────────────────────────────┘
☐ Login TypeError            2h ago
  Why does the login screen…
  (avatar)
☐ Slow /AppzillonWeb         3h ago
  Is the slowness on every…
  (avatar)
              …
        [ Create new chat ]            ← black pill, pinned at the bottom
```

The issue page keeps its own `Ask AI` panel (the issue is its context). Both use the same chat components.

---

## 7. Chats page (team chats)

Sidebar = Chats mode (section 4). Main = the open thread. Right panel = Info.

**Main: thread**
- Breadcrumb header: `# Assistant app / TypeError in login` with icons: `⋯` menu, `✦` ask AI about this thread, `ⓘ` toggle the info panel.
- Message: avatar, **name**, time (`2h ago`), text. `@name` mentions are blue. Reactions under the message (`👍 2`, add-reaction button).
- **Issue card** in a message (when someone pastes an issue link): issue icon, `TypeError: Cannot read properties of undefined`, `Assistant app · 24 events`, status badge, and a `Quick view` button (opens the issue in a modal).
- Composer (floating box): text; typing `@` shows a `Members` picker (and `Assistant`). Toolbar icons: `✦` AI, `@` mention, `😊` emoji, `📎` attach. Buttons: `Discard`, `Send` (black). Placeholder: `Message # Assistant app…`

**Right panel: tabs `Info` · `Pins` · `Files` · `Links`**

```
[ Info | Pins | Files | Links ]

Main info
  Creator            (avatar) Andrew M.
  Created            28 May
  Status             ● Active
  Linked issue       TypeError in login  ›
  Occurrences        24  ›

Linked threads
  # front-end                      4
  # ui-kit design standards

Thread activity
  ▪▪▫▪▪▪▫▫▪▪▪▪▪▫▪▪                  ← small activity strip

Members  9                    [+] [⇅]
  (avatar) Daniel Anderson     [Owner]
  (avatar) Andrew Miller       [Admin]
  (avatar) William Johnson     [Member]
  Offline
  (avatar) Sophia Wilson       [Viewer]
```

For an issue thread, `Main info` also shows the issue's `Status` (`Open` / `Resolved` / `Regressed`) and `First seen` / `Last seen`.

---

## 8. Page layouts inside Main

| Page | Layout |
| --- | --- |
| `Dashboard` | Top bar; row of 4 `StatCard`s (`New issues`, `Open issues`, `Users affected`, `Events`); chart card (24 h / 7 d toggle); `Recent issues` table card |
| `Projects` | Header with `New project`; grid of project cards (name, open issues, last event, platform badges) |
| `Project` | Header + tabs `Issues` · `Settings` · `Keys` · `Insights`; filter pills (status, environment, level, search); issue list |
| `Issue` | Title, status pill, `Resolve` / `Ask AI`; summary rows; "What happened", "Where to look", "Last moments", stack, raw JSON; **right panel = Ask AI** |
| `Performance` | Vitals cards; latency chart; tables `Endpoints` and `Pages`; detail view |
| `Account` | Cards: Profile, Password, Sessions, Danger zone |
| `Admin` | KPI cards; users table |

Top bar inside Main: left = page title or breadcrumb (`Team › Project › Issue`); right = `Refresh`, bell, and the right-panel toggle.

---

## 9. Team pages

**Members (`/team/members`)**
- Header: `Members` and `Invite people`.
- Table: avatar + name, email, role badge (`Owner` · `Admin` · `Member` · `Viewer`), projects (count), last active, `⋯` (change role, remove).
- `Invite people` dialog: email field, role select, `Send invite`.

**Team settings (`/team/settings`)**
- Cards: `Team name`; `Project access` (list of projects with a toggle or role per project); `Danger zone` (`Delete team`).

Roles (starting proposal): `Owner` (everything, billing-like actions, delete team) · `Admin` (manage members and projects) · `Member` (view and resolve issues, chat, use AI) · `Viewer` (read only; no AI or chat posting).

---

## 10. Visual tokens (starting values)

| Token | Light | Dark |
| --- | --- | --- |
| Page background | grey → peach gradient | dark grey → deep warm gradient |
| App container | `#f4f4f5` | `#14161c` |
| Sidebar | `#f7f7f8` (slightly lighter than the container) | `#181b22` |
| Card / right panel | `#ffffff` | `#1b1e26` |
| Input / composer | `#ffffff`, hairline border | `#20242d` |
| Text | `#111` | `#eef0f6` |
| Muted text | `#888` | `#8b94a8` |
| Mention text | blue `#2f6fed` | `#6c9bff` |
| Primary button | black pill, white text | white pill, black text |
| Accent | warm gradient (peach → pink → lavender): hero mark and background only |
| Status | green / amber / red kept (needed for issues); badges are soft tints (e.g. green text on pale green) |
| Role badges | Owner = lavender, Admin = peach, Member = pale blue, Viewer = pale grey |

- **Radii:** container 24 · cards 16 · inputs and composer 20 · buttons, chips, search, badges = full pill.
- **Shadows:** very soft and wide, e.g. `0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.04)`; almost no borders.
- **Type:** Inter/system sans. Greeting ~32 px semibold; body 13–14 px; small labels 12 px; monospace only for code and ids.
- **Spacing:** 8 px grid; 16 px inside cards; 24–32 px between sections; sidebar rows ~32 px high.
- **Avatars:** circles, 24 px in lists, 36 px in messages; stacked up to 3 with `+n`.

---

## 11. Reusable components

`AppFrame` · `TeamRail` · `Sidebar` (`NavSection`, `NavItem`, `ChannelItem`) · `TopBar` · `RightPanel` (resizable, closable, tabs) · `SuggestionCard` · `ChatInput` (pill) · `Composer` (with `@` picker) · `ChatList` · `MessageList` · `IssueCard` · `Avatar` / `AvatarStack` · `PillButton` (primary, secondary, icon) · `Badge` / `RoleBadge` · `StatCard` · `EmptyState` · `ScopeChip`.

Reuse, don't rewrite: AI Elements chat components, `ResizeHandle`, dialogs, toasts, `ColumnChart`, `useApi` cache.

---

## 12. Open questions (decide before building)

1. **Scope:** use the Slack-style shell (rail + sidebar) for the **whole app**, or only inside `Chats`? (Draft assumes the whole app, with the sidebar switching to Chats mode.)
2. **Gradient background:** keep it, or a plain neutral with the gradient only on the hero mark? (A strong gradient can tire the eyes in an all-day tool.)
3. **Primary colour:** black pills as in the references, or keep the blue accent?
4. **Team chats:** people only, or people + AI in the same thread (`@Assistant`)?
5. **Realtime:** polling every few seconds at first, or a managed realtime service (needs a new package/service; Vercel functions can't hold websockets)?
6. **AI chat storage:** common AI chats stay in the browser, or move to the server (needed for shared or team history)?
7. **Home:** landing page after login, or keep `/dashboard`?
8. **Density:** big tables (issues, endpoints) keep the compact rows inside the soft cards?
9. **Scope of v1 chats:** channels + threads + `@mentions` + issue cards + members. Reactions, pins, files, drafts, saved items later?

---

## 13. Suggested build order

1. Tokens, `AppFrame`, `TeamRail`, `Sidebar` (restyle only, same pages).
2. Restyle existing pages into the new cards.
3. Team data model and access checks (backend first), team switcher, `Members`, `Team settings`.
4. `Home` + `Assistant` page + chat history (common AI).
5. `Chats`: channels, threads, composer, info panel (backend: messages, unread, mentions).
