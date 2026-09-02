# Kusoma Prototype — Build Prompt for Claude Code

## 0. Context

You are working in `/Users/bryanwilliam/Projects/hackathon`, a monorepo-ish
folder with two sibling packages:

- `kusoma-client/` — an Expo (React Native) app. **It is currently an
  unmodified copy of a different product called Tabibu** (a clinical/EMR
  system for hospitals). `package.json` still says `"name": "tabibu"`,
  `app.json` still says `"name": "Tabibu"` / `"slug": "Tabibu"` /
  `"scheme": "tabibu"`. Every screen, store, and type in it is EMR domain
  logic (patients, visits, triage, orders, billing, pharmacy, laboratory,
  inventory, clinical concepts, CASL-based RBAC). None of that domain logic
  belongs in the new product — but the underlying infrastructure (UI
  component kit, theming, navigation shell, HTTP client, secure storage) is
  solid, generic, and worth keeping.
- `kusoma-server/` — currently **empty**. This needs to be built from
  scratch.

There is also a sibling sister project at `/Users/bryanwilliam/Projects/Tabibu/backend/tabibu-server`
— a mature Go backend for Tabibu. You won't reuse its code directly (wrong
language, wrong domain), but its **pub/sub architecture is exactly the
pattern to imitate** for Kusoma's event system and real-time chat sync — see
§6, which is written directly off of it.

The new product is **Kusoma**, described in full below. Your job is to turn
`kusoma-client` from "Tabibu in disguise" into the real Kusoma frontend, and
to build `kusoma-server` as a working backend, per this spec.

