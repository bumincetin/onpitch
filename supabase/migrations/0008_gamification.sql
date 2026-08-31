-- =============================================================================
-- Halisaha — 0008_gamification.sql
-- Progression, streaks, achievements, weekly challenges and leaderboards.
--
-- WHAT THIS FILE OWNS
--   * public.player_progress      — one row per player: XP, level, counters, streak
--   * public.xp_events            — append-only XP ledger, idempotent by dedupe key
--   * public.achievements         — the catalogue (seeded here)
--   * public.player_achievements  — who has unlocked what, and progress toward the rest
--   * public.challenges           — dated, repeating weekly objectives
--   * public.challenge_progress   — per-player progress and claim state
--   * public.award_xp             — the ONLY way XP is created
--   * public.my_progress          — the caller's whole progression state, one round trip
--   * public.leaderboard_page     — privacy-filtered ranking
--   * public.venue_scorecard      — the venue owner's equivalent of a level
--   * triggers on matches and bookings that turn events into progression
--   * two cron jobs: weekly challenge rollover, and a streak-expiry nudge
--
-- DEPENDS ON: 0001 (schema), 0002 (RLS conventions, private helpers),
--             0003 (notifications producers), 0004 (player_ratings).
--
-- ---------------------------------------------------------------------------
-- THE ONE INVARIANT
-- ---------------------------------------------------------------------------
-- XP is never computed at read time and never incremented by application code.
-- Every point that exists has a row in `xp_events` explaining where it came
-- from, and `player_progress.xp` is the running total of that ledger. That is
-- what makes the system auditable ("why am I level 7?"), replayable, and safe
-- to run from a trigger that may fire twice: every award carries a
-- `dedupe_key`, and a second attempt to award the same thing is a no-op rather
-- than a duplicate.
--
-- ---------------------------------------------------------------------------
-- WHY A GENERATED LEVEL
-- ---------------------------------------------------------------------------
-- `level` is GENERATED ALWAYS AS (private.level_for_xp(xp)) STORED, so it can
-- never disagree with the XP it is derived from. The curve is duplicated in
-- packages/shared/src/gamification.ts for the clients, and the self-test at the
-- bottom of this file pins the boundary values both sides must agree on.
-- =============================================================================

set search_path = public, extensions;


-- =============================================================================
-- 1. Enums
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'xp_event_kind') then
    create type public.xp_event_kind as enum (
      'match_played',
      'match_won',
      'match_drawn',
      'goal',
      'assist',
      'clean_sheet',
      'score_reported',
      'consensus_voted',
      'booking_paid',
      'streak_bonus',
      'achievement',
      'challenge',
      'onboarding',
      'admin_adjustment'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'achievement_tier') then
    create type public.achievement_tier as enum ('bronze', 'silver', 'gold', 'platinum');
  end if;

  -- The metric a challenge or achievement counts. Every value here must have a
  -- matching column on public.player_progress; private.counter_for_metric() is the
  -- single place that mapping lives.
  if not exists (select 1 from pg_type where typname = 'progress_metric') then
    create type public.progress_metric as enum (
      'matches_played',
      'matches_won',
      'goals',
      'assists',
      'clean_sheets',
      'bookings_paid',
      'distinct_venues',
      'reports_filed',
      'consensus_votes',
      'late_matches',
      'hat_tricks',
      'best_unbeaten_run',
      'current_streak_weeks',
      'teams_captained'
    );
  end if;
end
$$;


-- =============================================================================
-- 2. The level curve
-- =============================================================================
-- Cumulative XP to REACH level L is 50 * L * (L - 1):
--
--     L1 0 · L2 100 · L3 300 · L4 600 · L5 1000 · L10 4500 · L20 19000
--
-- so the step from L to L+1 is a flat 100 * L. A finished match is worth
-- roughly 40-120 XP, which puts level 2 at about two matches and level 10 at
-- about a season of weekly football. That is the intended shape: fast enough
-- that the first week feels like progress, slow enough that level 20 means
-- something.

create or replace function private.xp_for_level(p_level integer)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
           when p_level is null or p_level < 1 then 0::bigint
           else 50::bigint * p_level * (p_level - 1)
         end;
$$;

comment on function private.xp_for_level(integer) is
  'Cumulative XP required to reach a level. Mirrored by xpForLevel() in @halisaha/shared/gamification.';

-- The inverse. The closed form is L = floor((1 + sqrt(1 + xp/12.5)) / 2), but
-- float64 makes that unreliable exactly ON a boundary — the one place it is
-- read most — so the candidate is corrected against the exact integer curve
-- afterwards. Two comparisons, no loop, and provably right at every boundary.
create or replace function private.level_for_xp(p_xp bigint)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  with candidate as (
    select greatest(
             1,
             floor((1 + sqrt(1 + coalesce(p_xp, 0)::double precision / 12.5)) / 2)::integer
           ) as lvl
  )
  select case
           when 50::bigint * (lvl + 1) * lvl <= coalesce(p_xp, 0) then lvl + 1
           when 50::bigint * lvl * (lvl - 1) > coalesce(p_xp, 0)  then greatest(1, lvl - 1)
           else lvl
         end
    from candidate;
$$;

comment on function private.level_for_xp(bigint) is
  'Level for a cumulative XP total. IMMUTABLE so player_progress.level can be GENERATED STORED.';


-- =============================================================================
-- 3. Tables
-- =============================================================================

-- 3.1 player_progress — the denormalised read model.
--
-- Every counter here is derivable from the rest of the schema. It is kept
-- anyway because a dashboard that recomputed "goals across every finalized
-- match" on each page load would be the slowest query in the product, and
-- because an achievement evaluator needs to compare against a number, not
-- against an aggregate.
create table if not exists public.player_progress (
  player_id             uuid primary key references public.profiles (id) on delete cascade,

  xp                    bigint  not null default 0 check (xp >= 0),
  level                 integer generated always as (private.level_for_xp(xp)) stored,

  -- Weekly play streak. A week counts if the player appeared in a finalized
  -- match during it; the streak survives one missed week only by resetting.
  current_streak_weeks  integer not null default 0 check (current_streak_weeks >= 0),
  longest_streak_weeks  integer not null default 0 check (longest_streak_weeks >= 0),
  /** Monday of the most recent week that counted, so the next award is a date comparison. */
  last_streak_week      date,
  last_played_on        date,

  -- Counters the achievement and challenge evaluators read.
  matches_played        integer not null default 0 check (matches_played >= 0),
  matches_won           integer not null default 0 check (matches_won >= 0),
  matches_drawn         integer not null default 0 check (matches_drawn >= 0),
  matches_lost          integer not null default 0 check (matches_lost >= 0),
  goals                 integer not null default 0 check (goals >= 0),
  assists               integer not null default 0 check (assists >= 0),
  clean_sheets          integer not null default 0 check (clean_sheets >= 0),
  hat_tricks            integer not null default 0 check (hat_tricks >= 0),
  late_matches          integer not null default 0 check (late_matches >= 0),
  distinct_venues       integer not null default 0 check (distinct_venues >= 0),
  bookings_paid         integer not null default 0 check (bookings_paid >= 0),
  reports_filed         integer not null default 0 check (reports_filed >= 0),
  consensus_votes       integer not null default 0 check (consensus_votes >= 0),
  teams_captained       integer not null default 0 check (teams_captained >= 0),
  current_unbeaten_run  integer not null default 0 check (current_unbeaten_run >= 0),
  best_unbeaten_run     integer not null default 0 check (best_unbeaten_run >= 0),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint player_progress_streak_order_check
    check (longest_streak_weeks >= current_streak_weeks),
  constraint player_progress_unbeaten_order_check
    check (best_unbeaten_run >= current_unbeaten_run)
);

comment on table public.player_progress is
  'One row per player: XP, derived level, weekly streak, and the counters achievements read.';

create index if not exists idx_player_progress_xp
  on public.player_progress (xp desc);
create index if not exists idx_player_progress_streak
  on public.player_progress (current_streak_weeks desc)
  where current_streak_weeks > 0;
