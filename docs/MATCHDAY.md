# Matchday

The coach's operating system around a fixture: plan it, run it (or don't), debrief it, share it.

```
PRE-MATCH                LIVE (existing)               POST-MATCH
/matches/[id]/plan  ──►  /matches/[id]/live  ──►  /matches/[id]/debrief
squad · line-up          broadcast tally +          60-second wizard,
rotation · cheat sheet   plan companion             pre-filled from live
        └──────────── skip live (phone-free) ────────────┘
```

Both workflows are legal in the state machine (`packages/shared/src/matchday/lifecycle.ts`):
`planned → in_progress → completed` and `planned → completed`.

## Where things live

| Layer | Path | What |
|---|---|---|
| Shared core | `packages/shared/src/matchday/` | Types + zod schemas, formation geometry, the rotation engine, the lifecycle machine, the debrief builder and share text. Pure; no DOM. Pinned by `packages/shared/src/__tests__/matchday.test.ts`. |
| Persistence | `apps/web/lib/matchday/store.ts`, `use-matchday.ts` | `MatchdayRepository` over `localStorage`, versioned key per match, schema-validated on read. The hook hydrates after mount and re-reads on cross-tab `storage` events. |
| Plan edits | `apps/web/lib/matchday/plan.ts` | Seeding a squad from the roster, assign/swap/bench, formation change that keeps the same people on, squad edits. Every edit recomputes the rotation. |
| Graphics | `apps/web/lib/matchday/render/` | Canvas renderers: cheat sheet (1080×1920, clock-safe top), WhatsApp card (1080×1350), story (1080×1920). |
| Export | `apps/web/lib/matchday/export.ts` | Web Share with files → clipboard image → download. A dismissed share sheet is "cancelled", never a surprise download. |
| UI | `apps/web/components/matchday/` | `pitch-board` (buttons over an SVG pitch, 2-tap + pointer drag), `squad-panel`, `lineup-builder`, `rotation-planner`, `cheat-sheet`, `plan-workspace`, `live-companion`, `debrief-wizard`, `shareables`, `matchday-hub-card`. |

## The rotation engine

`planRotations()` cuts the match into blocks (`rotationIntervalMinutes`, never straddling a
period break) and, block by block, puts on the pitch the players with the fewest minutes so far.
Ties go to the shorter current stint, then squad order. The first block is the coach's own
starting line-up; substitutes take the vacated slot that matches a preferred position when one
does. Spread is bounded by one block length and the output is deterministic.

- **Dedicated goalkeeper**: excluded from the outfield rotation; outfield minutes are shared among
  everyone else.
- **Rotating goalkeeper**: the keeper for a block is whoever on the pitch has kept goal least. A
  keeper change is a positional shuffle, not a substitution.

## What is and is not persisted where

The matchday record is **device-local**. That is deliberate for the phone-free workflow (no
signal at the pitch) and honest about scope: it does not follow a coach across devices yet.
`MatchdayRepository` is the seam for a Supabase-backed implementation with the same five methods.

Nothing in this module writes `matches`. The confirmed result still enters the system only
through `score_reports`; the debrief's score is the coach's record, and the wizard says so when a
confirmed score exists.

`coachNotes.privateNotes` and `coachNotes.improve` have no code path to any shareable: the
graphics and the text share read `strengths`, scores, events and minutes only.

## Live integration

`LiveScoreboard` is untouched except for one optional prop, `onTallyChange`, which reports the
unofficial tally it already computes. `LiveCompanion` renders the scoreboard and, beneath it, the
plan: a local kickoff clock, the current block, the next substitution with a "done" button, goal
attribution when our side ticks up, and quick save/card logging. That session is what pre-fills
the debrief.
