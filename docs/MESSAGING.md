# Messaging and profile customisation

Added by `supabase/migrations/0011_profiles_and_messaging.sql`. Two features, one document,
because the second one is mostly a statement of how the first one handles other people's data.

## Profile customisation

Six columns on `profiles`, all owner-writable, all in the public directory surface:

| Column | Values | Where it shows |
|---|---|---|
| `accent_color` | gold · teal · vermilion · azure · violet · lime · coral · ice | Set as `--accent-user` on the signed-in shell (`lib/profile/accent.ts`). Nav underline, level ring, avatar ring, own message bubbles, section links. Other people see it as the ring around your avatar. |
| `banner_shot` | the six `BannerShot` names | The live pitch behind your profile card. |
| `tagline` | ≤ 80 chars | Under the name on the card. |
| `jersey_number` | 0–99 | Large, in the accent, on the card. Distinct from a squad number. |
| `dominant_foot` | left · right · both | On the card. |
| `messaging_policy` | everyone · teammates · nobody | See below. |

The card is one component, `components/profile/profile-card.tsx`, rendered on the profile page
with a live canvas behind it and in the account editor as the preview. What you see while
editing is what a teammate sees.

## Messaging

### Shape

```
conversations ──< conversation_members >── profiles
      │
      └──< messages            user_blocks (blocker → blocked)
                │
                └──< message_reports (excerpt snapshot)
```

Direct threads only, one per pair (`direct_key`). Every write is a `SECURITY DEFINER` RPC keyed on
`auth.uid()`; no client role holds `INSERT` on any messaging table, and the migration's
self-test fails if that ever changes. Every read is plain RLS, which is what lets Realtime
stream a thread to its members and nobody else.

| RPC | Does | Refuses with |
|---|---|---|
| `can_message(recipient)` | the whole rule, true/false | — |
| `open_conversation(recipient)` | find-or-create the pair's thread | PT403 policy/block, PT429 |
| `send_message(conversation, body, client_id)` | append; idempotent on `client_id`; one notification per unread thread, **no message text in it** | PT403, PT422, PT429 |
| `mark_conversation_read` · `set_conversation_muted` · `leave_conversation` | membership state | PT403 |
| `delete_message` | sender unsends; body cleared, row kept | — |
| `block_user` · `unblock_user` | both directions; audited | PT429 |
| `report_message(message, reason, details)` | snapshots the body into `message_reports.excerpt`, notifies admins | PT403, PT422, PT429 |
| `my_conversations` · `unread_conversation_count` · `my_blocks` | the inbox, the badge, the block list | — |

### Who may write to whom

`public.can_message()`, in order:

1. never yourself, never an erased account, never across a block in either direction;
2. recipient says **nobody** → no;
3. **either party is under 16** → only an established relationship: an active shared team, or a
   booking between the player and the venue owner. The recipient's policy is not consulted.
4. recipient says **everyone** → yes;
5. recipient says **teammates** (the default) → shared team or booking relationship.

A minor's row cannot hold `everyone` (`profiles_minor_messaging_locked_check`), and the
`enforce_minor_messaging` trigger rewrites an attempt to `teammates` the same way
`enforce_minor_privacy` handles the three privacy switches. The account page renders the option
disabled with the reason, never hidden.

### GDPR

| Right | What happens |
|---|---|
| Art. 6 / consent shape | A stranger cannot open a thread unless you opted in to `everyone`. Default is `teammates`. |
| Art. 8 (minors) | Relationship-only, both directions, regardless of policy. |
| Art. 15 / 20 (access, portability) | `export_my_data()` now includes `conversations` (your memberships), `messages_sent`, `blocks` and `message_reports_filed`. Messages you *received* are not included: they are their authors' data and appear in their exports. |
| Art. 17 (erasure) | `request_account_erasure()` clears the body of every message you sent and stamps `redacted_at`; the other party keeps a thread that shows "message removed". You leave every thread; blocks in either direction are dropped; the customisation columns return to defaults so the pseudonymised row carries no stylistic fingerprint. Report excerpts are retained — Art. 17(3)(e). |
| Art. 5(1)(e) (retention) | `purge_old_messages()` runs nightly (`onpitch-purge-messages`): messages older than a year and tombstones older than 30 days go, then empty threads. |
| Minimisation | The `message.received` notification carries the sender's name and a fixed sentence — never the body. The notification is deleted on erasure like every other notification. |
| Admin access | Admins read `message_reports.excerpt`, never `messages`. There is no admin branch on `messages_select_member`. |
| Blocking | Silent. The blocked person is not told, and the inbox's refusal page does not say why a thread could not be opened. |

### Realtime

`messages`, `conversations` and `conversation_members` are in `supabase_realtime`. The thread
subscribes to `postgres_changes` on `messages` filtered by `conversation_id`; the filter is
bandwidth, `messages_select_member` is the boundary. The inbox and the header badge subscribe to
the other two and re-fetch on an event rather than counting locally, so a read mark made on the
phone clears the badge on the laptop.

### Rate limits

Enforced inside the RPCs through `consume_rate_limit()`, so they apply to a client that talks to
PostgREST directly: 60 messages/minute, 20 new threads/hour, 30 block changes/hour, 10
reports/hour. The same numbers are listed in `lib/rate-limit.ts` so the policy reads as one table.

## Where the UI is

| Route | What |
|---|---|
| `/messages` | inbox (list + empty pane; one pane at a time on a phone) |
| `/messages/[id]` | a thread: optimistic send, live updates, unsend, report, mute, block, leave |
| `/messages/with/[userId]` | the target of every "Mesaj gönder" link: opens or finds the thread and redirects |
| `/players/[id]` | the profile card, "Mesaj gönder" (when `can_message()` says so) and block |
| `/account` | the card editor |
| `/account/privacy` | who may write to you; the block list |
| venue page, booking page, match roster | "Mesaj gönder" where a relationship exists |

### On the phone

The Expo client has the same three things, built on the same RPCs called directly (they carry
the whole rule set, so a route handler would add nothing):

| Where | What |
|---|---|
| `lib/accent.tsx` + `lib/theme.ts` | `AccentProvider` reads `profiles.accent_color`; `useTheme()` folds it into `colors.user`. The tab tint, avatar rings, the level plate's rank and own bubbles use it. |
| `components/profile/profile-card.tsx` | The card. No WebGL on the phone: the six shots are pitch markings drawn from borders on the night ground, tinted with the accent. |
| `app/settings/style.tsx` | The card editor with the live preview. |
| `app/(tabs)/messages.tsx` | The inbox tab, with its own badge. |
| `app/messages/[id].tsx` | A thread: inverted list, optimistic send, long-press to unsend or report, mute/block/leave behind the avatar. |
| `app/messages/with/[userId].tsx` | The target of every "Mesaj gönder" button; replaces itself with the thread. |
| `lib/messaging.ts` | The hooks (`useConversations`, `useThread`, `useUnreadConversations`) and the actions. |
| `app/settings/privacy.tsx` | Who may write to you; the block list. |