-- The nightly streak-expiry sweep scans exactly this slice.
create index if not exists idx_player_progress_last_streak_week
  on public.player_progress (last_streak_week)
  where current_streak_weeks > 0;


-- 3.2 xp_events — the ledger.
create table if not exists public.xp_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        public.xp_event_kind not null,
  points      integer not null check (points <> 0),
  /**
   * Idempotency key, e.g. 'match:<uuid>:won' or 'ach:centurion'. Two awards with
   * the same key for the same user are the same award; the second is dropped.
   * NULL means "unconditional" and is reserved for admin adjustments.
   */
  dedupe_key  text,
  match_id    uuid references public.matches (id) on delete set null,
  booking_id  uuid references public.bookings (id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.xp_events is
  'Append-only XP ledger. player_progress.xp is the sum of this table; nothing else may write it.';

create unique index if not exists uq_xp_events_dedupe
  on public.xp_events (user_id, dedupe_key)
  where dedupe_key is not null;
create index if not exists idx_xp_events_user_created
  on public.xp_events (user_id, created_at desc);
create index if not exists idx_xp_events_match_id
  on public.xp_events (match_id) where match_id is not null;
create index if not exists idx_xp_events_booking_id
  on public.xp_events (booking_id) where booking_id is not null;


-- 3.3 achievements — the catalogue. Public, static, seeded below.
create table if not exists public.achievements (
  code        text primary key check (code ~ '^[a-z][a-z0-9_]{2,39}$'),
  name        text not null,
  description text not null,
  tier        public.achievement_tier not null,
  metric      public.progress_metric not null,
  target      integer not null check (target > 0),
  xp_reward   integer not null default 0 check (xp_reward >= 0),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table public.achievements is
  'The badge catalogue. Readable by everyone including anon: a signed-out visitor should be able to see what there is to earn.';

create index if not exists idx_achievements_active_sort
  on public.achievements (sort_order, code) where is_active;


-- 3.4 player_achievements — unlock state.
create table if not exists public.player_achievements (
  user_id           uuid not null references public.profiles (id) on delete cascade,
  achievement_code  text not null references public.achievements (code) on delete cascade,
  progress          integer not null default 0 check (progress >= 0),
  unlocked_at       timestamptz,
  /** True once the XP reward has been paid, so a re-evaluation never pays twice. */
  rewarded          boolean not null default false,
  updated_at        timestamptz not null default now(),
  primary key (user_id, achievement_code)
);

create index if not exists idx_player_achievements_user
  on public.player_achievements (user_id);
create index if not exists idx_player_achievements_code
  on public.player_achievements (achievement_code);
create index if not exists idx_player_achievements_unlocked
  on public.player_achievements (user_id, unlocked_at desc)
  where unlocked_at is not null;


-- 3.5 challenges — dated objectives. One set per ISO week, created by cron.
create table if not exists public.challenges (
  id          uuid primary key default gen_random_uuid(),
  /** Stable slug identifying the challenge ACROSS weeks, e.g. 'weekly_two_matches'. */
  code        text not null check (code ~ '^[a-z][a-z0-9_]{2,47}$'),
  title       text not null,
  description text not null,
  metric      public.progress_metric not null,
  target      integer not null check (target > 0),
  xp_reward   integer not null default 0 check (xp_reward >= 0),
  starts_on   date not null,
  ends_on     date not null,
  created_at  timestamptz not null default now(),

  constraint challenges_window_check check (ends_on >= starts_on),
  constraint challenges_unique_per_window unique (code, starts_on)
);

comment on table public.challenges is
  'Weekly objectives. `code` repeats week to week; (code, starts_on) is the identity of one running of it.';

create index if not exists idx_challenges_window
  on public.challenges (starts_on desc, ends_on desc);


-- 3.6 challenge_progress — per player, per running.
--
-- `baseline` is what makes a weekly challenge weekly. Progress is measured as
-- (counter now - counter when the player first saw this challenge), so
-- "play two matches" means two matches THIS WEEK rather than two matches ever.
create table if not exists public.challenge_progress (
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  baseline     integer not null default 0 check (baseline >= 0),
  progress     integer not null default 0 check (progress >= 0),
  completed_at timestamptz,
  claimed_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (challenge_id, user_id),

  constraint challenge_progress_claim_needs_completion
    check (claimed_at is null or completed_at is not null)
);

create index if not exists idx_challenge_progress_user
  on public.challenge_progress (user_id);
create index if not exists idx_challenge_progress_challenge
  on public.challenge_progress (challenge_id);
create index if not exists idx_challenge_progress_claimable
  on public.challenge_progress (user_id)
  where completed_at is not null and claimed_at is null;


-- =============================================================================
-- 4. updated_at triggers
-- =============================================================================

-- public.set_updated_at() is defined in 0001 and already attached to every other
-- table carrying the column. Reusing it keeps one definition of "touch the row".

drop trigger if exists trg_player_progress_set_updated_at on public.player_progress;
create trigger trg_player_progress_set_updated_at
  before update on public.player_progress
  for each row execute function public.set_updated_at();

drop trigger if exists trg_player_achievements_set_updated_at on public.player_achievements;
create trigger trg_player_achievements_set_updated_at
  before update on public.player_achievements
  for each row execute function public.set_updated_at();

drop trigger if exists trg_challenge_progress_set_updated_at on public.challenge_progress;
create trigger trg_challenge_progress_set_updated_at
  before update on public.challenge_progress
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 5. The award primitive
-- =============================================================================

create or replace function private.ensure_progress_row(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.player_progress (player_id)
  values (p_user_id)
  on conflict (player_id) do nothing;
$$;

-- Reads one counter off a progress row by metric name. Every
-- public.progress_metric value must appear here: a missing branch returns NULL,
-- which the self-test at the bottom of the file turns into a migration failure
-- rather than a challenge that silently never completes in production.
create or replace function private.counter_for_metric(
  p_row public.player_progress,
  p_metric public.progress_metric
)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_metric
           when 'matches_played'       then p_row.matches_played
           when 'matches_won'          then p_row.matches_won
           when 'goals'                then p_row.goals
           when 'assists'              then p_row.assists
           when 'clean_sheets'         then p_row.clean_sheets
           when 'bookings_paid'        then p_row.bookings_paid
           when 'distinct_venues'      then p_row.distinct_venues
           when 'reports_filed'        then p_row.reports_filed
           when 'consensus_votes'      then p_row.consensus_votes
           when 'late_matches'         then p_row.late_matches
           when 'hat_tricks'           then p_row.hat_tricks
           when 'best_unbeaten_run'    then p_row.best_unbeaten_run
           when 'current_streak_weeks' then p_row.current_streak_weeks
           when 'teams_captained'      then p_row.teams_captained
         end;
$$;

/**
 * The only way XP is created.
 *
 * Returns the points ACTUALLY awarded: 0 when `p_dedupe_key` has already been
 * used by this user, which is what makes every caller safe to re-run. A level
 * crossing raises a `progress.level_up` notification as a side effect, because
 * the moment somebody levels up is the moment worth telling them about and a
 * client that polled for it would always be late.
 */
create or replace function public.award_xp(
  p_user_id    uuid,
  p_kind       public.xp_event_kind,
  p_points     integer,
  p_dedupe_key text default null,
  p_match_id   uuid default null,
  p_booking_id uuid default null,
  p_metadata   jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted  integer := 0;
  v_old_level integer;
  v_new_level integer;
begin
  if p_user_id is null or p_points is null or p_points = 0 then
    return 0;
  end if;

  perform private.ensure_progress_row(p_user_id);

  insert into public.xp_events (user_id, kind, points, dedupe_key, match_id, booking_id, metadata)
  values (p_user_id, p_kind, p_points, p_dedupe_key, p_match_id, p_booking_id,
          coalesce(p_metadata, '{}'::jsonb))
  on conflict do nothing;

  -- ROW_COUNT is 0 when the ON CONFLICT above swallowed the insert, which is
  -- precisely the "this was already awarded" case.
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return 0;
  end if;

  select pp.level into v_old_level
    from public.player_progress pp
   where pp.player_id = p_user_id;

  update public.player_progress
     set xp = greatest(0, xp + p_points)
   where player_id = p_user_id
  returning level into v_new_level;

  if v_new_level > coalesce(v_old_level, 1) then
    insert into public.notifications (user_id, type, title, body, data)
    values (
      p_user_id,
      'progress.level_up',
      format('Seviye %s', v_new_level),
      format('Tebrikler — %s. seviyeye ulaştın.', v_new_level),
      jsonb_build_object('level', v_new_level, 'previousLevel', coalesce(v_old_level, 1))
    );
  end if;

  return p_points;
end;
$$;

comment on function public.award_xp is
  'Creates one XP ledger row and advances the running total. Idempotent per (user, dedupe_key).';


-- =============================================================================
-- 6. Achievements
-- =============================================================================

/**
 * Recomputes every achievement row for one player from their counters.
 *
 * Deliberately a full re-evaluation rather than an incremental one. It runs
 * once per finalized match per player, reads a single row, and being total
 * means a catalogue addition backfills itself the next time anybody plays —
 * no migration-time backfill job that has to be right the first time.
 */
create or replace function public.evaluate_achievements(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_progress public.player_progress;
  v_ach      record;
  v_value    integer;
  v_unlocked integer := 0;
begin
  if p_user_id is null then
    return 0;
  end if;

  perform private.ensure_progress_row(p_user_id);

  select * into v_progress
    from public.player_progress
   where player_id = p_user_id;

  for v_ach in
    select * from public.achievements where is_active order by sort_order, code
  loop
    v_value := coalesce(private.counter_for_metric(v_progress, v_ach.metric), 0);

    insert into public.player_achievements (user_id, achievement_code, progress, unlocked_at)
    values (
      p_user_id,
      v_ach.code,
      least(v_value, v_ach.target),
      case when v_value >= v_ach.target then now() else null end
    )
    on conflict (user_id, achievement_code) do update
      set progress    = least(excluded.progress, v_ach.target),
          -- Once unlocked, always unlocked. A counter cannot go backwards
          -- today, but a future correction must not silently revoke a badge.
          unlocked_at = coalesce(public.player_achievements.unlocked_at, excluded.unlocked_at);

    -- Pay the reward exactly once, and only after the row says unlocked.
    if v_value >= v_ach.target then
      update public.player_achievements
         set rewarded = true
       where user_id = p_user_id
         and achievement_code = v_ach.code
         and not rewarded;

      if found then
        v_unlocked := v_unlocked + 1;

        if v_ach.xp_reward > 0 then
          perform public.award_xp(
            p_user_id,
            'achievement',
            v_ach.xp_reward,
            'ach:' || v_ach.code,
            null,
            null,
            jsonb_build_object('code', v_ach.code, 'tier', v_ach.tier)
          );
        end if;

        insert into public.notifications (user_id, type, title, body, data)
        values (
          p_user_id,
          'progress.achievement',
          v_ach.name,
          v_ach.description,
          jsonb_build_object('code', v_ach.code, 'tier', v_ach.tier, 'xp', v_ach.xp_reward)
        );
      end if;
    end if;
  end loop;

  return v_unlocked;
end;
$$;


-- 6.1 The catalogue.
--
-- Seeded with ON CONFLICT DO UPDATE so re-running the migration edits copy in
-- place. `code` is the stable identity: renaming one orphans every unlock.
insert into public.achievements (code, name, description, tier, metric, target, xp_reward, sort_order)
values
  ('first_whistle',  'İlk düdük',        'İlk maçını oyna.',                                   'bronze',   'matches_played',       1,   50,  10),
  ('regular',        'Devamlı',          'On maç tamamla.',                                    'bronze',   'matches_played',      10,  100,  20),
  ('fifty_caps',     'Ellilik',          'Elli maç tamamla.',                                  'silver',   'matches_played',      50,  300,  30),
  ('centurion',      'Yüzler Kulübü',    'Yüz maç tamamla.',                                   'gold',     'matches_played',     100,  800,  40),
  ('first_goal',     'İlk gol',          'İlk golünü at.',                                     'bronze',   'goals',                1,   50,  50),
  ('sharpshooter',   'Nişancı',          'Toplam yirmi beş gol at.',                           'silver',   'goals',               25,  250,  60),
  ('hat_trick',      'Hat-trick',        'Bir maçta üç gol at.',                               'silver',   'hat_tricks',           1,  200,  70),
  ('playmaker',      'Oyun kurucu',      'Toplam yirmi beş asist yap.',                        'silver',   'assists',             25,  250,  80),
  ('wall',           'Duvar',            'Gol yemeden biten beş maçta sahada ol.',             'silver',   'clean_sheets',         5,  200,  90),
  ('unbeaten_five',  'Namağlup beş',     'Üst üste beş maç yenilme.',                          'gold',     'best_unbeaten_run',    5,  400, 100),
  ('winner_25',      'Kazanan',          'Yirmi beş maç kazan.',                               'silver',   'matches_won',         25,  300, 110),
  ('night_owl',      'Gece kuşu',        'Saat 22.00 sonrası başlayan on maç oyna.',           'bronze',   'late_matches',        10,  120, 120),
  ('explorer',       'Gezgin',           'Beş farklı sahada oyna.',                            'silver',   'distinct_venues',      5,  220, 130),
  ('host',           'Ev sahibi',        'On rezervasyonun ödemesini sen yap.',                'silver',   'bookings_paid',       10,  250, 140),
  ('honest_broker',  'Dürüst tanık',     'Yirmi maç sonucu bildir.',                           'silver',   'reports_filed',       20,  200, 150),
  ('jury',           'Jüri',             'On kez uzlaşma oylamasına katıl.',                   'silver',   'consensus_votes',     10,  200, 160),
  ('four_weeks',     'Dört hafta',       'Dört hafta üst üste maç yap.',                       'silver',   'current_streak_weeks', 4,  250, 170),
  ('all_season',     'Sezon boyu',       'On iki hafta üst üste maç yap.',                     'platinum', 'current_streak_weeks',12,  900, 180),
  ('armband',        'Pazubent',         'Bir takıma kaptanlık yap.',                          'bronze',   'teams_captained',      1,  100, 190)
on conflict (code) do update
  set name        = excluded.name,
      description = excluded.description,
      tier        = excluded.tier,
      metric      = excluded.metric,
      target      = excluded.target,
      xp_reward   = excluded.xp_reward,
      sort_order  = excluded.sort_order,
      is_active   = true;


-- =============================================================================
-- 7. Challenges
-- =============================================================================

/**
 * Creates this week's challenges if they are not there yet.
 *
 * Idempotent by (code, starts_on), so it is safe to call from cron, from a
 * deploy, and from a page load. Weeks start on Monday because that is what
 * date_trunc('week') means in Postgres and what a Turkish football week means
 * to a player.
 */
create or replace function public.ensure_weekly_challenges(p_week_start date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date := coalesce(p_week_start, (date_trunc('week', now())::date));
  v_end   date := v_start + 6;
  v_added integer := 0;
begin
  insert into public.challenges (code, title, description, metric, target, xp_reward, starts_on, ends_on)
  values
    ('weekly_two_matches', 'Haftada iki maç',  'Bu hafta iki maç tamamla.',            'matches_played', 2, 120, v_start, v_end),
    ('weekly_scorer',      'Fileyi bul',       'Bu hafta üç gol at.',                  'goals',          3, 150, v_start, v_end),
    ('weekly_reporter',    'Sonucu bildir',    'Bu hafta iki maçın sonucunu bildir.',  'reports_filed',  2,  90, v_start, v_end)
  on conflict (code, starts_on) do nothing;

  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

/**
 * Brings one player's rows up to date for every currently-running challenge.
 *
 * The baseline is captured on first sight, which is why this is called on read
 * as well as on write: a player who joins mid-week starts from where they are
 * rather than being handed credit for matches they played before the challenge
 * existed.
 */
create or replace function public.sync_challenge_progress(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_progress  public.player_progress;
  v_challenge record;
  v_value     integer;
  v_completed integer := 0;
  v_today     date := (now() at time zone 'utc')::date;
begin
  if p_user_id is null then
    return 0;
  end if;

  perform private.ensure_progress_row(p_user_id);

  select * into v_progress from public.player_progress where player_id = p_user_id;

  for v_challenge in
    select * from public.challenges
     where starts_on <= v_today and ends_on >= v_today
     order by starts_on, code
  loop
    v_value := coalesce(private.counter_for_metric(v_progress, v_challenge.metric), 0);

    -- First sight: record where this player stood, and claim no progress yet.
    insert into public.challenge_progress (challenge_id, user_id, baseline, progress)
    values (v_challenge.id, p_user_id, v_value, 0)
    on conflict (challenge_id, user_id) do nothing;

    update public.challenge_progress cp
       set progress     = least(greatest(0, v_value - cp.baseline), v_challenge.target),
           completed_at = case
                            when cp.completed_at is not null then cp.completed_at
                            when v_value - cp.baseline >= v_challenge.target then now()
                            else null
                          end
     where cp.challenge_id = v_challenge.id
       and cp.user_id = p_user_id
       and cp.claimed_at is null;
  end loop;

  -- How many rewards are sitting there waiting to be collected. One query at
  -- the end rather than one per challenge inside the loop.
  select count(*)::integer into v_completed
    from public.challenge_progress cp
    join public.challenges c on c.id = cp.challenge_id
   where cp.user_id = p_user_id
     and cp.completed_at is not null
     and cp.claimed_at is null
     and c.starts_on <= v_today
     and c.ends_on >= v_today;

  return v_completed;
end;
$$;

/**
 * Claims the reward for a completed challenge. Caller-scoped: this is the one
 * function in the file a client invokes directly, so it reads auth.uid()
 * itself rather than trusting a user id argument.
 */
create or replace function public.claim_challenge(p_challenge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid := (select auth.uid());
  v_challenge public.challenges;
  v_awarded   integer := 0;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_challenge from public.challenges where id = p_challenge_id;
  if not found then
    raise exception 'Challenge not found' using errcode = 'P0002';
  end if;

  -- The UPDATE is the lock: only the transaction that flips claimed_at from
  -- NULL pays out, so two taps on a slow connection award once.
  update public.challenge_progress
     set claimed_at = now()
   where challenge_id = p_challenge_id
     and user_id = v_user
     and completed_at is not null
     and claimed_at is null;

  if not found then
    return jsonb_build_object('claimed', false, 'xp', 0);
  end if;

  v_awarded := public.award_xp(
    v_user,
    'challenge',
    v_challenge.xp_reward,
    'chal:' || v_challenge.id::text,
    null,
    null,
    jsonb_build_object('code', v_challenge.code, 'startsOn', v_challenge.starts_on)
  );

  return jsonb_build_object('claimed', true, 'xp', v_awarded, 'code', v_challenge.code);
end;
$$;


-- =============================================================================
-- 8. Streaks
-- =============================================================================

/**
 * Recomputes a player's weekly streak from their match history.
 *
 * RECOMPUTE, NOT INCREMENT — for the same reason every other counter in this file is
 * recomputed. An incremental streak depends on the ORDER events arrive in, and the moment
 * anything is back-dated (a seeder writing a season oldest-last, an admin correcting a fixture,
 * a delayed finalization) it silently stops counting: the newer week is already recorded, so
 * the older one looks like a repeat and is skipped. This version reads the whole history and is
 * right afterwards no matter what order it was called in.
 *
 * The grouping is the classic gaps-and-islands trick: subtracting seven days per row from an
 * ordered list of distinct weeks gives every consecutive run the same anchor, so a run is a
 * GROUP BY rather than a walk.
 *
 * Weeks, not days, on purpose. Amateur football is a weekly commitment and a daily streak would
 * punish exactly the people this product is for.
 *
 * Returns the length of the run ENDING at `p_week` — which is what the caller pays the bonus
 * on — or 0 when that week is not one the player played in.
 */
create or replace function private.recompute_play_streak(
  p_user_id uuid,
  p_week    date default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_this_week date := date_trunc('week', now())::date;
  v_current   integer := 0;
  v_longest   integer := 0;
  v_last_week date;
  v_last_day  date;
  v_at_week   integer := 0;
begin
  perform private.ensure_progress_row(p_user_id);

  with weeks as (
    select distinct
           date_trunc('week', (m.kickoff_at at time zone 'utc')::date)::date as wk,
           max((m.kickoff_at at time zone 'utc')::date) over ()              as last_day
      from public.match_participants mp
      join public.matches m on m.id = mp.match_id
     where mp.player_id = p_user_id
       and m.status = 'finalized'
  ),
  anchored as (
    select wk,
           last_day,
           -- Same anchor => same unbroken run of weeks.
           wk - ((row_number() over (order by wk))::integer * 7) as anchor
      from weeks
  ),
  runs as (
    select anchor, count(*)::integer as len, max(wk) as end_wk, max(last_day) as last_day
      from anchored
     group by anchor
  )
  select
    coalesce(max(len), 0),
    -- "Current" means the run is still live: it reached this week, or last week and the
    -- player still has the whole of this week to keep it going.
    coalesce(max(len) filter (where end_wk >= v_this_week - 7), 0),
    max(end_wk),
    max(last_day)
  into v_longest, v_current, v_last_week, v_last_day
  from runs;

  if p_week is not null then
    select count(*)::integer
      into v_at_week
      from (
        select wk,
               wk - ((row_number() over (order by wk))::integer * 7) as anchor
          from (
            select distinct date_trunc('week', (m.kickoff_at at time zone 'utc')::date)::date as wk
              from public.match_participants mp
              join public.matches m on m.id = mp.match_id
             where mp.player_id = p_user_id
               and m.status = 'finalized'
          ) w
      ) a
     where a.wk <= p_week
       and a.anchor = (select a2.anchor from (
             select wk, wk - ((row_number() over (order by wk))::integer * 7) as anchor
               from (
                 select distinct date_trunc('week', (m.kickoff_at at time zone 'utc')::date)::date as wk
                   from public.match_participants mp
                   join public.matches m on m.id = mp.match_id
                  where mp.player_id = p_user_id
                    and m.status = 'finalized'
               ) w2
           ) a2 where a2.wk = date_trunc('week', p_week)::date);
  end if;

  update public.player_progress
     set current_streak_weeks = v_current,
         longest_streak_weeks = greatest(v_longest, v_current),
         last_streak_week     = v_last_week,
         last_played_on       = v_last_day
   where player_id = p_user_id;

  return v_at_week;
end;
$$;

/**
 * Nightly: ends a streak whose week has passed without a match.
 *
 * Without this a streak would read as "live" forever, since nothing else in
 * the system runs when a player DOESN'T play. The warning notification fires
 * on the last day of the grace window rather than after the fact, which is the
 * only moment it can still change anybody's behaviour.
 */
create or replace function public.expire_play_streaks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_this_week date := date_trunc('week', now())::date;
  v_expired   integer := 0;
  v_row       record;
begin
  -- A streak survives the whole of the following week. It dies when the week after that begins
  -- with no match in between. The recompute below reaches the same conclusion on its own; this
  -- predicate is only here to keep the sweep off the rows that cannot have changed.
  for v_row in
    select player_id
      from public.player_progress
     where current_streak_weeks > 0
       and last_streak_week is not null
       and last_streak_week < v_this_week - 7
  loop
    perform private.recompute_play_streak(v_row.player_id);
    v_expired := v_expired + 1;
  end loop;

  -- One nudge, on the Sunday of the grace week, to whoever can still save it. Sent before the
  -- fact rather than after, because that is the only moment it can change anybody's behaviour.
  if extract(isodow from now()) = 7 then
    insert into public.notifications (user_id, type, title, body, data)
    select pp.player_id,
           'progress.streak_risk',
           format('%s haftalık serin bitmek üzere', pp.current_streak_weeks),
           'Bu hafta bir maç yaparsan serin devam eder.',
           jsonb_build_object('weeks', pp.current_streak_weeks)
      from public.player_progress pp
     where pp.current_streak_weeks > 0
       and pp.last_streak_week = v_this_week - 7
       and not exists (
             select 1 from public.notifications n
              where n.user_id = pp.player_id
                and n.type = 'progress.streak_risk'
                and n.created_at >= v_this_week
           );
  end if;

  return v_expired;
end;
$$;


-- =============================================================================
-- 9. Turning events into progression
-- =============================================================================

/**
 * Everything one finalized match is worth, for every player who was in it.
 *
 * Called from a trigger on `matches`, and safe to call again by hand: every
 * award is keyed on the match id, and the counters are recomputed from the
 * source tables rather than incremented, so a second run converges instead of
 * doubling.
 */
create or replace function public.apply_match_progression(p_match_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match     public.matches;
  v_row       record;
  v_players   integer := 0;
  v_played_on date;
  v_run       integer;
begin
  select * into v_match from public.matches where id = p_match_id;
  if not found or v_match.status <> 'finalized' then
    return 0;
  end if;

  v_played_on := (v_match.kickoff_at at time zone 'utc')::date;

  for v_row in
    select mp.player_id,
           mp.team_side,
           coalesce(ps.goals, 0)   as goals,
           coalesce(ps.assists, 0) as assists
      from public.match_participants mp
      left join public.player_stats ps
             on ps.match_id = mp.match_id and ps.player_id = mp.player_id
     where mp.match_id = p_match_id
  loop
    v_players := v_players + 1;

    perform private.ensure_progress_row(v_row.player_id);

    -- Turning up.
    perform public.award_xp(v_row.player_id, 'match_played', 40,
                            'match:' || p_match_id::text || ':played', p_match_id);

    -- The result, when there is one.
    if v_match.home_score is not null and v_match.away_score is not null then
      if (v_row.team_side = 'home' and v_match.home_score > v_match.away_score)
         or (v_row.team_side = 'away' and v_match.away_score > v_match.home_score) then
        perform public.award_xp(v_row.player_id, 'match_won', 35,
                                'match:' || p_match_id::text || ':won', p_match_id);
      elsif v_match.home_score = v_match.away_score then
        perform public.award_xp(v_row.player_id, 'match_drawn', 15,
                                'match:' || p_match_id::text || ':drawn', p_match_id);
      end if;

      -- A clean sheet belongs to everyone who kept it, not only the keeper.
      if (v_row.team_side = 'home' and v_match.away_score = 0)
         or (v_row.team_side = 'away' and v_match.home_score = 0) then
        perform public.award_xp(v_row.player_id, 'clean_sheet', 20,
                                'match:' || p_match_id::text || ':cs', p_match_id);
      end if;
    end if;

    -- Contributions, capped so one lopsided friendly cannot buy a level.
    if v_row.goals > 0 then
      perform public.award_xp(v_row.player_id, 'goal', least(v_row.goals, 6) * 10,
                              'match:' || p_match_id::text || ':goals', p_match_id,
                              null, jsonb_build_object('goals', v_row.goals));
    end if;
    if v_row.assists > 0 then
      perform public.award_xp(v_row.player_id, 'assist', least(v_row.assists, 6) * 7,
                              'match:' || p_match_id::text || ':assists', p_match_id,
                              null, jsonb_build_object('assists', v_row.assists));
    end if;

    /*
     * Baseline BEFORE the counters move, progress AFTER.
     *
     * `sync_challenge_progress` captures a baseline the first time it sees a player against a
     * running challenge, and measures progress as (counter now - baseline). Called only after
     * the recompute below, the very first match of the week would be folded into its own
     * baseline and earn nothing — "play two matches" would silently need three. The first call
     * fixes the baseline at the pre-match value (its insert is ON CONFLICT DO NOTHING, so it is
     * a no-op on every later match), and the second one measures.
     */
    perform public.sync_challenge_progress(v_row.player_id);

    perform private.recompute_player_counters(v_row.player_id);

    -- The run length ending at THIS match's week is what the bonus is paid on, so a
    -- back-dated match pays what it was worth then rather than what the streak is worth now.
    --
    -- Week one is the football's own reward; the bonus starts at week two, grows, and caps at
    -- 75 — about what one match is worth. That ceiling is the balance point: the streak has to
    -- be worth protecting without making turning up every week worth more than playing well,
    -- which is what a 150-point cap did in testing (streak bonuses were 40% of all XP awarded).
    v_run := private.recompute_play_streak(v_row.player_id, v_played_on);
    if v_run >= 2 then
      perform public.award_xp(
        v_row.player_id,
        'streak_bonus',
        least(75, 15 * (v_run - 1)),
        'streak:' || date_trunc('week', v_played_on)::date::text,
        v_match.id,
        null,
        jsonb_build_object('weeks', v_run)
      );
    end if;

    perform public.evaluate_achievements(v_row.player_id);
    perform public.sync_challenge_progress(v_row.player_id);
  end loop;

  return v_players;
end;
$$;

/**
 * Recomputes a player's counters from the source tables.
 *
 * Recompute rather than increment. An incremented counter drifts the first
 * time a trigger is skipped, a match is corrected, or a row is repaired by
 * hand, and there is no way to notice; a recomputed one is right after every
 * single call. The queries are all covered by existing indexes and this runs
 * once per player per finalized match.
 */
create or replace function private.recompute_player_counters(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stats  record;
  v_run    integer := 0;
  v_best   integer := 0;
  v_result record;
begin
  select
    count(*)                                                              as played,
    count(*) filter (where m.home_score is not null and m.away_score is not null
                       and ((mp.team_side = 'home' and m.home_score > m.away_score)
                         or (mp.team_side = 'away' and m.away_score > m.home_score)))  as won,
    count(*) filter (where m.home_score = m.away_score)                    as drawn,
    count(*) filter (where m.home_score is not null and m.away_score is not null
                       and ((mp.team_side = 'home' and m.home_score < m.away_score)
                         or (mp.team_side = 'away' and m.away_score < m.home_score)))  as lost,
    count(*) filter (where (mp.team_side = 'home' and m.away_score = 0)
                        or (mp.team_side = 'away' and m.home_score = 0))   as clean_sheets,
    count(distinct m.venue_id) filter (where m.venue_id is not null)       as venues,
    count(*) filter (where extract(hour from m.kickoff_at at time zone
                              coalesce(vn.timezone, 'UTC')) >= 22)         as late,
    max(m.kickoff_at)                                                      as last_kickoff
  into v_stats
  from public.match_participants mp
  join public.matches m on m.id = mp.match_id
  left join public.venues vn on vn.id = m.venue_id
  where mp.player_id = p_user_id
    and m.status = 'finalized';

  update public.player_progress
     set matches_played = coalesce(v_stats.played, 0),
         matches_won    = coalesce(v_stats.won, 0),
         matches_drawn  = coalesce(v_stats.drawn, 0),
         matches_lost   = coalesce(v_stats.lost, 0),
         clean_sheets   = coalesce(v_stats.clean_sheets, 0),
         distinct_venues= coalesce(v_stats.venues, 0),
         late_matches   = coalesce(v_stats.late, 0)
   where player_id = p_user_id;

  -- Goals, assists and hat-tricks come from player_stats, which is the record
  -- of what somebody actually did rather than of who was on the team sheet.
  update public.player_progress pp
     set goals      = coalesce(agg.goals, 0),
         assists    = coalesce(agg.assists, 0),
         hat_tricks = coalesce(agg.hat_tricks, 0)
    from (
      select coalesce(sum(ps.goals), 0)::integer   as goals,
             coalesce(sum(ps.assists), 0)::integer as assists,
             count(*) filter (where ps.goals >= 3)::integer as hat_tricks
        from public.player_stats ps
        join public.matches m on m.id = ps.match_id
       where ps.player_id = p_user_id
         and m.status = 'finalized'
    ) agg
   where pp.player_id = p_user_id;

  update public.player_progress pp
     set bookings_paid   = coalesce(b.n, 0),
         reports_filed   = coalesce(r.n, 0),
         consensus_votes = coalesce(c.n, 0),
         teams_captained = coalesce(t.n, 0)
    from (select count(*)::integer as n from public.bookings
           where booked_by = p_user_id and payment_status = 'succeeded') b,
         (select count(*)::integer as n from public.score_reports
           where reported_by = p_user_id) r,
         (select count(*)::integer as n from public.consensus_approvals
           where approver_id = p_user_id) c,
         (select count(*)::integer as n from public.team_members
           where player_id = p_user_id and role = 'captain') t
   where pp.player_id = p_user_id;

  -- The unbeaten run is a walk over the player's finalized matches in order.
  -- There is no aggregate for "longest consecutive", so it is computed here
  -- rather than approximated.
  for v_result in
    select case
             when m.home_score is null or m.away_score is null then 'unknown'
             when (mp.team_side = 'home' and m.home_score < m.away_score)
               or (mp.team_side = 'away' and m.away_score < m.home_score) then 'loss'
             else 'ok'
           end as outcome
      from public.match_participants mp
      join public.matches m on m.id = mp.match_id
     where mp.player_id = p_user_id
       and m.status = 'finalized'
     order by m.kickoff_at
  loop
    if v_result.outcome = 'loss' then
      v_run := 0;
    elsif v_result.outcome = 'ok' then
      v_run := v_run + 1;
      if v_run > v_best then v_best := v_run; end if;
    end if;
  end loop;

  update public.player_progress
     set current_unbeaten_run = v_run,
         best_unbeaten_run    = greatest(best_unbeaten_run, v_best)
   where player_id = p_user_id;
end;
$$;

-- 9.1 Match finalization trigger.
create or replace function private.on_match_finalized()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'finalized' and coalesce(old.status, 'scheduled') <> 'finalized' then
    perform public.apply_match_progression(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_match_progression on public.matches;
create trigger trg_match_progression
  after update of status on public.matches
  for each row execute function private.on_match_finalized();

-- 9.2 Paid booking: the person who fronted the pitch fee.
create or replace function private.on_booking_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.payment_status = 'succeeded'
     and coalesce(old.payment_status, 'requires_payment') <> 'succeeded' then
    perform public.award_xp(
      new.booked_by, 'booking_paid', 25,
      'booking:' || new.id::text || ':paid', null, new.id
    );
    -- Baseline before the counter moves; see apply_match_progression for why.
    perform public.sync_challenge_progress(new.booked_by);
    perform private.recompute_player_counters(new.booked_by);
    perform public.evaluate_achievements(new.booked_by);
    perform public.sync_challenge_progress(new.booked_by);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_booking_progression on public.bookings;
create trigger trg_booking_progression
  after update of payment_status on public.bookings
  for each row execute function private.on_booking_paid();

-- 9.3 Filing a score report and voting in a consensus round are the two acts
-- that keep the integrity layer honest, so they are the two acts the
-- progression system pays for directly.
create or replace function private.on_score_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.award_xp(new.reported_by, 'score_reported', 8,
                          'report:' || new.id::text, new.match_id);
  -- Baseline before the counter moves; see apply_match_progression for why.
  perform public.sync_challenge_progress(new.reported_by);
  perform private.recompute_player_counters(new.reported_by);
  perform public.evaluate_achievements(new.reported_by);
  perform public.sync_challenge_progress(new.reported_by);
  return null;
end;
$$;

drop trigger if exists trg_score_report_progression on public.score_reports;
create trigger trg_score_report_progression
  after insert on public.score_reports
  for each row execute function private.on_score_report();

create or replace function private.on_consensus_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.award_xp(new.approver_id, 'consensus_voted', 12,
                          'vote:' || new.id::text, new.match_id);
  perform private.recompute_player_counters(new.approver_id);
  perform public.evaluate_achievements(new.approver_id);
  return null;
end;
$$;

drop trigger if exists trg_consensus_progression on public.consensus_approvals;
create trigger trg_consensus_progression
  after insert on public.consensus_approvals
  for each row execute function private.on_consensus_vote();


-- =============================================================================
-- 10. Read APIs
-- =============================================================================

/**
 * The caller's entire progression state in one round trip.
 *
 * A dashboard needs level, XP, streak, every achievement with its progress,
 * every live challenge with its claim state, and the recent ledger. Six
 * queries from the client would be six RLS evaluations and six network hops on
 * a screen people open every day; this is one.
 *
 * It syncs challenges before reading them, so a player who has not been seen
 * since last week gets this week's objectives on the page they land on rather
 * than after their next match.
 */
create or replace function public.my_progress()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_progress public.player_progress;
  v_today    date := (now() at time zone 'utc')::date;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  perform private.ensure_progress_row(v_user);
  perform public.ensure_weekly_challenges();
  perform public.sync_challenge_progress(v_user);

  select * into v_progress from public.player_progress where player_id = v_user;

  return jsonb_build_object(
    'xp', v_progress.xp,
    'level', v_progress.level,
    'levelFloor', private.xp_for_level(v_progress.level),
    'nextLevelAt', private.xp_for_level(v_progress.level + 1),
    'currentStreakWeeks', v_progress.current_streak_weeks,
    'longestStreakWeeks', v_progress.longest_streak_weeks,
    'lastPlayedOn', v_progress.last_played_on,
    'counters', jsonb_build_object(
      'matchesPlayed', v_progress.matches_played,
      'matchesWon', v_progress.matches_won,
      'matchesDrawn', v_progress.matches_drawn,
      'matchesLost', v_progress.matches_lost,
      'goals', v_progress.goals,
      'assists', v_progress.assists,
      'cleanSheets', v_progress.clean_sheets,
      'hatTricks', v_progress.hat_tricks,
      'lateMatches', v_progress.late_matches,
      'distinctVenues', v_progress.distinct_venues,
      'bookingsPaid', v_progress.bookings_paid,
      'reportsFiled', v_progress.reports_filed,
      'consensusVotes', v_progress.consensus_votes,
      'teamsCaptained', v_progress.teams_captained,
      'currentUnbeatenRun', v_progress.current_unbeaten_run,
      'bestUnbeatenRun', v_progress.best_unbeaten_run
    ),
    'achievements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', a.code,
               'name', a.name,
               'description', a.description,
               'tier', a.tier,
               'target', a.target,
               'xpReward', a.xp_reward,
               'progress', coalesce(pa.progress, 0),
               'unlockedAt', pa.unlocked_at
             ) order by a.sort_order, a.code)
        from public.achievements a
        left join public.player_achievements pa
               on pa.achievement_code = a.code and pa.user_id = v_user
       where a.is_active
    ), '[]'::jsonb),
    'challenges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'code', c.code,
               'title', c.title,
               'description', c.description,
               'target', c.target,
               'xpReward', c.xp_reward,
               'endsOn', c.ends_on,
               'progress', coalesce(cp.progress, 0),
               'completedAt', cp.completed_at,
               'claimedAt', cp.claimed_at
             ) order by c.code)
        from public.challenges c
        left join public.challenge_progress cp
               on cp.challenge_id = c.id and cp.user_id = v_user
       where c.starts_on <= v_today and c.ends_on >= v_today
    ), '[]'::jsonb),
    'recentEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id,
               'kind', e.kind,
               'points', e.points,
               'matchId', e.match_id,
               'metadata', e.metadata,
               'createdAt', e.created_at
             ) order by e.created_at desc)
        from (
          select * from public.xp_events
           where user_id = v_user
           order by created_at desc
           limit 12
        ) e
    ), '[]'::jsonb)
  );