Read this entire document before writing any code. Where you have to make a
judgment call not covered here, state your assumption in a short comment or
commit message and proceed — don't block on it unless it's genuinely
irreversible (e.g. a schema decision that's expensive to change later).

Note: `kusoma-client`'s git repo exists but has **zero commits** — everything is
untracked and there is no baseline to diff against. Commit early so the Tabibu
→ Kusoma pruning is reversible.

---

## 0.1 Revision Status

This document is at **Revision 2**. Four things changed from Revision 1, and
they cut across almost every section — read this table before assuming you
remember what a section says.

**What changed in Revision 2, and why:**

1. **Unified identity.** `tutors`, `students`, and `guardians` were three
   parallel tables with duplicated `phone` / `telegram_user_id` /
   `password_hash` / `display_name` columns and no role concept. They are now
   one `users` table plus `roles` / `user_roles` / `permissions` /
   `role_permissions`, and the two ownership FKs (`students.tutor_id`,
   `guardians.student_id`) are now one `user_relationships` table. Adding a
   principal is a seed row, not a table plus a code path.
2. **Chat membership is modelled, not implied.** New `chat_participants` table
   links users to chat groups, so the guardian's read access and the bot's
   presence are membership rows rather than role-branching in application code.
3. **AI runs on AWS Bedrock**, not the Anthropic API directly. This is not a
   one-line swap — Bedrock does not support URL image sources, the Files API,
   or structured outputs, and each of those changes real code (§9).
4. **Scaffold-first.** Schema and CRUD are built for real; the AI, Telegram,
   and realtime layers are wired end to end but deliberately thin. The
   contract is §16 — read it before deciding how deep to go on anything.

| § | Section | Status | What changed |
|---|---|---|---|
| 0 | Context | `reworked` | Added the zero-commits note |
| 0.1 | Revision Status | `new` | This table |
| 1 | What Kusoma Is | `reworked` | Scaffold-first added to the out-of-scope block |
| 2 | Users & Roles | `reworked` | Principals → role keys on one `users` table |
| 3 | Architecture | `reworked` | Bedrock in the diagram + stack table; auth row |
| 4.1 | Rebrand the shell | `unchanged` | — |
| 4.2 | Keep as-is | `reworked` | Added the `design.md`-is-stale warning |
| 4.3 | Strip entirely | `unchanged` | — |
| 4.4 | Rebuild / adapt | `reworked` | Session store holds roles + permissions; one login |
| 5 | Database Schema | `reworked` | **Full replacement** — 11 tables, unified identity |
| 6.1 | Broker interface | `unchanged` | — |
| 6.2 | Events (topics) | `reworked` | `studentUserId`, `senderUserId`, `'guardian'` role |
| 6.3 | Subscribers | `reworked` | Broadcaster resolves via `chat_participants` |
| 6.4 | Realtime Hub | `reworked` | Room resolution is now one query, no role fork |
| 7 | Telegram | `reworked` | Room created with the student; webhook *binds* the chat id |
| 8 | REST API | `reworked` | One `/auth/login`; permission-keyed route gating |
| 9 | AI Orchestrator | `reworked` | **Bedrock** — base64 vision, no structured outputs |
| 10 | CBC API Client | `unchanged` | — |
| 11 | Dev Auth Bypass | `reworked` | Seed now covers roles, permissions, bot user |
| 12 | Expo Screens | `reworked` | Single login form; permission-gated affordances |
| 13 | Environment Variables | `reworked` | AWS block replaces `ANTHROPIC_API_KEY` |
| 14 | Build Order | `reworked` | Resequenced as scaffold phases with "done means" |
| 15 | Keep in Mind | `reworked` | Two new standing rules |
| 16 | Scaffold Contract | `new` | What is real vs. wired-thin vs. deferred |

---

## 1. What Kusoma Is

Kusoma is infrastructure for independent tutors in Kenya. A tutor manages a
roster of students and gets a dashboard showing engagement and performance.
Between in-person sessions, students interact with an AI teaching assistant
inside a Telegram group — the tutor, student, and AI bot share the same
chat, and that same conversation is also visible, in real time, inside the
Expo app's own chat UI, so the tutor has full visibility without leaving
the app if they don't want to.

Kusoma is a **general-purpose tutoring tool first** — a tutor can use it
productively with zero curriculum configuration, just a roster of students
and a live chat channel per student. Scoping a student to a specific CBC
learning outcome ("assigning a topic") is a power-user feature the tutor
can opt into, not a required step of onboarding or of using the product day
to day. Don't gate any core screen behind "must have an assignment" — the
app, dashboard, and chat should all work sensibly for a student who has
never been assigned anything.

The structural analogy is a creator platform: the tutor is the creator, they
bring their own students, set their own terms, and Kusoma provides the back
office — AI tutoring, progress tracking, and (eventually) payment
collection. Kusoma is not sold directly to students; the tutor is the
customer, and the AI extends the tutor's capacity rather than replacing
them.

**Explicitly not in this prototype** (do not build, stub, or scaffold for
these): M-Pesa payment tracking, offline support, multi-tutor tenant
isolation beyond row-scoped WHERE clauses, a WhatsApp channel, a scheduled
parent-report digest job (parents get live read access instead — see §2).
Basic homework-photo support (an attachment the AI can look at) **is** in
scope now — see §5's `messages.attachments` and §9 — even though earlier
drafts of this spec deferred it; full capture/annotation UX beyond "attach
a photo to a chat message" is still out of scope.

**And this pass is a scaffold.** The schema, the module boundaries, and the
wiring are what's being built; the AI, Telegram, and realtime layers are
wired end to end but deliberately thin. §16 is the contract — read it before
deciding how deep to go on anything below.

---

## 2. Users & Roles

**There is one `users` table.** Tutor, guardian, and student are *role keys*
(§5), not separate tables and not separate account types. Revision 1 modelled
them as three tables; if you find yourself writing `tutors` or `guardians` as
a table name, you are working from the old spec.

Three roles, two of which can log into the Expo app:

- **Tutor** (`tutor`) — the paying customer. Full read/write access to their
  own students, chat, and assignments. Registers with phone + password.
- **Parent/Guardian** (`guardian`) — added by the tutor, logs into the *same*
  Expo app through the *same* `POST /auth/login`, with their own phone +
  password. Read-only, scoped to exactly the student(s) they guard: the
  Reports view (same performance data the tutor sees) and the chat room
  (viewing the tutor/student/AI conversation, as a safety/oversight mechanism
  for a minor — not primarily a place for the parent to participate). This
  stays a genuinely simple RBAC scaffold: **the parent sees the same data the
  tutor sees, filtered to their own child, with write actions disabled** —
  don't build a separate reports data model or a scheduled digest; the
  "report" is just the existing dashboard and student-detail data rendered
  for a role whose `role_permissions` grants contain no `:write` key.
- **Student** (`student`) — no app login, enforced by having no
  `password_hash` rather than by living in a different table. Interacts with
  the AI only via Telegram.

There is also a seeded **`bot`** user, so the AI has a real `users` row to be
the sender of its messages and a real `chat_participants` row in every room.
It has no login and no permissions.

**What this buys, concretely:**

- Roles are many-to-many (`user_roles`), so a tutor who also guards their own
  child holds both roles on one account. The old two-table split made that
  impossible without two logins and two phone numbers.
- "Which students may this user see?" is **one query against
  `user_relationships`**, parameterized by relationship — not a tutor branch
  and a guardian branch that can drift apart. See `scopeStudent()` in §8.
- Adding a fourth principal later (school admin, co-tutor) is a seed row in
  `roles` plus grants in `role_permissions`. No migration, no new handler
  branch.

Every protected route resolves the caller's roles and permissions once in
middleware and scopes its query accordingly. See §5 (`users`, `roles`,
`user_relationships`), §8 (middleware and route gating), and §16 (how far to
build it on this pass).

---

## 3. Architecture

```
┌───────────────────┐            ┌──────────────────┐
│   Expo App         │            │   Telegram       │
│ (Tutor + Parent)   │            │   (Tutor +       │
│  - Dashboard        │            │    Student +      │
│  - Students          │            │    @KusomaBot)    │
│  - Chat UI (aniui)   │            │                  │
│  - Reports (parent)  │            └────────┬─────────┘
└────┬───────────┬────┘                     │
     │ REST      │ WebSocket                │ Webhook POST
     ▼           ▼                          ▼
┌──────────────────────────────────────────────────────────┐
│                Node.js Backend (Express)                  │
│                                                            │
│ ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌─────────┐ │
│ │ REST API │  │ Realtime  │  │ Telegram   │  │ Broker  │ │
│ │ Routes   │  │ Hub (WS)  │  │ Webhook    │  │(pub/sub)│ │
│ └────┬─────┘  └─────┬─────┘  └─────┬──────┘  └────┬────┘ │
│      └──────────────┴──────────────┘               │      │
│                                                     │      │
│  ┌───────────────────────────────────────────────┐│      │
│  │   Subscribers, each on their own topic(s)      │◄┘      │
│  │   - MessageStore    - Router                   │        │
│  │   - AIOrchestrator  - Analytics                │        │
│  │   - TelegramSender  - AppRealtimeBroadcaster    │        │
│  │   - AssignmentAdvisor                          │        │
│  └───────────────────────────────────────────────┘        │
│                                                            │
│  ┌──────────┐                                              │
│  │ Postgres │                                              │
│  └──────────┘                                              │
└──────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
  ┌──────────────┐     ┌──────────────────┐
  │  CBC API     │     │   AWS Bedrock    │
  │  (external)  │     │ (Claude, SigV4)  │
  └──────────────┘     └──────────────────┘
```

Single Node.js process for the prototype (see §6 for why this is still the
right call even with a WebSocket layer added). **Tech stack**:

| Layer | Choice | Notes |
|---|---|---|
| Mobile app | Expo (React Native), Expo Router | already scaffolded in `kusoma-client` |
| Backend | Express + TypeScript | single-process |
| Database | PostgreSQL | |
| ORM | Drizzle | type-safe schema, lightweight |
| Auth | JWT (phone + password), **one** principal type | bcrypt hashing, SecureStore on mobile; roles resolved from `user_roles` |
| Realtime | `ws` (WebSocket) | fans out chat + status updates to connected app clients |
| Telegram | `grammy` (Bot API library) | typed, middleware-based, webhook-native |
| AI | **AWS Bedrock** (Claude) | `@anthropic-ai/bedrock-sdk` → `AnthropicBedrockMantle`, model `anthropic.claude-opus-5`; vision via **base64 only** — see §9 |
| Curriculum data | CBC Curriculum API | external, called at runtime only |
| Event bus | Provider-backed `Broker` interface, in-memory provider for the prototype | see §6 |

---

## 4. `kusoma-client` — from Tabibu clone to Kusoma app

This is the more delicate half of the job: you are pruning a much larger,
more sophisticated app down to a handful of screens, while keeping the
infrastructure that has nothing to do with the EMR domain.

### 4.1 Rebrand the shell first

- `package.json`: `"name": "tabibu"` → `"name": "kusoma-client"` (or
  `"kusoma"` — match whatever `kusoma-server/package.json` ends up using as
  its sibling name).
- `app.json`: `expo.name` "Tabibu" → "Kusoma", `expo.slug` "Tabibu" →
  "Kusoma", `expo.scheme` "tabibu" → "kusoma". Leave icons/splash as
  placeholders for now unless asked to redesign them.
- **Brand color: green `#2D6A4F`, not violet.** `design.md` documents
  Tabibu's violet `#7C3AED` as the one primary/accent color, referenced via
  semantic tokens in `global.css` rather than hardcoded hex. Update those
  tokens (`--primary` and its hover/pressed/soft-accent variants) to a
  `#2D6A4F`-based palette, and update `design.md` itself to describe
  Kusoma's palette instead of Tabibu's. Don't hunt for hardcoded hex in
  components — if the codebase followed its own rule, changing the tokens
  is enough; if you do find a hardcoded violet value, fix it in place. The
  CASL/permissions/module-registry parts of `design.md`'s philosophy don't
  apply to Kusoma (see §4.3) — the parts worth keeping are the token-based
  theming discipline and generous tap targets.

### 4.2 Keep as-is (generic infrastructure, not EMR-specific)

> **On `design.md`:** treat it as authoritative on *conventions* (the `@/`
> import alias, uniwind `className` styling, the mandatory component-sourcing
> order, `components/ui/<name>/index.ts` layout, the animate-presets rule) but
> **stale on specifics** — it cites `lib/departments.ts`,
> `store/workspace-store.ts`, `constants/theme.ts`, `store/ui-store.web.ts`
> and others that do not exist in the tree, says "no `_layout.tsx` per module"
> when every module folder has one, and lists `data-table` as unbuilt when it
> exists. Don't chase a path just because `design.md` names it.

Reuse these directly — they have no clinical-domain coupling:

- `components/ui/**` — the whole component kit: button, input, textarea,
  password-input, phone-input, masked-input, number-input, checkbox,
  radio-group, switch, select, toggle/toggle-group, tags-input, avatar,
  status-pill, progress, step-progress, skeleton, spinner, toast,
  bottom-sheet, drawer, popover, tooltip, hover-card, accordion,
  action-button, adaptive-view, fab, filter-pills, floating-pill,
  floating-tab-bar, grid, haptic-pressable/haptic-tab,
  keyboard-avoiding-scroll-view, label, linear-tab, pagination,
  parallax-scroll-view, swipeable-list-item, data-table, charts, calendar,
  date-picker, command-menu, icon-symbol, themed-text, themed-view,
  waveform, **and `chat-bubble` + `typing-indicator`, which you will
  actually use now** (see §10's Chat UI screen — no longer dead weight).
- `components/screens/{screen-container,screen-layout,screen-layout-tabs}`
  — generic screen scaffolding. Reuse `ScreenLayout` as the wrapper for
  every new screen.
- `hooks/**` except `use-can.ts` and `use-screen-access.ts` (CASL-specific
  — drop with CASL, see §4.3). `use-breakpoint`, `use-color-scheme(.web)`,
  `use-app-active(.web)`, `use-keyboard-height`, `use-modal-insets`,
  `use-platform`, `use-theme-color`, `use-theme-size`,
  `use-unsaved-changes-guard`, `use-draft` are all generic.
- `lib/api/http-client.ts` — generic axios wrapper with `SDKError`,
  retry/backoff, auth-token injection, 401 handling. Keep verbatim.
- `lib/secure-store/**`, `lib/async-storage/**` — generic storage wrappers.
- `lib/theme.ts`, `global.css`, `postcss.config.*`, `tailwind`/`uniwind`
  setup, `lib/utils.ts`, `lib/format.ts`, `lib/animation.ts`,
  `lib/sanitize/**` — generic.
- `.aniui.json` / the aniui component registry itself — this project
  already pulls its UI kit from aniui (`accordion`, `button`, `chat-bubble`,
  `typing-indicator`, `waveform`, etc. are all aniui-installed components
  per `.aniui.json`'s `installed` map). **Use the same mechanism to pull in
  a fuller chat interface** rather than hand-rolling a message-list +
  composer from scratch — check what aniui component(s) cover a chat
  screen (a conversation/message-list or chat-composer component, if aniui
  offers one) and install it the way the rest of the kit was installed,
  landing in `components/ui/` and registering in `.aniui.json` like every
  other entry there. Build on top of the already-installed `chat-bubble`
  and `typing-indicator` if aniui doesn't have a single higher-level
  component for this.
- `components/settings/**` — trim down, keep a minimal settings screen
  (logout, role-aware — see §10).

### 4.3 Strip entirely (EMR/clinical domain — irrelevant to Kusoma)

- Route groups: `app/(tabs)/{admin,billing,clinical,concepts,extensions,forms,inventory,laboratory,orders,patients,pharmacy,reports,triage,visits}`
  (note: Kusoma has its own, differently-shaped "Reports" for parents —
  don't confuse the two; the Tabibu `reports` route is a hospital
  reporting module and gets deleted).
- `app/add-profile.tsx`, `app/change-url.tsx`, `app/new-form.tsx`
- `components/{clinical,orders,patients,triage,templates,extension}`,
  `components/forms/draft-inbox`, `components/examples`
- `components/auth/backend-url-step.tsx`,
  `components/auth/profile-picker.tsx` (Tabibu supports multiple
  self-hosted clinic backends with a picker; Kusoma has one fixed backend
  URL)
- `store/{admin,billing,clinical,concepts,drafts,extensions,inventory,notifications,orders,patients,persons,reference,visits,ability}-store.ts`
- `types/{admin,clinical,concepts,extensions,patients,persons,visits}.ts`
- `lib/ability.ts`, `lib/modules.ts` (CASL + module-registry — replace with
  the much smaller two-role check described in §10, not a permissions
  engine)
- `lib/forms/{clinical,patients,visits}`, `lib/templates/**`
- `lib/api/{billing,clinical,concepts,extensions,inventory,laboratory,notifications,orders,patients,persons,pharmacy,reference,triage,visits,websocket-client}.ts`
  (yes, delete the old `websocket-client.ts` too — Kusoma's realtime client
  is new, see §10, and has a different job: syncing chat, not the EMR's
  live-update feed)
- Once these are gone, prune now-unused dependencies from `package.json`
  (candidates: `@casl/ability`, `@rn-primitives/*` if nothing left uses
  them, `react-native-webview`, `expo-mail-composer` if unused). Do this
  **after** deleting the consuming code and confirming the app still
  typechecks.

### 4.4 Rebuild / adapt for Kusoma

**Auth & session** (`store/session-store.ts`, `lib/api/auth.ts`,
`lib/auth/profile.ts`): replace Tabibu's multi-profile,
multi-backend-install session store with one that holds
`{ token, user, roles: string[], permissions: string[], onboarded, isLoading }`,
token persisted via `expo-secure-store`. Backend URL is a fixed constant/env
var (`EXPO_PUBLIC_API_URL`), not user-configurable.

`roles` and `permissions` come from the **login response body**, not from
decoding the JWT — nothing on the client decodes tokens today and that's worth
keeping. `lib/api/auth.ts` calls exactly two endpoints (§8):
`POST /auth/register` and `POST /auth/login`. There is no guardian-specific
login; the same call serves both, and the app decides what to render from
`roles`.

Gate write affordances on `permissions.includes('students:write')` rather than
on `role === 'tutor'`, so the UI and the API agree on one vocabulary. This is
*not* a reintroduction of CASL (§4.3) — it's an `Array.includes` on a string
list, and it should stay that small.

**New API modules** in `lib/api/`, built on the kept `http-client.ts`:
`students.ts`, `assignments.ts`, `curriculum.ts`, `dashboard.ts`,
`onboarding.ts`, `messages.ts` (chat history + send), `guardians.ts`
(tutor adding a parent).

**New types**: `user.ts` (one shape for every principal, replacing separate
`tutor.ts`/`guardian.ts`), `role.ts`, `student.ts`, `assignment.ts`,
`curriculum.ts`, `dashboard.ts`, `message.ts` (including the attachment
shape from §5). Note that `types/admin.ts`'s existing `Role` type is dead
code — imported nowhere — so it can be reshaped or deleted freely.

**Navigation shell**: adapt `app/_layout.tsx`'s auth-gate pattern to
Kusoma's states: unauthenticated → auth screen; tutor authenticated but not
onboarded → onboarding; authenticated (either role) → the app shell, with
the *set of visible screens/tabs depending on role* (§10). The current
`(tabs)/_layout.tsx` wires up a 16-tab bar for EMR modules — Kusoma needs a
much smaller bar (Dashboard, Chat, and — tutor only — Students; parent gets
Dashboard/Reports + Chat, both read-only). Use your judgment on tab vs.
stack; a small bottom bar is reasonable given there are now enough screens
(dashboard, chat, student list/detail, curriculum browser, settings) to
warrant one, unlike the original 5-screen version of this spec.

Keep the `@/` import-alias convention and the uniwind (`className="..."`)
styling convention used throughout — don't introduce `StyleSheet.create`
alongside it.

---

## 5. Database Schema (`kusoma-server`)

Drizzle-defined; this SQL is the source of truth for the shape. **This section
was fully replaced in Revision 2** — if you remember three principal tables,
that is the old schema. Read the comments, not just the column lists.

Eleven tables, up from seven. Table count went *up*; duplicated columns and
forked query paths went *down*. That is the trade being made deliberately:
`tutors`/`students`/`guardians` each carried their own `display_name`,
`phone`, `telegram_user_id`, and `password_hash`, and every scoped query had
to know which of the three it was reading. Now there is one identity table and
one relationship table, and the role is data.

```sql
-- ═══════════════ IDENTITY ═══════════════

-- 1. Users — one row per human, plus one for the bot. Replaces the old
-- tutors + students + guardians tables entirely. What a user *is* comes
-- from user_roles, never from which table they live in.
CREATE TABLE users (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name     text NOT NULL,   -- was tutors.display_name / students.first_name
    phone            text,            -- NULL only for the seeded bot user
    telegram_user_id bigint UNIQUE,   -- lazily captured on first message in a linked group
    password_hash    text,            -- NULL = cannot log in (students, bot)
    grade            smallint CHECK (grade IS NULL OR grade BETWEEN 1 AND 13),
    onboarded        boolean NOT NULL DEFAULT false,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

-- This partial index preserves the old schema's uniqueness intent exactly.
-- Before: tutors.phone and guardians.phone were UNIQUE; students.phone was
-- NOT NULL but deliberately not unique. A phone is a *login identifier*, so
-- it must be unique among accounts that can log in — which is precisely what
-- lets a young student be registered under their guardian's phone number, a
-- completely normal case in this market. Do not "fix" this into a plain
-- UNIQUE constraint.
CREATE UNIQUE INDEX users_login_phone_uniq ON users(phone) WHERE password_hash IS NOT NULL;
CREATE INDEX idx_users_telegram ON users(telegram_user_id);

-- 2. Roles — seeded data, not code. Adding a role later (school admin,
-- co-tutor) is an INSERT here plus grants in role_permissions. It must
-- never require a new table or a new branch in a handler.
CREATE TABLE roles (
    id          smallserial PRIMARY KEY,
    key         text UNIQUE NOT NULL,   -- 'tutor' | 'guardian' | 'student' | 'bot'
    name        text NOT NULL,
    description text
);

-- 3. User Roles — many-to-many on purpose. A tutor who also guards their
-- own child holds both roles on one account instead of needing two logins,
-- which the old two-table split made impossible.
CREATE TABLE user_roles (
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id    smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, role_id)
);

-- 4. Permissions — the RBAC scaffold. Seeded and wired to a working
-- requirePermission() helper (§8), but intentionally coarse for the
-- prototype: this is a permission *table*, not a permissions engine, and
-- explicitly not a return of Tabibu's CASL layer (§4.3).
CREATE TABLE permissions (
    id          smallserial PRIMARY KEY,
    key         text UNIQUE NOT NULL,   -- '<resource>:<action>', e.g. 'students:write'
    description text
);

CREATE TABLE role_permissions (
    role_id       smallint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id smallint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- ═══════════════ WHO RELATES TO WHOM ═══════════════

-- 5. User Relationships — replaces students.tutor_id AND the whole
-- guardians table's scoping. One row shape and one query shape answer
-- "which students may this user see, and in what capacity", so the tutor
-- path and the guardian path stop being two pieces of code that can drift.
CREATE TABLE user_relationships (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the adult: tutor or guardian
    to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the student
    relationship text NOT NULL CHECK (relationship IN ('tutor_of', 'guardian_of')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (from_user_id, to_user_id, relationship),
    CHECK (from_user_id <> to_user_id)
);
CREATE INDEX idx_rel_from ON user_relationships(from_user_id, relationship);
CREATE INDEX idx_rel_to   ON user_relationships(to_user_id, relationship);

-- ═══════════════ CHAT ═══════════════

-- 6. Chat Groups — the canonical chat room per tutor-student pair,
-- mirrored on two surfaces (a Telegram group chat, and the Expo app's own
-- Chat UI over WebSocket — see §6).
--
-- telegram_chat_id is now NULLABLE (it was NOT NULL). This is a real
-- simplification, not just a looser constraint: the room is created when
-- the student is created, and the Telegram webhook later *binds* the chat
-- id onto the existing row. Nothing has to create a chat_groups row from a
-- webhook payload any more — see §7.
--
-- owner_user_id and student_user_id are kept even though chat_participants
-- could derive them. They are the denormalized anchor: they carry the
-- DB-enforced "one room per tutor-student pair" invariant, which a join
-- table cannot express without a trigger, and they keep the hot lookup
-- ("find the room for student X") index-only.
CREATE TABLE chat_groups (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- was tutor_id
    student_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- was student_id
    telegram_chat_id bigint UNIQUE,
    title            text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, student_user_id)
);

-- 7. Chat Participants — membership and per-room ACL. This is what makes
-- the guardian's read access and the bot's presence *rows* rather than
-- role-branching in application code. The Realtime Hub (§6.4) and the
-- AppRealtimeBroadcaster (§6.3) both resolve "who can see this room"
-- from here with a single query and no role fork.
--
-- participant_role is the user's role *within this room*, which is not the
-- same thing as their global role in user_roles: 'owner' is the tutor,
-- 'observer' is a guardian (can_post = false), 'bot' is the seeded bot user.
CREATE TABLE chat_participants (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_group_id    uuid NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant_role text NOT NULL CHECK (participant_role IN ('owner', 'student', 'observer', 'bot')),
    can_post         boolean NOT NULL DEFAULT true,   -- false for guardians (read-only, §2)
    joined_at        timestamptz NOT NULL DEFAULT now(),
    last_read_at     timestamptz,
    UNIQUE (chat_group_id, user_id)
);
CREATE INDEX idx_chat_participants_user ON chat_participants(user_id);

-- 8. Messages — every message in every chat group, from either Telegram or
-- the Expo app's Chat UI. `platform` is what lets you reconstruct which
-- surface a message came from; `attachments` covers photos/documents/voice
-- notes in a Telegram-compatible shape so the AI orchestrator can pass
-- images to the model as vision input (§9).
--
-- sender_role stays denormalized alongside sender_user_id so the Router and
-- the chat renderer never join user_roles per message — the same trade-off
-- this schema already accepts for strand/sub_strand/learning_outcome.
CREATE TABLE messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_group_id       uuid NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    sender_user_id      uuid NOT NULL REFERENCES users(id),
    sender_role         text NOT NULL CHECK (sender_role IN ('student', 'tutor', 'guardian', 'bot')),
    platform            text NOT NULL CHECK (platform IN ('telegram', 'app')),
    content             text NOT NULL,
    -- Each element: { type: 'image'|'document'|'audio'|'voice'|'video',
    --   telegramFileId?: string, url?: string, mimeType?: string,
    --   width?: number, height?: number, caption?: string }
    -- telegramFileId is set for anything that arrived via Telegram; url is
    -- set for anything uploaded from the Expo app's Chat UI. NOTE: Bedrock
    -- accepts neither of these directly — both must be resolved to base64
    -- bytes server-side before they reach the model. See §9.
    attachments         jsonb NOT NULL DEFAULT '[]',
    telegram_message_id bigint,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_group ON messages(chat_group_id, created_at DESC);
-- Telegram redelivers an update if your 200 is slow. This makes the webhook
-- idempotent for free instead of needing an application-level dedupe.
CREATE UNIQUE INDEX idx_messages_tg_dedupe ON messages(chat_group_id, telegram_message_id)
    WHERE telegram_message_id IS NOT NULL;

-- ═══════════════ CURRICULUM ═══════════════

-- 9. Assignments — a CBC learning-outcome scope for a student. Optional,
-- opt-in (see §1) — a student can have zero rows here forever and the
-- product still works. `source` and `status` together capture the
-- "AI proposes, tutor approves" workflow from §9's AssignmentAdvisor:
-- an AI-authored row lands as source='ai', status='suggested' and is
-- inert until the tutor accepts it (flips to 'active', pausing whatever
-- was active before); a tutor can also create source='tutor' rows
-- directly at status='active', skipping the suggestion step entirely.
CREATE TABLE assignments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    student_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cbc_node_id      uuid NOT NULL,
    strand           text NOT NULL,
    sub_strand       text NOT NULL,
    learning_outcome text NOT NULL,
    source           text NOT NULL DEFAULT 'tutor' CHECK (source IN ('tutor', 'ai')),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('suggested', 'active', 'paused', 'completed', 'dismissed')),
    rationale        text, -- set only when source='ai': why the advisor proposed this, shown to the tutor before they accept it
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_assignments_student ON assignments(student_user_id, status);

-- 10. Student Performance — one row per student per curriculum node.
CREATE TABLE student_performance (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    student_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cbc_node_id      uuid NOT NULL,
    strand           text NOT NULL,
    sub_strand       text NOT NULL,
    learning_outcome text NOT NULL,
    total_problems   integer NOT NULL DEFAULT 0,
    correct_count    integer NOT NULL DEFAULT 0,
    common_errors    jsonb NOT NULL DEFAULT '[]',
    last_active_at   timestamptz,
    UNIQUE (student_user_id, cbc_node_id)
);
```

### 5.1 Design notes worth not re-litigating

- **`grade` lives on `users` as a nullable column**, rather than in a
  `student_profiles` table. One role-specific column does not earn a join, and
  the CHECK preserves the original `BETWEEN 1 AND 13` rule. When a *second*
  student-only field appears, that's the moment to add the profile table —
  not before.
- **The old denormalization trade-off is unchanged**: `strand` /
  `sub_strand` / `learning_outcome` are copied as plain text from the CBC API
  at write time into both `assignments` and `student_performance`, to avoid a
  runtime CBC call on every dashboard render. Accepted staleness risk if a
  curriculum node's text changes upstream.
- **Students are `users` rows with no `password_hash`.** They still never log
  into the app (§2) — the absence of a password is what enforces that, and it
  is also what keeps them out of the login-phone unique index.

### 5.2 Seeds (`db/seed.ts`)

The seed script is not optional garnish — the RBAC tables are inert without
it, and several handlers resolve permissions through it on every request.

| What | Rows |
|---|---|
| `roles` | `tutor`, `guardian`, `student`, `bot` |
| `permissions` | `students:read`, `students:write`, `guardians:write`, `assignments:read`, `assignments:write`, `messages:read`, `messages:send`, `curriculum:read`, `dashboard:read` |
| `role_permissions` | `tutor` → all nine. `guardian` → the four `:read` keys **only** — `students:read`, `assignments:read`, `messages:read`, `dashboard:read` — and no `:write` or `:send` (this is what makes parents read-only at the data layer, §15). `dashboard:read` is included on purpose: `GET /dashboard/summary` is computed across whatever students the caller is related to, so for a guardian it degrades to their own child's numbers rather than 403-ing (§8.2), which is their landing screen. `student` and `bot` → none; neither has an app session. |
| bot user | `display_name: 'Kusoma Bot'`, `phone: NULL`, `password_hash: NULL`, role `bot`. Giving the bot a real `users` row is what lets `messages.sender_user_id` be `NOT NULL` and `chat_participants` stay uniform. |
| dev tutor | `phone: '0700000000'`, `password: 'kusoma-dev'`, role `tutor` (§11) |

---

## 6. Event Bus / Pub-Sub — and Why Not RabbitMQ (Yet)

### 6.1 The reliability question

Plain `EventEmitter` (what earlier drafts of this spec used) has real
limitations: it's synchronous and in-process only (no cross-process
fan-out, so it can't survive a restart mid-flight or scale past one Node
process), it has no persistence or redelivery (a crash between "message
stored" and "AI response sent" silently drops that step), and there's no
back-pressure or consumer-group semantics (every listener gets every
event, always, with no way to say "only one of these three workers should
handle this").

RabbitMQ (or Kafka) solves all of that — durable queues, at-least-once
delivery, retry/dead-letter, real multi-consumer groups, works across
processes and machines. But it also means standing up and operating a
broker, wiring connection/retry/health-check logic for it, and doing all
of that under hackathon time pressure for a system that, in the prototype,
has one Node process, one tutor, up to 10 students, and a message volume
you could count by hand. For this scale, the operational cost of a real
broker outweighs the reliability it buys you — a dropped event today means
a retry or a manual nudge, not lost revenue.

**Recommendation: stay in-process for the prototype, but don't couple the
rest of the system to `EventEmitter`'s API directly.** Put a small
provider-agnostic interface in front of it, exactly the way
`tabibu-server`'s Go backend already does — see `pkg/broker/broker.go`
there:

```typescript
// src/pkg/broker/broker.ts
export interface Message {
  topic: string;
  key?: string;          // for future partitioning/routing (Kafka/RabbitMQ)
  payload: unknown;
  headers?: Record<string, string>;
}

export type Handler = (msg: Message) => Promise<void>;

/** Provider-agnostic pub/sub. Subscribe is non-blocking and starts
 * consumption in the background. A handler that throws signals the
 * message should be retried/nacked, depending on the provider's policy —
 * mirrors tabibu-server's Broker interface 1:1. */
export interface Broker {
  publish(msg: Message): Promise<void>;
  subscribe(topic: string, group: string, ...handlers: Handler[]): Promise<void>;
  close(): Promise<void>;
}
```

The prototype's only provider is `InMemoryBroker` (`src/pkg/broker/providers/in-memory.ts`),
a thin wrapper over `EventEmitter` that satisfies this interface —
subscribers never touch `EventEmitter` directly, they only ever see
`Broker`. Also port `tabibu-server/pkg/broker/retry.go`'s idea: a
`subscribeWithRetry` helper that retries a failed `subscribe()` call with
staggered backoff at startup, so a provider that isn't ready yet (relevant
once you're not in-memory anymore) doesn't take the whole server down.

This buys you the exact thing you asked for — "reuse the idea of pkg and
provider from tabibu-server" — without adding infrastructure: if Kusoma
ever needs real durability (multi-instance deployment, guaranteed
delivery), you write one more file — `providers/redis-streams.ts` or
`providers/rabbitmq.ts` — implementing the same `Broker` interface, and
nothing in `subscribers/` changes. `tabibu-server` itself proves this
works: it ships three interchangeable providers (RabbitMQ, Kafka, and a
SQLite-backed one via Watermill for single-server deployments needing zero
external infra) behind this one interface. If you want a middle ground
later without adding a new service, a Postgres-`LISTEN`/`NOTIFY`- or
`pg-boss`-backed provider is the closest analogue to that SQLite option,
since Postgres is already in the stack.

### 6.2 Events (topics)

```typescript
// src/events/types.ts
// Every id below is a users.id — there are no separate tutor/student id
// spaces any more (§5). senderUserId is carried explicitly so subscribers
// never have to re-resolve the sender from the platform payload.
export interface MessageInbound {
  chatGroupId: string;
  studentUserId: string;
  ownerUserId: string;              // the tutor who owns the room
  senderUserId: string;
  senderRole: 'student' | 'tutor' | 'guardian';
  platform: 'telegram' | 'app';
  text: string;
  attachments: Attachment[];
  telegramChatId?: number;          // present when platform === 'telegram'
  telegramMessageId?: number;
  timestamp: Date;
}

export interface AIRequest {
  chatGroupId: string;
  studentUserId: string;
  ownerUserId: string;
  text: string;
  attachments: Attachment[];
}

export interface AIResponse {
  chatGroupId: string;
  studentUserId: string;
  text: string;
  performance?: {
    cbcNodeId: string;
    strand: string;
    subStrand: string;
    learningOutcome: string;
    isCorrect: boolean;
    errorType?: string;
    errorDetail?: string;
  };
}

export interface MessageOutbound {
  chatGroupId: string;
  senderUserId: string;             // the bot user, or the tutor who sent from the app
  senderRole: 'bot' | 'tutor';
  text: string;
  attachments?: Attachment[];
}

// Topic names, published on the Broker from §6.1:
// 'message.inbound' | 'message.outbound' | 'ai.request' | 'ai.response'
// | 'assignment.suggested' (see §9's AssignmentAdvisor)
```

### 6.3 Subscribers

Each is a file in `src/subscribers/`, registered at startup, no subscriber
imports another:

- **MessageStore** — `message.inbound`, `message.outbound` → INSERT into
  `messages`, including `attachments` and `platform`.
- **Router** — `message.inbound` → if `senderRole === 'student'`, emit
  `ai.request`. Tutor messages are stored but never trigger the AI,
  regardless of which platform they came in on.
- **AIOrchestrator** — `ai.request` → assembles the prompt (§9: assignment
  context if one exists, curriculum + content grounding from the CBC API,
  last 10 messages, any image attachments as vision input), calls Claude,
  parses an optional trailing performance JSON block, emits `ai.response`.
- **Analytics** — `ai.response` → if `performance` present, UPSERT into
  `student_performance`.
- **TelegramSender** — `ai.response`, and `message.outbound` where
  `senderRole === 'tutor'` (a message the tutor sent from the Expo app) →
  sends to the Telegram group via the Bot API. For a tutor-authored
  message, prefix it so students can tell it's the tutor, not the bot
  (e.g. `"{tutor.display_name}: {text}"`) — the Bot API can only post as
  the bot itself, it cannot impersonate the tutor's own Telegram identity.
  After sending, emits `message.outbound` (bot/tutor case) so MessageStore
  records the Telegram-side message id.
- **AppRealtimeBroadcaster** — `message.inbound`, `message.outbound` →
  pushes the message over the Realtime Hub (§6.4) to every Expo client
  currently viewing that `chat_group_id`. Recipients come from
  `chat_participants` for that room — **not** from a role branch. If a
  guardian is added to a student later, they start receiving live frames
  because a row exists, with no change to this subscriber. This is what keeps
  the in-app Chat UI in sync with Telegram in both directions.
- **AssignmentAdvisor** (new — see §9 for the full trigger logic) —
  `ai.response` → when enough performance data has accumulated on the
  student's current topic (or lack of one), asks Claude to propose a next
  learning outcome from patterns in `common_errors`/accuracy, INSERTs it
  into `assignments` as `source='ai'`, `status='suggested'`, and emits
  `assignment.suggested` so the tutor sees it surface on Student Detail.

### 6.4 Realtime Hub (WebSocket) — chat sync for the Expo app

This is the other half of "heavily borrow from tabibu-server's event
system" — its `pkg/notify/realtime` package (`hub.go`, `topics.go`,
`envelope.go`, `conn.go`) re-broadcasts selected Broker topics to
authenticated WebSocket connections, filtered per-connection by role and
per-record ACL. Kusoma's version is much smaller (membership rows, not a
privilege system) but the shape is the same:

- **Envelope** — one JSON shape per WS frame, both directions:
  `{ type: 'message' | 'typing' | 'assignment_update', data: {...} }`.
- **Hub** — holds live connections keyed by `(chatGroupId, connectionId)`.
  On connect, the client authenticates with its JWT and the hub resolves which
  rooms that connection may see. In Revision 1 that was a fork ("all of a
  tutor's rooms, or exactly the one tied to a guardian's `student_id`"). With
  `chat_participants` it is **one query with no role branch at all**:

  ```sql
  SELECT chat_group_id FROM chat_participants WHERE user_id = :callerId;
  ```

  This is the payoff of the new table, and it is the per-connection filtering
  `topics.go`'s `RequiredPrivileges`/`ResourceTable` does in Go, reduced to a
  membership lookup. `can_post` on the same row decides whether inbound frames
  from that connection are accepted at all.
- Subscribes to the same `message.inbound`/`message.outbound` topics
  AppRealtimeBroadcaster listens to, so the WS layer and the Telegram
  relay are just two independent subscribers to the same event, not two
  code paths that can drift out of sync.

Use the `ws` package for the WebSocket server, mounted alongside Express on
the same HTTP server. One WS endpoint (e.g. `/ws?token=...`) is enough for
the prototype — don't build per-room WS endpoints.

---

## 7. Telegram Integration

- Bot created via BotFather, privacy mode **disabled** so it receives all
  group messages. Webhook set to `{BACKEND_URL}/webhook/telegram` via
  `setWebhook`, called once at server startup. Use `grammy`.
- **Webhook handler** (`src/routes/telegramWebhook.ts`): ignore non-message
  updates and messages from the bot itself; resolve `chat.id` → `chat_groups`
  row; resolve `from.id` against `users.telegram_user_id` — a **single lookup
  now**, where Revision 1 had to try `tutors` then `students` — then read the
  sender's role from `user_roles` (unmatched → ignore); pull any
  `photo`/`document`/`voice` off the update into the `attachments` shape from
  §5 (store the Telegram `file_id`, don't eagerly download the bytes — resolve
  them on demand when the AI orchestrator or the Expo app actually needs them,
  §9); emit `message.inbound` with `platform: 'telegram'`; return `200 OK`
  immediately.
- **Group creation flow — reordered in Revision 2.** The room now exists
  *before* Telegram is involved, because `chat_groups.telegram_chat_id` is
  nullable (§5):

  1. Tutor adds a student in the Expo app → `POST /students` creates the
     student, the relationship, **the `chat_groups` row (with
     `telegram_chat_id` NULL), and its `chat_participants` rows**, all in one
     transaction, and returns `telegramDeepLink`.
  2. Expo shows the deep link `https://t.me/{BOT_USERNAME}?startgroup={studentUserId}`.
  3. Tutor taps it, creates the group, bot auto-joins → bot receives
     `/start {studentUserId}`.
  4. The webhook **binds** `telegram_chat_id` onto the existing row —
     `UPDATE chat_groups SET telegram_chat_id = :chatId WHERE student_user_id = :studentUserId`
     — and the bot sends a welcome message.

  The webhook no longer *creates* anything. That removes the ordering hazard
  in the old flow, where a room's existence depended on a third-party callback
  arriving, and it means the in-app Chat screen works from the moment the
  student is added, before any Telegram group exists.
- Both tutor and student `telegram_user_id` are still captured lazily, on each
  one's first message in a linked group — don't require Telegram details at
  registration.
- **Where tutor messages come from**: to keep sender-attribution simple,
  the tutor's primary channel for chatting is the Expo app's Chat UI
  (`POST /students/:id/messages`, §8) — that path is unambiguous, since
  it's authenticated by JWT. If the tutor types directly in the Telegram
  group instead, the webhook still resolves and stores it correctly via
  `users.telegram_user_id` — nothing is lost or misattributed, it's just
  not the primary path the UI steers them toward.
- **Assignment/homework announcements**: when an assignment is created or
  accepted (§5/§9), or the tutor sends explicit "assigned work" from the
  Student Detail screen, post a bot message into the chat group announcing
  it (e.g. "📘 New topic: Fractions — Adding fractions with unlike
  denominators" or "📝 New homework: ..."), so the student actually sees
  it show up in Telegram rather than it being a silent DB write.
- Optional convenience bot commands, handled before the Router fires:
  `/status`, `/assign` (points to the Expo app), `/help`.

---

## 8. REST API (Expo App → Backend)

All routes except `/auth/*` require `Authorization: Bearer {token}`.

**The JWT is no longer a union of two shapes.** It carries
`{ sub: userId, roles: string[] }` — one shape for every principal. Middleware
resolves the caller once and every handler scopes its query by relationship —
a guardian's token should be structurally incapable of returning another
student's data, not just prevented by a UI that hides the button.

**The login response, not the token, carries authorization for the client.**
Nothing on the Expo side decodes JWTs (that is true of the existing client
code and worth keeping), so `roles` and `permissions` must come back in the
response body.

### 8.1 Middleware

Three helpers in `src/middleware/`, and handlers use nothing else:

```typescript
authenticate(req)                     // verify JWT → req.user = { id, roles, permissions }
requirePermission('students:write')   // 403 unless the caller's roles grant that key
scopeStudent(req, studentUserId)      // → the user_relationships row, or 403
```

`scopeStudent` is the piece that replaces Revision 1's two scoping paths. It
is **one query parameterized by relationship**, not a tutor branch and a
guardian branch:

```sql
SELECT relationship FROM user_relationships
 WHERE from_user_id = :callerId AND to_user_id = :studentUserId
   AND relationship = CASE WHEN :callerIsTutor THEN 'tutor_of' ELSE 'guardian_of' END;
```

Read access is the same query for both roles; write access is the additional
`requirePermission(...)` check. That is the whole RBAC model — resist growing
it into a permissions engine (§4.3 deletes CASL for exactly this reason).

### 8.2 Routes

Gating below is by **permission key**, not by role name, so a new role that is
granted `students:write` needs no route changes.

```
Auth
  POST   /auth/register              { displayName, phone, password }
                                      → creates a users row + 'tutor' role
                                      → { token, user, roles, permissions }
  POST   /auth/login                 { phone, password }
                                      → { token, user, roles, permissions }
                                      ONE endpoint for tutors and guardians alike; the
                                      client routes on roles[]. There is no
                                      /auth/guardian/login — it was removed in Revision 2.

Students
  GET    /students                   Students the caller is related to. Tutor → their
                                      roster; guardian → their own child(ren). Same
                                      query, different relationship.      [students:read]
  POST   /students                   { firstName, grade, phone } → { student, telegramDeepLink }
                                      Creates, in ONE transaction: the student users row,
                                      its 'student' user_roles row, the 'tutor_of'
                                      user_relationships row, the chat_groups row (with
                                      telegram_chat_id still NULL), and chat_participants
                                      rows for tutor ('owner'), student ('student'), and
                                      the bot ('bot').                   [students:write]
  GET    /students/:id               Detail: profile + active assignment + performance.
                                      Scoped via scopeStudent().          [students:read]
  PATCH  /students/:id               Update student info                 [students:write]
  DELETE /students/:id               Soft-delete (users.is_active = false) [students:write]

Guardians
  POST   /students/:id/guardians     { displayName, phone, password } → { guardian }
                                      Creates the users row + 'guardian' role + the
                                      'guardian_of' relationship + a chat_participants
                                      row as 'observer' with can_post = false.
                                                                        [guardians:write]

Assignments
  POST   /students/:id/assignments   { cbcNodeId, strand, subStrand, learningOutcome }
                                      → source='tutor', status='active', pausing any
                                      prior active assignment.        [assignments:write]
  GET    /students/:id/assignments   History, including 'suggested' ones [assignments:read]
  POST   /students/:id/assignments/:assignmentId/accept   → suggested → active
                                                                     [assignments:write]
  POST   /students/:id/assignments/:assignmentId/dismiss  → suggested → dismissed
                                                                     [assignments:write]

Curriculum (proxied to CBC API)
  GET    /curriculum/:grade/:subject Full curriculum tree for a grade/subject
  GET    /curriculum/node/:id        Single node detail                 [curriculum:read]

Messages (chat)
  GET    /students/:id/messages      Paginated history for the student's chat_group
                                      (?before=&limit=)                   [messages:read]
  POST   /students/:id/messages      { text, attachments? } → sends as the caller,
                                      relayed to Telegram and broadcast over WS.
                                      Also checks chat_participants.can_post, so a
                                      guardian is blocked at the room level as well as
                                      by permission.                      [messages:send]

Dashboard
  GET    /dashboard/summary          { activeStudents, engagedToday, totalProblems, avgAccuracy }
                                      Computed across whatever students the caller is
                                      related to — so it degrades naturally to one
                                      student for a guardian rather than 403-ing.
                                                                        [dashboard:read]

Onboarding
  POST   /onboarding/complete        Marks users.onboarded = true       [students:write]
```

The `/students` POST response's `telegramDeepLink` is the critical handoff
between the Expo app and Telegram — the `t.me` URL the tutor taps.

Every permission key above must exist in the §5.2 seed. A route gated on a key
that is never seeded fails closed and is very annoying to debug.

---

## 9. AI Orchestrator — Bedrock, Prompt Assembly, Attachments, Dynamic Assignments

### 9.0 The Bedrock client

Kusoma calls Claude **through AWS Bedrock**, not the Anthropic API. This is
not a base-URL swap — three Bedrock limitations change real code, and they are
called out inline below.

```typescript
// src/services/bedrock.ts
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

// Credentials and region resolve through the standard AWS precedence:
// constructor args → AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
// AWS_SESSION_TOKEN / AWS_REGION → the AWS config file and credential chain
// (SSO, assumed roles, ECS task role, IMDS). There is no Anthropic API key.
export const bedrock = new AnthropicBedrockMantle({
  awsRegion: process.env.AWS_REGION,
});

// Bedrock model ids carry an `anthropic.` prefix. Kept in an env var because
// Opus 5 access is granted per AWS account on Bedrock, while Sonnet 5 and
// Haiku 4.5 are open to all — so a model change is config, not code.
export const MODEL = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-opus-5";
```

Install: `npm install @anthropic-ai/bedrock-sdk`.

**Three Bedrock constraints that change how you write this:**

1. **Vision is base64-only.** Bedrock supports neither URL image sources nor
   the Files API. Both of §5's attachment shapes must be resolved to bytes
   server-side before they reach the model. Write
   `src/services/attachments.ts`:

   ```typescript
   // telegramFileId → Bot API getFile → download → base64
   // url            → server-side fetch → base64
   async function toImageBlock(a: Attachment): Promise<ImageBlockParam>
   ```

   Bedrock caps a request payload at **20 MB**, which you will hit before any
   token limit when a student sends several homework photos — cap and
   downscale rather than letting the call fail.
2. **No structured outputs.** `output_config.format` is unavailable, so §9.1's
   trailing-JSON-block parse is the mechanism, not a workaround. Don't reach
   for structured outputs here; don't force a tool call to fake them either.
3. **No server-side tools** (web search, web fetch, code execution) and no
   Message Batches. Nothing in this spec needs them — just don't reach for
   them.

Request settings:

| Path | Settings |
|---|---|
| Chat reply (AIOrchestrator) | `thinking: { type: 'adaptive' }`, `output_config: { effort: 'low' }`, `max_tokens: 2048` — short tutoring turns, and a student is waiting on the reply |
| AssignmentAdvisor (§9.2) | `effort: 'high'`, `max_tokens: 4096` — one call, nobody waiting, quality matters |

Both are tunable; start here. Prompt caching **does** work on Bedrock — put an
explicit `cache_control` breakpoint after the curriculum/content block once
the prompt stabilizes. That's a follow-up, not scaffold work (§16).

Region note: `af-south-1` (Cape Town) is available and is the nearest region
to Kenya; the global endpoint is also available for Opus 5 and carries no
pricing premium. Pick deliberately at deploy time.

### 9.1 Prompt assembly

Four data sources, same as before, but assignment context is now
**optional**:

```
System prompt:
  You are a tutor helping a Grade {grade} student in Kenya{ with {strand} > {subStrand} if assigned}.
  {If assigned: The student's current learning outcome: {learningOutcome}.}
  {If not assigned: No specific topic has been assigned yet — help with whatever
  the student brings, and infer the likely strand/sub-strand from their question
  so you can still ground your answer in real curriculum content below.}

  CURRICULUM CONTEXT:
  {curriculum search results — teaching approach, suggested activities}

  REAL EXAMPLES (from past papers and worked examples):
  {content search results — exam questions with answers, step-by-step solutions}

  CONVERSATION HISTORY:
  {last 10 messages with role labels}

  {If the student attached an image: describe what you see in the image and use
  it to inform your answer — e.g. read the handwritten homework problem, or check
  the student's working for errors.}

  RULES:
  - Guide the student to the answer; do not give it directly.
  - Use the real examples above to ground your explanations where relevant.
  - If a topic is assigned and the student's question is well outside it, briefly
    help but redirect to the assigned topic. If nothing is assigned, follow
    whatever the student brings.
  - Keep language simple. Mix English and Swahili naturally if the student does.
  - When evaluating an answer, respond with a JSON block at the end:
    {"performance": {"cbcNodeId": "...", "strand": "...", "subStrand": "...",
    "learningOutcome": "...", "isCorrect": bool,
    "errorType": "conceptual"|"computational"|"misread"|null, "errorDetail": "..."}}
    followed by your explanation — cbcNodeId/strand/subStrand/learningOutcome come
    from whatever topic the question was actually about (the active assignment if
    one exists, otherwise your best inference from the curriculum search results),
    so performance can still be tracked for an unassigned student. Omit the JSON
    block entirely if the message isn't an answer attempt.

User message:
  {student's message text}
  {image attachments passed as vision content blocks — base64 only, resolved
  server-side via toImageBlock() from Telegram's getFile or by fetching the
  Expo app's stored URL. Bedrock will not accept a URL source. See §9.0}
```

The orchestrator extracts the trailing JSON block from the response text
(so the student never sees raw JSON) and emits it as `performance` on
`ai.response`; if absent, `performance` is omitted. Note that
`student_performance` (and thus the dashboard) now accumulates data even
for students with no active assignment — that's intentional, and it's
exactly the raw material the AssignmentAdvisor uses next.

### 9.2 Dynamic assignments: LLM + tutor working together

This is the mechanism for "assignments are dynamic" — the AI proposes,
based on real performance data, and the tutor stays the approver:

1. Trigger: after `Analytics` upserts `student_performance` on an
   `ai.response`, `AssignmentAdvisor` checks whether that
   student/topic-area has accumulated enough signal to be worth a
   suggestion (a simple threshold is fine for the prototype — e.g. at
   least 5 recorded problems since the last suggestion was made or
   dismissed for this student). No job queue or scheduler needed; this is
   just another handler on the same `ai.response` topic from §6.3.
2. When triggered, it assembles a compact summary — accuracy per topic
   the student has touched, the `common_errors` entries, whether there's
   a currently active assignment — and asks the model one question: *given
   this student's error patterns, what specific CBC learning outcome
   should they work on next, and why?* It's fine to call the CBC API's
   `/v1/search` here too, seeded with the error patterns as the query, so
   the suggestion is grounded in a real curriculum node rather than a
   free-text guess.
3. The response becomes a new `assignments` row: `source='ai'`,
   `status='suggested'`, `rationale` set to Claude's explanation. This
   does **not** change what the AI scopes itself to — only an `active`
   assignment does that (§9.1).
4. The tutor sees suggested assignments surfaced on Student Detail
   (§10), with the rationale shown, and can accept (→ `active`, pausing
   whatever was active) or dismiss it. Nothing happens automatically
   without the tutor's action — this keeps the tutor as the actual
   decision-maker, with the AI doing the pattern-spotting legwork.

---

## 10. CBC Curriculum API Client

Unchanged from earlier drafts — a thin `fetch` wrapper,
`src/services/cbcApiClient.ts`. Base URL `CBC_API_URL`, auth header
`x-api-key: CBC_API_KEY`.

```typescript
async function getCurriculumTree(grade: number, subject: string)
  // GET {CBC_API_URL}/v1/curriculum/{subject}/{grade}
  // Timeout 5000ms. On failure: throw (Expo app shows an error state).

async function searchCurriculum(query: string, grade: number, subject: string)
  // POST {CBC_API_URL}/v1/search   Body: { query, grade, subject, limit: 3 }
  // Timeout 4000ms. On failure: return [] (AI proceeds without curriculum context).

async function searchContent(query: string, grade: number, subject: string)
  // POST {CBC_API_URL}/v1/content/search   Body: { query, grade, subject, limit: 3 }
  // Timeout 4000ms. On failure: return [] (AI proceeds without content grounding).
```

If `CBC_API_URL`/`CBC_API_KEY` aren't available yet during development,
stub these three functions behind an env check so the rest of the system
degrades exactly as specced (curriculum browsing shows an error state, AI
responses proceed without grounding) rather than crashing — don't invent
fake curriculum data as a permanent fallback.

---

## 11. Development Auth Bypass

The Expo app shouldn't sit blocked on the backend being fully wired before
UI work can start. Support a hardcoded dev login while `kusoma-server` is
still coming together:

- Seed a fixed dev tutor via `db/seed.ts` — a known phone + password, e.g.
  `phone: "0700000000"`, `password: "kusoma-dev"`. The same script also seeds
  the roles, permissions, `role_permissions` grants, and the bot user (§5.2),
  none of which are optional: the RBAC tables are inert without them and
  `messages.sender_user_id` has nothing to point at for bot messages. This
  exercises the real `/auth/login` path, so it's the preferred option as soon
  as any backend exists at all.
- Before that, or as a fallback, gate a client-side bypass behind an env
  flag (e.g. `EXPO_PUBLIC_DEV_BYPASS_AUTH=true`): a "Skip login (dev)"
  affordance on the Auth screen that writes a hardcoded fake
  `{ token: "dev", user: {...}, roles: ["tutor"], permissions: [...] }`
  straight into the session store without calling the backend at all, so
  screens can be built and demoed before `kusoma-server` has an `/auth` route
  working. Include the permission list — otherwise every write affordance
  renders disabled and the bypass is useless for building screens.
- Both paths must be unmistakably dev-only (visibly labeled, env-gated,
  never the default) and easy to strip before anything resembling a real
  deployment.

---

## 12. Expo App — Screens

Build these against the API in §8, using the component-reuse mapping in
§4.4 and the RBAC model in §2.

1. **Auth** — Login/Register tabs. **One login form for everyone**: tutors and
   guardians both post to `POST /auth/login`, and the app branches on the
   `roles` array that comes back. There is no "Parent? Log in here" link and
   no second endpoint — that was Revision 1. Register: display name, phone,
   password → `POST /auth/register` → Onboarding. A caller with role `tutor`
   → Dashboard, or Onboarding if `user.onboarded === false`. A caller with
   role `guardian` → Dashboard, rendered in its read-only form.
2. **Onboarding** (tutor only, once, linear): (1) add a student (name,
   grade picker 1–13, phone) → `POST /students`, get back
   `telegramDeepLink`; (2) show the deep link, instruct the tutor to
   create the group and add their student, tap "Done"; (3) **optional** —
   "Assign a starting topic (optional)" with a clear "Skip for now" action
   alongside the curriculum browser. Either path → `POST
   /onboarding/complete` → Dashboard. Don't make step 3 feel like a
   required gate.
3. **Dashboard** — 2×2 summary cards (Active Students, Engaged Today,
   Total Problems, Avg. Accuracy) from `GET /dashboard/summary`. A guardian
   gets this screen too: the endpoint computes across whatever students the
   caller is related to, so it degrades to their own child's numbers with no
   role branch on either side (§8.2). Plus a student list from `GET /students`:
   name, grade, status pill (green <24h / yellow <72h / red otherwise),
   current topic or "No topic assigned", accuracy %. Tap → Student Detail.
   FAB → add-student flow (tutor only).
4. **Student Detail** (`GET /students/:id`) — header (name, grade,
   active/inactive, Telegram-linked status), assignment card (current
   strand > sub-strand > learning outcome, or a prompt to assign one —
   phrased as an offer, not a requirement — "Change topic" →
   Curriculum Browser), **suggested assignments** section when
   `AssignmentAdvisor` (§9.2) has proposed one (rationale shown, Accept /
   Dismiss actions, gated on `assignments:write`), performance section (per
   topic: accuracy, error patterns, last active), common errors list. For a
   guardian, this same screen renders read-only — no "Change topic", no
   Accept/Dismiss, no add-student FAB — and it falls out of the permission
   check rather than a `role === 'guardian'` branch. It's their Reports view (§2).
5. **Curriculum Browser** (`GET /curriculum/{grade}/mathematics`) —
   expandable strand → sub-strand → learning-outcome tree; selecting one
   does `POST /students/:id/assignments`, navigates back to Student
   Detail, shows a confirmation toast. Reachable from onboarding, from
   Student Detail's "Change topic"/"Assign a topic", and optionally from
   a "assign homework" action — never a screen you're forced through.
6. **Chat** (new) — the in-app view of a student's `chat_group`, built
   from an aniui-sourced chat interface (§4.2) laid over `GET
   /students/:id/messages` for history and the WebSocket connection
   (§6.4) for live updates. Renders student/tutor/bot messages (bot and
   tutor bubbles visually distinct), image attachments inline, a
   composer for the tutor to send (`POST /students/:id/messages`) —
   composer hidden entirely for a guardian, who gets a read-only feed.
   This is the screen that fulfills "track chat interactions back" and
   gives the tutor (and, protectively, the guardian) visibility without
   needing to have Telegram open.

Settings (kept from §4.2, trimmed) rounds out the tab bar with logout,
role-appropriate for whichever principal is signed in.

---

## 13. Environment Variables

`kusoma-server/.env`:
```
DATABASE_URL=              # PostgreSQL connection string
TELEGRAM_BOT_TOKEN=        # From BotFather
TELEGRAM_BOT_USERNAME=     # Without the @ prefix
BACKEND_URL=               # Public URL the Telegram webhook points to (ngrok in dev)
CBC_API_URL=
CBC_API_KEY=

# AWS Bedrock (§9.0) — replaces ANTHROPIC_API_KEY. Omit the key/secret pair
# entirely to use the ambient AWS credential chain (SSO profile, assumed
# role, ECS task role, IMDS), which is the right answer in deployment.
AWS_REGION=us-east-1       # af-south-1 (Cape Town) is the nearest region to Kenya
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=         # only for temporary credentials
BEDROCK_MODEL_ID=anthropic.claude-opus-5

JWT_SECRET=
PORT=3000                  # Express + WebSocket share this port
```

`kusoma-client`:
```
EXPO_PUBLIC_API_URL=              # Fixed backend base URL — replaces Tabibu's user-editable one
EXPO_PUBLIC_WS_URL=               # Same host as API_URL, ws(s):// scheme
EXPO_PUBLIC_DEV_BYPASS_AUTH=      # "true" to show the dev "Skip login" affordance — see §11
```

---

## 14. Suggested Build Order

Sequenced to get something demoable at every step, given the frontend
already has a head start (even though it needs significant pruning). **Read
§16 first** — it defines how deep each phase goes. Phases 3–5 are scaffold
depth on this pass, and "done" for them means *wired and boots*, not
*feature-complete*.

**Phase 0 — `kusoma-client` cleanup** · depth: real
Rebrand incl. green palette (§4.1), delete the EMR-domain code (§4.3),
prune dead deps.
*Done means*: `npx tsc --noEmit` clean and `expo start` runs with whatever
placeholder screens remain. (There is no `typecheck` script in
`package.json` — run `tsc` directly.)

**Phase 1 — Backend foundation + auth** · depth: real
Drizzle schema (§5, **all 11 tables**), migrations, and `db/seed.ts` with the
§5.2 seed data. `/auth/register` + `/auth/login` (one endpoint), the three
middleware helpers from §8.1, `/students` CRUD, `/students/:id/guardians`,
`/onboarding/complete`, `/dashboard/summary`, `/curriculum/:grade/:subject`
proxy.
*Done means*: curl can register a tutor, create a student (and see the
`chat_groups` + `chat_participants` rows appear in the same transaction), add
a guardian, log in as **both through the same endpoint** and get different
`permissions` arrays back, and fetch a curriculum tree. A guardian's token
must fail `PATCH /students/:id` with 403.

**Phase 2 — Core screens (no chat yet)** · depth: real
Auth, Onboarding (with the assignment step genuinely optional), Dashboard,
Student Detail, Curriculum Browser — affordances gated on `permissions`.
*Done means*: register → onboard skipping the topic step → a dashboard with
one student and "No topic assigned" → separately, assign a topic from Student
Detail and see it reflected. Log in as the guardian and confirm the same
screens render without write controls.

**Phase 3 — Telegram + Broker + subscribers** · depth: scaffold
`Broker`/`InMemoryBroker` (§6.1) and the event types (§6.2) are real — they're
tiny and everything else imports them. Every subscriber file exists, is
registered at startup, and handles one happy path with TODOs for the rest.
`/webhook/telegram` parses an update, resolves the sender against
`users.telegram_user_id`, binds `telegram_chat_id` on `/start`, emits
`message.inbound`, returns 200. `setWebhook` at startup.
*Done means*: a student message in a linked Telegram group lands in
`messages` with the right `sender_user_id`, `sender_role`, and attachment
metadata. Bot convenience commands are **not** in scope.

**Phase 4 — Realtime Hub + Chat screen** · depth: scaffold
WebSocket server mounted on the Express HTTP server; connections authenticate
and resolve rooms from `chat_participants` (§6.4). `GET /students/:id/messages`
is real; `POST` is real. AppRealtimeBroadcaster fan-out is a TODO body.
The aniui-based Chat screen renders history; the live WS hookup is a TODO.
*Done means*: history renders in-app, a tutor message posts and relays to
Telegram, and a WS client can connect, authenticate, and be told which rooms
it belongs to.

**Phase 5 — AI orchestrator + dynamic assignments** · depth: scaffold
`src/services/bedrock.ts` constructs the client and makes one working
`messages.create` call against Bedrock. AIOrchestrator is wired to
`ai.request` and returns a reply. Full prompt assembly (§9.1), base64
attachment resolution, performance-JSON extraction, the
`student_performance` UPSERT, and AssignmentAdvisor's thresholds are TODO
bodies with the accept/dismiss endpoints stubbed.
*Done means*: a student message reaches Bedrock and a reply comes back into
the chat. **Verify the model id and AWS credentials resolve before building
anything on top** — a wrong region or an account without Opus 5 access fails
here, and it is much cheaper to find out at this point than after the prompt
logic is written.

Each phase should leave the system runnable — don't move on with the previous
phase half-wired. "Runnable" for a scaffold phase means it boots, registers,
and doesn't throw; it does not mean the feature is finished.

---

## 15. A Few Things to Keep in Mind

- **Assignment is a feature, not a gate.** Every screen and every AI
  interaction needs to make sense for a student with zero assignments,
  forever, if that's how a tutor chooses to use Kusoma.
- **The bot never auto-responds to tutors**, on either platform — that's
  the Router's job, not something baked into the AI prompt.
- **Sender resolution is lazy** — `telegram_user_id` is captured on first
  message in a linked group, never required at registration. It is now one
  lookup against `users`, not a search across two tables.
- **Roles and permissions are data, not code.** A new role is a seed row in
  `roles` plus grants in `role_permissions` — never a new table, never a new
  `if (role === ...)` branch in a handler. If you find yourself adding a
  branch per role, the grant is missing.
- **Chat membership lives in `chat_participants`.** Never re-derive who can
  see a room from `user_roles` or from `chat_groups.owner_user_id` — the
  membership row is the answer, and it's what lets the Hub and the
  broadcaster stay a single query with no role fork (§6.4).
- **Parents are read-only, always.** Enforce this at the route/middleware
  level (§8) *and* via `chat_participants.can_post = false`, not just by
  hiding buttons in the UI — a guardian JWT should not be able to construct a
  request that writes anything.
- **The event bus stays an internal detail.** Whether it's
  `InMemoryBroker` today or a real broker later, subscribers only ever
  import `Broker`/`Handler` from §6.1 — never `EventEmitter` directly, and
  never another subscriber's file.
- If you hit a product decision this document doesn't cover (exact copy,
  spacing, icon choices), make a reasonable call and keep moving — flag it
  in your summary at the end rather than stopping to ask.

---

## 16. Scaffold Contract — how far to build on this pass

The point of this pass is to get the **shape** right: the schema, the module
boundaries, and the wiring. Depth comes later. This section exists so "how far
do I take this?" never has to be guessed mid-build.

### Build for real

- Drizzle schema, migrations, and `db/seed.ts` (§5, §5.2) — all 11 tables and
  every seed row.
- `Broker` + `InMemoryBroker` and the event types (§6.1, §6.2). Small enough
  that a stub costs more than the real thing.
- The three middleware helpers in §8.1, working against the seeded grants.
- These routes, actually querying Postgres: `/auth/register`, `/auth/login`,
  all of `/students*`, `/students/:id/guardians`, `/onboarding/complete`,
  `/dashboard/summary`, the `/curriculum/*` proxy, and
  `GET`/`POST /students/:id/messages`.
- Client Phase 0 (rebrand + strip) and every screen that talks to those
  routes.

### Wire, but keep thin

Each of these gets a real file in the right place, with the right signature,
registered at startup, handling one happy path, and a `// TODO:` for the rest.
The wiring is the deliverable; the logic is not.

- Every `src/subscribers/*.ts` — MessageStore, Router, AIOrchestrator,
  Analytics, TelegramSender, AppRealtimeBroadcaster, AssignmentAdvisor.
- `/webhook/telegram` — parse, resolve sender, bind chat id, emit, 200.
- The WS hub — accept, authenticate, resolve rooms from `chat_participants`.
  Fan-out is a TODO.
- `src/services/bedrock.ts` — client constructed, one `messages.create` call
  that demonstrably works.
- The Chat screen — renders history; live WS hookup is a TODO.

### Deliberately deferred

Don't build these now, and don't half-build them:

- Full §9.1 prompt assembly, and the trailing-performance-JSON extraction.
- `toImageBlock()` base64 attachment resolution (§9.0).
- AssignmentAdvisor's trigger thresholds and CBC-seeded suggestion logic.
- Prompt caching breakpoints.
- Telegram convenience commands (`/status`, `/assign`, `/help`).
- Assignment/homework announcement messages into the group.

### The bar for every phase

`npx tsc --noEmit` is clean and the process boots with all subscribers
registered. A TODO body is fine; a file that doesn't compile, a subscriber
that isn't registered, or a route that 500s on its happy path is not.

When you finish, list in your summary: what you built for real, what you left
as a TODO, and any place where the scaffold forced a decision this document
didn't cover.