end;
$$;

/**
 * A page of the ranking.
 *
 * SECURITY DEFINER because it has to join `profiles` for a display name, and
 * `authenticated` holds only a column grant there — but it re-applies the same
 * privacy rule the policies do, and then some: a row appears only if the
 * profile is public, not soft-deleted, and not a minor. Under-16 accounts are
 * locked to non-public visibility by
 * `profiles_minor_privacy_locked_check`, so the visibility test already covers
 * them; `is_minor` is checked as well because a leaderboard is exactly the kind
 * of surface where a future relaxation of that constraint would leak children.
 */
create or replace function public.leaderboard_page(
  p_scope  text default 'xp',
  p_city   text default null,
  p_limit  integer default 25,
  p_offset integer default 0
)
returns table (
  rank                 integer,
  player_id            uuid,
  display_name         text,
  avatar_url           text,
  city                 text,
  level                integer,
  xp                   bigint,
  conservative_rating  double precision,
  matches_played       integer,
  current_streak_weeks integer
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Internal names are deliberately unlike the OUT parameter names above. In a
  -- SQL function the OUT names are in scope inside the body, so a CTE column
  -- called `level` and an OUT parameter called `level` is an ambiguous
  -- reference, and the failure is at call time rather than at create time.
  with eligible as (
    select p.id                                   as e_id,
           coalesce(p.display_name, p.full_name, 'Oyuncu') as e_name,
           p.avatar_url                           as e_avatar,
           p.city                                 as e_city,
           coalesce(pp.level, 1)                  as e_level,
           coalesce(pp.xp, 0)                     as e_xp,
           coalesce(pr.conservative_rating, 0)::double precision as e_rating,
           coalesce(pp.matches_played, 0)         as e_played,
           coalesce(pp.current_streak_weeks, 0)   as e_streak
      from public.profiles p
      left join public.player_progress pp on pp.player_id = p.id
      left join public.player_ratings  pr on pr.player_id = p.id
     where p.deleted_at is null
       and p.profile_visibility = 'public'
       and p.is_minor = false
       and (p_city is null or p.city is not distinct from p_city)
       -- Somebody who has never played is not on a leaderboard.
       and coalesce(pp.matches_played, 0) > 0
  ),
  ranked as (
    select (row_number() over (
              order by case
                         when p_scope = 'rating' then e_rating
                         when p_scope = 'streak' then e_streak::double precision
                         else e_xp::double precision
                       end desc,
                       e_played desc,
                       e_id
            ))::integer as e_rank,
           eligible.*
      from eligible
  )
  select r.e_rank, r.e_id, r.e_name, r.e_avatar, r.e_city,
         r.e_level, r.e_xp, r.e_rating, r.e_played, r.e_streak
    from ranked r
   order by r.e_rank
   offset greatest(0, coalesce(p_offset, 0))
   limit least(100, greatest(1, coalesce(p_limit, 25)));
$$;

comment on function public.leaderboard_page(text, text, integer, integer) is
  'Privacy-filtered ranking: public, non-deleted, non-minor profiles that have played at least once.';

/**
 * The venue owner's version of a level.
 *
 * Facility owners are users too, and the retention problem is the same one:
 * give them a number that moves when they do the right thing. Everything here
 * is derived from bookings that already exist — there is no second write path
 * and nothing to keep in sync.
 *
 * The tier thresholds are deliberately reachable: a venue that takes 50 paid
 * bookings without cancelling on people is a good venue, and should be told so.
 */
create or replace function public.venue_scorecard(p_venue_id uuid, p_days integer default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_since timestamptz := now() - make_interval(days => greatest(1, least(365, coalesce(p_days, 90))));
  v_stats record;
  v_tier  text;
  v_score integer;
begin
  select owner_id into v_owner from public.venues where id = p_venue_id;
  if v_owner is null then
    raise exception 'Venue not found' using errcode = 'P0002';
  end if;

  -- The caller must own the venue or be an admin. SECURITY DEFINER bypasses
  -- RLS, so the check that RLS would have made is made here instead.
  if v_owner <> (select auth.uid()) and not private.is_admin() then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  select
    count(*) filter (where b.payment_status = 'succeeded')                as paid,
    count(*) filter (where b.status = 'completed')                        as completed,
    count(*) filter (where b.status in ('cancelled', 'refunded'))         as cancelled,
    count(*) filter (where b.status = 'disputed')                         as disputed,
    coalesce(sum(b.total_minor - b.platform_fee_minor - b.refunded_amount_minor)
             filter (where b.payment_status = 'succeeded'), 0)            as net_minor,
    count(distinct b.booked_by) filter (where b.payment_status = 'succeeded') as customers
  into v_stats
  from public.bookings b
  join public.pitches pi on pi.id = b.pitch_id
  where pi.venue_id = p_venue_id
    and b.created_at >= v_since;

  -- A single number the owner can move: paid bookings, minus a penalty for
  -- letting people down, floored at zero.
  v_score := greatest(0, coalesce(v_stats.paid, 0) * 10
                       + coalesce(v_stats.customers, 0) * 5
                       - coalesce(v_stats.cancelled, 0) * 15
                       - coalesce(v_stats.disputed, 0) * 40);

  v_tier := case
              when v_score >= 1500 then 'platinum'
              when v_score >= 700  then 'gold'
              when v_score >= 250  then 'silver'
              else 'bronze'
            end;

  return jsonb_build_object(
    'venueId', p_venue_id,
    'windowDays', greatest(1, least(365, coalesce(p_days, 90))),
    'score', v_score,
    'tier', v_tier,
    'paidBookings', coalesce(v_stats.paid, 0),
    'completedBookings', coalesce(v_stats.completed, 0),
    'cancelledBookings', coalesce(v_stats.cancelled, 0),
    'disputedBookings', coalesce(v_stats.disputed, 0),
    'netMinor', coalesce(v_stats.net_minor, 0),
    'distinctCustomers', coalesce(v_stats.customers, 0),
    'nextTierAt', case
                    when v_score >= 1500 then null
                    when v_score >= 700  then 1500
                    when v_score >= 250  then 700
                    else 250
                  end
  );
end;
$$;


-- =============================================================================
-- 11. RLS
-- =============================================================================
-- Every policy compares against `(select auth.uid())`, never bare `auth.uid()`.
-- The wrapped form is hoisted into an InitPlan and evaluated once per statement;
-- the bare one is re-evaluated per row and turns an index scan into a
-- sequential scan on exactly the tables a dashboard reads on every page load.

alter table public.player_progress      enable row level security;
alter table public.player_progress      force  row level security;
alter table public.xp_events            enable row level security;
alter table public.xp_events            force  row level security;
alter table public.achievements         enable row level security;
alter table public.achievements         force  row level security;
alter table public.player_achievements  enable row level security;
alter table public.player_achievements  force  row level security;
alter table public.challenges           enable row level security;
alter table public.challenges           force  row level security;
alter table public.challenge_progress   enable row level security;
alter table public.challenge_progress   force  row level security;

revoke all on table public.player_progress     from anon, authenticated;
revoke all on table public.xp_events           from anon, authenticated;
revoke all on table public.achievements        from anon, authenticated;
revoke all on table public.player_achievements from anon, authenticated;
revoke all on table public.challenges          from anon, authenticated;
revoke all on table public.challenge_progress  from anon, authenticated;

-- Reads only. Every write in this subsystem goes through a SECURITY DEFINER
-- function, so no role needs INSERT or UPDATE on any of these tables — which
-- is also what stops a client minting its own XP.
grant select on table public.achievements to anon, authenticated;
grant select on table public.challenges   to authenticated;
grant select on table public.player_progress     to authenticated;
grant select on table public.player_achievements to authenticated;
grant select on table public.challenge_progress  to authenticated;
grant select on table public.xp_events           to authenticated;

-- 11.1 player_progress — your own row, plus any public profile's, because a
-- level badge on a player page is the point of having levels.
drop policy if exists player_progress_select_self_or_public on public.player_progress;
create policy player_progress_select_self_or_public
  on public.player_progress
  for select
  to authenticated
  using (
    player_id = (select auth.uid())
    or private.can_view_profile(player_id)
  );

-- 11.2 xp_events — private. A ledger is between the player and the system.
drop policy if exists xp_events_select_own on public.xp_events;
create policy xp_events_select_own
  on public.xp_events
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- 11.3 achievements — the catalogue is public.
drop policy if exists achievements_select_all_anon on public.achievements;
create policy achievements_select_all_anon
  on public.achievements
  for select
  to anon
  using (is_active);

drop policy if exists achievements_select_all on public.achievements;
create policy achievements_select_all
  on public.achievements
  for select
  to authenticated
  using (true);

-- 11.4 player_achievements — own, or a visible profile's unlocked badges.
drop policy if exists player_achievements_select_self_or_public on public.player_achievements;
create policy player_achievements_select_self_or_public
  on public.player_achievements
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or (unlocked_at is not null and private.can_view_profile(user_id))
  );

-- 11.5 challenges — every signed-in user sees the same objectives.
drop policy if exists challenges_select_all on public.challenges;
create policy challenges_select_all
  on public.challenges
  for select
  to authenticated
  using (true);

-- 11.6 challenge_progress — strictly your own.
drop policy if exists challenge_progress_select_own on public.challenge_progress;
create policy challenge_progress_select_own
  on public.challenge_progress
  for select
  to authenticated
  using (user_id = (select auth.uid()));


/**
 * Backfill. Walks finalized matches that have no XP against them yet and runs the
 * progression they would have earned had 0008 been in place at the time.
 *
 * This exists because the trigger fires on a status TRANSITION, so a database that already
 * held finished football when this migration landed has none of it counted. Batched and
 * resumable: call it until it returns 0.
 *
 * service_role only. It is not something a client ever needs and not something an operator
 * should be able to invoke by accident from a browser session.
 */
create or replace function public.backfill_progression(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match  record;
  v_done   integer := 0;
begin
  for v_match in
    select m.id
      from public.matches m
     where m.status = 'finalized'
       and not exists (
             select 1 from public.xp_events e
              where e.match_id = m.id
                and e.kind = 'match_played'
           )
     order by m.kickoff_at
     limit greatest(1, least(1000, coalesce(p_limit, 200)))
  loop
    perform public.apply_match_progression(v_match.id);
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;


-- =============================================================================
-- 12. Function grants
-- =============================================================================

revoke all on function public.award_xp(uuid, public.xp_event_kind, integer, text, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.apply_match_progression(uuid) from public, anon, authenticated;
revoke all on function public.evaluate_achievements(uuid) from public, anon, authenticated;
revoke all on function public.expire_play_streaks() from public, anon, authenticated;
revoke all on function public.ensure_weekly_challenges(date) from public, anon, authenticated;
revoke all on function public.sync_challenge_progress(uuid) from public, anon, authenticated;

-- The three a client is allowed to call. `my_progress` and `claim_challenge`
-- read auth.uid() themselves; `leaderboard_page` takes no identity at all.
grant execute on function public.my_progress() to authenticated;
grant execute on function public.claim_challenge(uuid) to authenticated;
grant execute on function public.leaderboard_page(text, text, integer, integer) to anon, authenticated;
grant execute on function public.venue_scorecard(uuid, integer) to authenticated;

-- The backend's own key. Needed for the post-deploy backfill and for driving the two
-- housekeeping functions from an Edge Function on a database without pg_cron.
revoke all on function public.backfill_progression(integer) from public, anon, authenticated;
grant execute on function public.backfill_progression(integer) to service_role;
grant execute on function public.apply_match_progression(uuid) to service_role;
grant execute on function public.ensure_weekly_challenges(date) to service_role;
grant execute on function public.expire_play_streaks() to service_role;


-- =============================================================================
-- 13. Realtime
-- =============================================================================
-- player_progress only. An XP total changing is worth pushing to an open
-- dashboard; the ledger behind it is not, and adding xp_events would put every
-- award on the wire for a screen that shows twelve of them.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.player_progress;
    exception
      when duplicate_object then
        raise notice '0008: public.player_progress already in supabase_realtime.';
    end;
  else
    raise notice '0008: publication supabase_realtime not found; skipping realtime setup.';
  end if;
end
$$;


-- =============================================================================
-- 14. Cron
-- =============================================================================

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0008: pg_cron not installed; schedule ensure_weekly_challenges() and expire_play_streaks() externally.';
    return;
  end if;

  -- Monday 00:05 UTC: open the new week's objectives.
  perform cron.unschedule('halisaha-weekly-challenges')
    where exists (select 1 from cron.job where jobname = 'halisaha-weekly-challenges');
  perform cron.schedule(
    'halisaha-weekly-challenges',
    '5 0 * * 1',
    $job$select public.ensure_weekly_challenges();$job$
  );

  -- Daily 03:20 UTC: end streaks that lapsed, and warn the ones about to.
  perform cron.unschedule('halisaha-streak-expiry')
    where exists (select 1 from cron.job where jobname = 'halisaha-streak-expiry');
  perform cron.schedule(
    'halisaha-streak-expiry',
    '20 3 * * *',
    $job$select public.expire_play_streaks();$job$
  );

  raise notice '0008: cron jobs halisaha-weekly-challenges and halisaha-streak-expiry scheduled.';
exception
  when others then
    raise notice '0008: cron scheduling skipped (%).', sqlerrm;
end
$cron$;


-- Open this week straight away, so the first person to load a dashboard after
-- the migration has something to do rather than waiting for Monday.
select public.ensure_weekly_challenges();


-- =============================================================================
-- 15. Self-test
-- =============================================================================
-- These are the values packages/shared/src/gamification.ts must reproduce. If
-- either side of the curve is edited alone, this block fails the migration
-- rather than letting the two drift into disagreeing about somebody's level.

do $test$
declare
  v_fail text := '';
begin
  if private.xp_for_level(1) <> 0     then v_fail := v_fail || ' xp_for_level(1)'; end if;
  if private.xp_for_level(2) <> 100   then v_fail := v_fail || ' xp_for_level(2)'; end if;
  if private.xp_for_level(5) <> 1000  then v_fail := v_fail || ' xp_for_level(5)'; end if;
  if private.xp_for_level(10) <> 4500 then v_fail := v_fail || ' xp_for_level(10)'; end if;
  if private.xp_for_level(20) <> 19000 then v_fail := v_fail || ' xp_for_level(20)'; end if;

  if private.level_for_xp(0)    <> 1  then v_fail := v_fail || ' level(0)'; end if;
  if private.level_for_xp(99)   <> 1  then v_fail := v_fail || ' level(99)'; end if;
  if private.level_for_xp(100)  <> 2  then v_fail := v_fail || ' level(100)'; end if;
  if private.level_for_xp(299)  <> 2  then v_fail := v_fail || ' level(299)'; end if;
  if private.level_for_xp(300)  <> 3  then v_fail := v_fail || ' level(300)'; end if;
  if private.level_for_xp(999)  <> 4  then v_fail := v_fail || ' level(999)'; end if;
  if private.level_for_xp(1000) <> 5  then v_fail := v_fail || ' level(1000)'; end if;
  if private.level_for_xp(18999) <> 19 then v_fail := v_fail || ' level(18999)'; end if;
  if private.level_for_xp(19000) <> 20 then v_fail := v_fail || ' level(19000)'; end if;

  -- Round trip across a wide range: the level of a level's own floor is itself.
  for i in 1..200 loop
    if private.level_for_xp(private.xp_for_level(i)) <> i then
      v_fail := v_fail || ' roundtrip(' || i || ')';
      exit;
    end if;
    if private.level_for_xp(private.xp_for_level(i + 1) - 1) <> i then
      v_fail := v_fail || ' ceiling(' || i || ')';
      exit;
    end if;
  end loop;

  if v_fail <> '' then
    raise exception '0008 self-test failed:%', v_fail;
  end if;

  raise notice '0008: level curve self-test passed.';
end
$test$;
