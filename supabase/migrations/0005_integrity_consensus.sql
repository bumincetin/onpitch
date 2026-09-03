-- =============================================================================
-- OnPitch — 0005_integrity_consensus.sql
--
-- Result-integrity layer: anti-collusion heuristics, anomaly-detection plumbing
-- for the external Isolation Forest microservice, and the cryptographic
-- peer-consensus workflow that ratifies a contested scoreline.
--
-- Pipeline (happy path -> contested path):
--
--   INSERT score_reports
--     |- BEFORE trigger  public.validate_score_report()      cheap rule engine
--     |- AFTER  trigger  public.evaluate_score_consensus()   corroboration pass
--          |- two opposing reports agree ......... finalize + apply ratings
--          |- one side only, < 24h ............... wait for the counterparty
--          |- one side only, >= 24h .............. accept by default
--          |- they disagree ...................... open_consensus_round()
--                                                     |- submit_consensus_approval()
--                                                     |- finalize_consensus()
--
--   Out of band the Python service polls matches_pending_anomaly_check(),
--   scores each feature vector with an Isolation Forest and posts the verdict
--   back through record_anomaly_verdict(), which can itself force a match into
--   a consensus round even when the reports agreed.
--
-- Conventions used throughout this file:
--   * Every function is `set search_path = ''` and fully schema-qualifies every
--     identifier, including pgcrypto (extensions.digest / gen_random_bytes).
--   * Every auth call is wrapped in a scalar subquery -- (select auth.uid()) --
--     so Postgres evaluates it once as an initPlan instead of once per row.
--   * User-facing exceptions use PostgREST-style SQLSTATEs: a code of the form
--     PTnnn makes PostgREST answer with HTTP status nnn, so the Next.js layer
--     receives 403/404/409/422/429 instead of a generic 500.
--   * Money/time conventions are inherited from 0001 (minor units, timestamptz).
-- =============================================================================

set search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Schema additions
-- -----------------------------------------------------------------------------

-- 0001 has no nonce column; the consensus round needs server-issued replay
-- protection that is rotated every time a round is (re)opened.
alter table public.matches add column if not exists consensus_nonce           bytea;
alter table public.matches add column if not exists consensus_nonce_issued_at timestamptz;

comment on column public.matches.consensus_nonce is
  'Server-issued 16 random bytes scoping the CURRENT consensus round. Rotated by public.open_consensus_round(); an approval carrying any other value is stale and is not counted.';
comment on column public.matches.consensus_nonce_issued_at is
  'When consensus_nonce was minted. Used to age out abandoned rounds.';

do $ddl$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'matches_consensus_nonce_length_check'
      and conrelid = 'public.matches'::regclass
  ) then
    alter table public.matches
      add constraint matches_consensus_nonce_length_check
      check (consensus_nonce is null or octet_length(consensus_nonce) = 16);
  end if;
end
$ddl$;

-- Rate-limit reads (reporter, recent window) and the shared-IP collusion probe.
create index if not exists idx_score_reports_reporter_recent
  on public.score_reports (reported_by, reported_at desc);
create index if not exists idx_score_reports_ip_hash
  on public.score_reports (ip_hash) where ip_hash is not null;
create index if not exists idx_matches_consensus_open
  on public.matches (consensus_nonce_issued_at) where consensus_nonce is not null;

-- -----------------------------------------------------------------------------
-- 1b. Anti-collusion heuristics store
--
-- Cache of the latest heuristic pass for a match. public.collusion_signals() is
-- pure/STABLE so it can be embedded in the feature vector; this table is what
-- the admin queue and the ML service read without paying the recomputation.
-- -----------------------------------------------------------------------------

create table if not exists public.match_collusion_signals (
  match_id        uuid primary key references public.matches (id) on delete cascade,
  signals         jsonb        not null default '{}'::jsonb,
  collusion_score numeric(6,5) not null default 0 check (collusion_score between 0 and 1),
  is_suspicious   boolean      not null default false,
  computed_at     timestamptz  not null default now()
);

comment on table public.match_collusion_signals is
  'Latest anti-collusion heuristic pass per match. Written by private.persist_collusion_signals(); the shape of signals is exactly what public.collusion_signals() returns.';
comment on column public.match_collusion_signals.collusion_score is
  'Weighted blend of the individual heuristics in [0,1]. >= 0.5 sets is_suspicious.';
comment on column public.match_collusion_signals.signals is
  'Per-heuristic breakdown: repeat_pairing_7d, repeat_pairing_90d, rating_farming_7d, shared_ip_reporter_pairs, lopsided_fast_report, reporter_pair_frequency.';

create index if not exists idx_match_collusion_suspicious
  on public.match_collusion_signals (computed_at desc) where is_suspicious;
create index if not exists idx_match_collusion_score
  on public.match_collusion_signals (collusion_score desc);

-- Fails closed like every table in 0001. Only the admin SELECT policy below is
-- opened up; all writes arrive through SECURITY DEFINER functions or
-- service_role (which bypasses RLS entirely).
alter table public.match_collusion_signals enable row level security;

-- -----------------------------------------------------------------------------
-- 1c. Feature-vector row type — the API contract with the Python service.
--
-- Column order and column types are the contract. Adding a field is a breaking
-- change for the service; do it in a new migration and version the model
-- alongside it.
-- -----------------------------------------------------------------------------

do $ddl$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'match_anomaly_feature_row' and n.nspname = 'public'
  ) then
    create type public.match_anomaly_feature_row as (
      match_id                    uuid,
      score_variance              numeric,
      reporting_delay_seconds     numeric,
      reporter_count              integer,
      opposing_report_agreement   numeric,
      participant_overlap_ratio   numeric,
      historical_report_deviation numeric,
      goal_diff                   integer,
      kickoff_hour                integer,
      venue_bookings_last_7d      integer,
      reporter_account_age_days   numeric
    );
  end if;
end
$ddl$;

comment on type public.match_anomaly_feature_row is
  'Isolation Forest feature vector. Emitted by matches_pending_anomaly_check() and mirrored key-for-key by anomaly_features().';

-- -----------------------------------------------------------------------------
-- 2. Tunables and small internal helpers
-- -----------------------------------------------------------------------------

-- Every magic number in this file is overridable per transaction/session with
--   set local app.<key> = '<value>';
-- which makes the rule engine testable without shipping a migration.
create or replace function private.integrity_setting(p_key text, p_default numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_raw text;
begin
  v_raw := current_setting('app.' || p_key, true);
  if v_raw is null or v_raw = '' then
    return p_default;
  end if;
  return v_raw::numeric;
exception
  when others then
    return p_default;
end;
$fn$;

comment on function private.integrity_setting(text, numeric) is
  'Reads app.<key> out of the current settings, falling back to p_default. Never throws.';

-- ISOLATION FOREST SEMANTICS (read before touching the threshold)
--
--   For a sample x in a forest built over n samples,
--       s(x, n) = 2 ^ ( -E[h(x)] / c(n) )
--   where h(x) is the path length from the ROOT of a tree to the leaf that
--   isolated x, E[h(x)] is that length averaged over every tree in the forest,
--   and c(n) normalises it by the average path length of an unsuccessful search
--   in a binary search tree over n points:
--       c(n) = 2 * H(n - 1) - 2 * (n - 1) / n,   H(i) ~= ln(i) + 0.5772156649
--
--   A short average path length means the sample fell out of the tree close to
--   the root, which means very few random splits were needed to isolate it,
--   which means it sits in a sparse region of feature space, which means it is
--   anomalous. Short path -> exponent near 0 -> s(x) -> 1.
--   A long path (the sample looks like everybody else) -> s(x) -> 0.
--   s(x) ~= 0.5 means the forest has no opinion.
--
--   So a higher anomaly_score means a more anomalous match, and
--   match_anomaly_flags.leaf_depth moves inversely to the score. The default
--   cut sits at 0.62, deliberately above 0.5, so genuinely ambiguous matches
--   are not dragged into a consensus round for nothing.
create or replace function public.anomaly_score_threshold()
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select private.integrity_setting('anomaly_threshold', 0.62);
$fn$;

comment on function public.anomaly_score_threshold() is
  'Isolation Forest cut-off. score = 2^(-E[h(x)]/c(n)); higher means more anomalous. Default 0.62, override with app.anomaly_threshold.';

-- True when the caller is a platform admin. SECURITY DEFINER so it can read
-- public.profiles from inside an RLS policy without recursing into that table.
create or replace function private.is_integrity_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'::public.app_role
      and p.deleted_at is null
  );
$fn$;

comment on function private.is_integrity_admin() is
  'Admin predicate for the integrity tables. SECURITY DEFINER to avoid RLS recursion on public.profiles.';

-- Anything that exposes cross-match behavioural intelligence goes through this.
-- auth.uid() IS NULL means there is no end user in the request, i.e. service_role
-- or an internal cron; anon can never reach these functions because it is never
-- granted EXECUTE.
create or replace function private.assert_integrity_reader()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if (select auth.uid()) is null then
    return;
  end if;
  if private.is_integrity_admin() then
    return;
  end if;
  raise exception using
    errcode = 'PT403',
    message = 'Not authorised to read match integrity intelligence.';
end;
$fn$;

-- audit_log.actor_id is a FK to public.profiles, and auth.uid() can in principle
-- name an auth.users row that has no profile yet. Resolving through profiles
-- turns that into NULL instead of a foreign key violation that would abort an
-- otherwise valid finalisation.
create or replace function private.actor_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.id from public.profiles p where p.id = (select auth.uid());
$fn$;

-- Fan-out helpers -------------------------------------------------------------

create or replace function private.notify_participants(
  p_match_id uuid,
  p_type     text,
  p_title    text,
  p_body     text,
  p_data     jsonb default '{}'::jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  insert into public.notifications (user_id, type, title, body, data)
  select distinct mp.player_id,
         p_type,
         p_title,
         p_body,
         coalesce(p_data, '{}'::jsonb) || jsonb_build_object('matchId', p_match_id::text)
  from public.match_participants mp
  where mp.match_id = p_match_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

create or replace function private.notify_admins(
  p_type  text,
  p_title text,
  p_body  text,
  p_data  jsonb default '{}'::jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  insert into public.notifications (user_id, type, title, body, data)
  select p.id, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb)
  from public.profiles p
  where p.role = 'admin'::public.app_role
    and p.deleted_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- -----------------------------------------------------------------------------
-- 3. Rule engine — BEFORE INSERT on score_reports
--
-- This is the cheap first pass. It runs inside the writing transaction and its
-- job is to reject things that are structurally impossible or abusive, not to
-- adjudicate honest disagreements. Everything it lets through is still subject
-- to corroboration (section 7) and to the Isolation Forest (section 6).
--
-- SECURITY DEFINER is mandatory: the trigger has to read matches,
-- match_participants and venues, all of which are RLS-protected, and the
-- inserting role is an ordinary authenticated player who may not be able to see
-- those rows directly.
-- -----------------------------------------------------------------------------

create or replace function public.validate_score_report()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_match          public.matches%rowtype;
  v_uid            uuid := (select auth.uid());
  v_side           text;
  v_is_participant boolean;
  v_is_owner       boolean;
  v_is_admin       boolean;
  v_window_hours   numeric := private.integrity_setting('report_window_hours', 48);
  v_max_per_team   integer := private.integrity_setting('max_goals_per_team', 30)::int;
  v_rate_limit     integer := private.integrity_setting('report_rate_limit', 10)::int;
  v_rate_window    numeric := private.integrity_setting('report_rate_window_minutes', 15);
  v_max_total      integer;
  v_recent         integer;
begin
  -- 3.1 The match must exist and must be in a state that accepts reports.
  select * into v_match from public.matches m where m.id = new.match_id;
  if not found then
    raise exception using
      errcode = 'PT404',
      message = 'That match does not exist.';
  end if;

  if v_match.status in ('cancelled'::public.match_status) then
    raise exception using
      errcode = 'PT409',
      message = 'This match was cancelled, so it cannot be scored.';
  end if;

  -- Once a round has been escalated to a human, a further report must not be
  -- accepted: evaluate_score_consensus treats 'disputed' as terminal, so the
  -- row would be stored and then silently ignored. Refuse it instead.
  if v_match.status = 'disputed'::public.match_status then
    raise exception using
      errcode = 'PT409',
      message = 'This result is already under review by an administrator.',
      hint    = 'The dispute queue owns this match; new reports are not counted while it is open.';
  end if;

  if v_match.status = 'finalized'::public.match_status or v_match.score_confirmed_at is not null then
    raise exception using
      errcode = 'PT409',
      message = 'The result of this match is already final.',
      hint    = 'Open a dispute with the venue if the confirmed score is wrong.';
  end if;

  -- 3.2 Identity. Admins and server-side callers (service_role, cron) are
  -- allowed to file on behalf of somebody; an end user may only file as
  -- themselves.
  v_is_admin := private.is_integrity_admin();

  if v_uid is not null and not v_is_admin and new.reported_by <> v_uid then
    raise exception using
      errcode = 'PT403',
      message = 'You can only submit a score report under your own account.';
  end if;

  -- 3.3 The reporter must actually have been there: a line-up member, or the
  -- owner of the venue that hosted the match (the neutral third party).
  select mp.team_side into v_side
  from public.match_participants mp
  where mp.match_id = new.match_id
    and mp.player_id = new.reported_by;

  v_is_participant := v_side is not null;

  select exists (
    select 1
    from public.venues v
    where v.id = v_match.venue_id
      and v.owner_id = new.reported_by
  ) into v_is_owner;

  if not v_is_participant and not v_is_owner and not v_is_admin then
    raise exception using
      errcode = 'PT403',
      message = 'Only players who took part in this match or the venue owner can report the score.';
  end if;

  -- Normalise the side. Venue owners and admins report as a neutral observer
  -- (team_side stays NULL), which is exactly what makes their report count as
  -- independent corroboration for either side in section 7.
  if v_is_participant then
    if new.team_side is not null and new.team_side <> v_side then
      raise exception using
        errcode = 'PT422',
        message = 'You cannot report on behalf of the other side.';
    end if;
    new.team_side := v_side;
  else
    new.team_side := null;
  end if;

  -- 3.4 The match must have kicked off. Reporting a fixture that has not
  -- started is always fabrication.
  if now() < v_match.kickoff_at then
    raise exception using
      errcode = 'PT422',
      message = 'This match has not kicked off yet.',
      detail  = 'kickoff_at is in the future.';
  end if;

  -- 3.5 Reporting window. After the window the result belongs to the admin
  -- dispute queue, not to self-reporting.
  if now() > v_match.kickoff_at + make_interval(mins => (v_window_hours * 60)::int) then
    raise exception using
      errcode = 'PT409',
      message = format('The %s hour reporting window for this match has closed.', v_window_hours::int),
      hint    = 'Contact the venue or an administrator to have the result recorded.';
  end if;

  -- 3.6 Sane scorelines.
  --   * hard per-team cap (default 30),
  --   * and a duration-derived cap on the combined tally: roughly one goal
  --     every two minutes of actual play across BOTH teams, with a floor of 10
  --     so short-format games are not over-constrained.
  if new.home_score > v_max_per_team or new.away_score > v_max_per_team then
    raise exception using
      errcode = 'PT422',
      message = format('A single side cannot score more than %s goals.', v_max_per_team);
  end if;

  v_max_total := greatest(10, ceil(v_match.duration_minutes / 2.0)::int);

  if (new.home_score + new.away_score) > v_max_total then
    raise exception using
      errcode = 'PT422',
      message = format(
        'That scoreline is not possible in a %s minute match (at most %s goals in total).',
        v_match.duration_minutes, v_max_total),
      detail  = format('Reported %s-%s.', new.home_score, new.away_score);
  end if;

  -- 3.7 Client clock sanity. A client timestamp from the future, or from before
  -- kickoff, means either a broken device clock or a forged payload.
  if new.client_reported_at is not null then
    if new.client_reported_at > now() + interval '5 minutes'
       or new.client_reported_at < v_match.kickoff_at - interval '5 minutes' then
      raise exception using
        errcode = 'PT422',
        message = 'The timestamp your device sent is not plausible for this match.',
        hint    = 'Check the clock on your device and try again.';
    end if;
  end if;

  -- 3.8 Per-reporter rate limit. score_reports is UNIQUE (match_id,
  -- reported_by), so this can only trip by spraying across many matches, which
  -- is precisely the scripted-abuse shape worth blocking.
  select count(*)::int into v_recent
  from public.score_reports sr
  where sr.reported_by = new.reported_by
    and sr.reported_at > now() - make_interval(mins => v_rate_window::int);

  if v_recent >= v_rate_limit then
    raise exception using
      errcode = 'PT429',
      message = format('Too many score reports. Try again in %s minutes.', v_rate_window::int),
      detail  = format('%s reports in the last %s minutes.', v_recent, v_rate_window::int);
  end if;

  -- 3.9 Server-side integrity hash of the report body when the client did not
  -- send one. Canonical form matches the client contract documented on
  -- public.consensus_payload(): jsonb text output of the object below.
  if new.payload_hash is null then
    new.payload_hash := extensions.digest(
      jsonb_build_object(
        'match_id',    new.match_id::text,
        'away_score',  new.away_score,
        'home_score',  new.home_score,
        'reported_by', new.reported_by::text
      )::text,
      'sha256'
    );
  end if;

  -- Reports filed before the final whistle are legal (people post at full time,
  -- and duration_minutes is nominal), but they are a strong collusion tell, so
  -- the lag is recorded as a feature in section 4/5 rather than blocked here.

  return new;
end;
$fn$;

comment on function public.validate_score_report() is
  'BEFORE INSERT rule engine for score_reports: participation, match state, kickoff, scoreline plausibility, 48h window, per-reporter rate limit. Raises PostgREST-mapped SQLSTATEs (PT403/PT404/PT409/PT422/PT429).';

drop trigger if exists trg_score_reports_validate on public.score_reports;
create trigger trg_score_reports_validate
  before insert on public.score_reports
  for each row execute function public.validate_score_report();

-- -----------------------------------------------------------------------------
-- 4. Anti-collusion heuristics
--
-- These are deliberately cheap, explainable rules. They feed the detector in
-- section 6 as features and double as a tripwire an admin can read without a
-- data-science degree; the detector itself is the Isolation Forest.
-- -----------------------------------------------------------------------------

-- The scoreline currently on the table for a match, resolved deterministically:
--   1. the confirmed score on the match if there is one, otherwise
--   2. the most-corroborated reported scoreline, ties broken by earliest report,
--      then by home_score, then by away_score.
-- reported_at is the earliest report on the match (kickoff_at if there are none).
create or replace function private.consensus_scoreline(p_match_id uuid)
returns table (home_score integer, away_score integer, reported_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  with m as (
    select mm.id, mm.home_score, mm.away_score, mm.kickoff_at
    from public.matches mm
    where mm.id = p_match_id
  ),
  ranked as (
    select sr.home_score, sr.away_score
    from public.score_reports sr
    where sr.match_id = p_match_id
    group by sr.home_score, sr.away_score
    order by count(*) desc, min(sr.reported_at) asc, sr.home_score asc, sr.away_score asc
    limit 1
  )
  select coalesce(m.home_score, r.home_score)::integer,
         coalesce(m.away_score, r.away_score)::integer,
         coalesce(
           (select min(sr2.reported_at) from public.score_reports sr2 where sr2.match_id = p_match_id),
           m.kickoff_at
         )
  from m
  left join ranked r on true;
$fn$;

comment on function private.consensus_scoreline(uuid) is
  'Deterministic resolution of the scoreline under discussion for a match: confirmed score, else the most-corroborated report (ties: earliest, then home asc, then away asc).';

-- Computation only, no authorisation. This is what the internal pipeline calls:
-- the corroboration pass runs inside an ordinary player's INSERT transaction,
-- and SECURITY DEFINER does not clear auth.uid(), so gating the computation on
-- "is the caller an admin" would make every score report fail for real users.
-- The authorisation lives in the public wrapper below, which is the only entry
-- point exposed over PostgREST.
create or replace function private.collusion_signals_core(p_match_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_m                public.matches%rowtype;
  v_home             integer;
  v_away             integer;
  v_first_report     timestamptz;
  v_final_whistle    timestamptz;
  v_report_lag       numeric;
  v_goal_diff        integer;
  v_winner           uuid;
  v_loser            uuid;
  v_pairing_7d       integer := 0;
  v_pairing_90d      integer := 0;
  v_farming_7d       integer := 0;
  v_shared_ip_pairs  integer := 0;
  v_pair_frequency   integer := 0;
  v_lopsided_fast    boolean := false;
  v_score            numeric;
  v_farm_limit       integer := private.integrity_setting('rating_farm_limit', 3)::int;
begin
  select * into v_m from public.matches m where m.id = p_match_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  v_final_whistle := v_m.kickoff_at + make_interval(mins => v_m.duration_minutes);

  select s.home_score, s.away_score, s.reported_at
    into v_home, v_away, v_first_report
  from private.consensus_scoreline(p_match_id) s;

  v_goal_diff := abs(coalesce(v_home, 0) - coalesce(v_away, 0));
  v_report_lag := case
                    when v_first_report is null then null
                    else extract(epoch from (v_first_report - v_final_whistle))
                  end;

  -- 4.1 Repeated same-pairing frequency. Two rosters that meet again and again
  -- in a short window are either a league (fine) or a rating pump (not fine);
  -- the frequency alone is not damning, which is why it is only 25% of the blend.
  if v_m.home_team_id is not null and v_m.away_team_id is not null then
    select
      (count(*) filter (where m2.kickoff_at >= v_m.kickoff_at - interval '7 days'))::int,
      count(*)::int
      into v_pairing_7d, v_pairing_90d
    from public.matches m2
    where m2.id <> v_m.id
      and m2.kickoff_at <  v_m.kickoff_at
      and m2.kickoff_at >= v_m.kickoff_at - interval '90 days'
      and (
            (m2.home_team_id = v_m.home_team_id and m2.away_team_id = v_m.away_team_id)
         or (m2.home_team_id = v_m.away_team_id and m2.away_team_id = v_m.home_team_id)
      );
  end if;

  -- 4.2 Rating farming: the same winner beating the same loser over and over
  -- inside a week. Orientation matters — a genuine rivalry alternates.
  v_winner := case
                when coalesce(v_home, 0) > coalesce(v_away, 0) then v_m.home_team_id
                when coalesce(v_away, 0) > coalesce(v_home, 0) then v_m.away_team_id
              end;
  v_loser  := case
                when coalesce(v_home, 0) > coalesce(v_away, 0) then v_m.away_team_id
                when coalesce(v_away, 0) > coalesce(v_home, 0) then v_m.home_team_id
              end;

  if v_winner is not null and v_loser is not null then
    select count(*)::int into v_farming_7d
    from public.matches m3
    where m3.id <> v_m.id
      and m3.status = 'finalized'::public.match_status
      and m3.home_score is not null
      and m3.away_score is not null
      and m3.kickoff_at <  v_m.kickoff_at
      and m3.kickoff_at >= v_m.kickoff_at - interval '7 days'
      and (
            (m3.home_team_id = v_winner and m3.away_team_id = v_loser and m3.home_score > m3.away_score)
         or (m3.away_team_id = v_winner and m3.home_team_id = v_loser and m3.away_score > m3.home_score)
      );
  end if;

  -- 4.3 Unusually lopsided result reported unusually fast. A 9-0 filed 40
  -- seconds after the whistle (or before it) is the classic pump signature:
  -- nobody has to argue about a scoreline that was agreed in advance.
  v_lopsided_fast := v_goal_diff >= 5
                     and v_report_lag is not null
                     and v_report_lag < private.integrity_setting('fast_report_seconds', 120);

  -- 4.4 Shared network fingerprint between opposing reporters. score_reports
  -- stores only a salted hash of the IP (0001), so this compares hashes, never
  -- addresses. Same salt is assumed across reports of one match.
  select count(*)::int into v_shared_ip_pairs
  from public.score_reports a
  join public.score_reports b
    on b.match_id = a.match_id
   and b.id > a.id
   and b.ip_hash = a.ip_hash
  where a.match_id = p_match_id
    and a.ip_hash is not null
    and b.ip_hash is not null
    and a.team_side is distinct from b.team_side;

  -- 4.5 How often this exact set of reporters has co-reported before. A tight
  -- closed loop of the same two accounts vouching for each other is the human
  -- half of the same pattern 4.2 sees at team level.
  select count(distinct pa.match_id)::int into v_pair_frequency
  from public.score_reports pa
  join public.score_reports pb
    on pb.match_id = pa.match_id
   and pb.reported_by <> pa.reported_by
  where pa.match_id <> p_match_id
    and pa.reported_by in (select sr.reported_by from public.score_reports sr where sr.match_id = p_match_id)
    and pb.reported_by in (select sr.reported_by from public.score_reports sr where sr.match_id = p_match_id);

  -- 4.6 Blend. Weights are judgement calls, saturating so one loud signal
  -- cannot alone cross the line; a shared IP plus anything else does.
  v_score := least(
    1.0,
      0.25 * (least(v_pairing_7d, 4)::numeric / 4.0)
    + 0.20 * (least(v_farming_7d, v_farm_limit)::numeric / greatest(v_farm_limit, 1)::numeric)
    + 0.20 * (case when v_lopsided_fast then 1 else 0 end)
    + 0.25 * (case when v_shared_ip_pairs > 0 then 1 else 0 end)
    + 0.10 * (least(v_pair_frequency, 5)::numeric / 5.0)
  );

  return jsonb_build_object(
    'match_id',                p_match_id::text,
    'repeat_pairing_7d',       v_pairing_7d,
    'repeat_pairing_90d',      v_pairing_90d,
    'rating_farming_7d',       v_farming_7d,
    'rating_farm_limit',       v_farm_limit,
    'rating_farming_exceeded', v_farming_7d > v_farm_limit,
    'shared_ip_reporter_pairs', v_shared_ip_pairs,
    'reporter_pair_frequency', v_pair_frequency,
    'lopsided_fast_report',    v_lopsided_fast,
    'goal_diff',               v_goal_diff,
    'report_lag_seconds',      v_report_lag,
    'collusion_score',         round(v_score, 5),
    'is_suspicious',           v_score >= private.integrity_setting('collusion_threshold', 0.5)
  );
end;
$fn$;

-- Authorised entry point. Same output, admin/service only.
create or replace function public.collusion_signals(p_match_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  perform private.assert_integrity_reader();
  return private.collusion_signals_core(p_match_id);
end;
$fn$;

comment on function public.collusion_signals(uuid) is
  'Explainable anti-collusion heuristics for one match: repeat pairings, rating farming, lopsided-and-fast reporting, shared reporter IP hashes, reporter co-occurrence. Pure/STABLE so it can be embedded in the anomaly feature vector. Admin/service_role only.';

-- Volatile companion: persists the heuristics so the admin queue and the ML
-- service can read them without recomputation. Kept separate because a STABLE
-- function may not write (Postgres runs it read-only).
create or replace function private.persist_collusion_signals(p_match_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_signals jsonb;
begin
  v_signals := private.collusion_signals_core(p_match_id);

  insert into public.match_collusion_signals as mcs
    (match_id, signals, collusion_score, is_suspicious, computed_at)
  values (
    p_match_id,
    v_signals,
    least(greatest(coalesce((v_signals ->> 'collusion_score')::numeric, 0), 0), 1),
    coalesce((v_signals ->> 'is_suspicious')::boolean, false),
    now()
  )
  on conflict (match_id) do update
    set signals         = excluded.signals,
        collusion_score = excluded.collusion_score,
        is_suspicious   = excluded.is_suspicious,
        computed_at     = excluded.computed_at;

  return v_signals;
end;
$fn$;

-- -----------------------------------------------------------------------------
-- 5. Feature engineering for the Isolation Forest
--
-- One implementation, two entry points: a batch SETOF for the poller and a
-- single-match jsonb for debugging / enrichment. Everything is measured
-- relative to kickoff_at rather than now(), so a feature vector recomputed
-- tomorrow for the same match is byte-identical to the one scored today. That
-- reproducibility is what makes model drift diagnosable.
-- -----------------------------------------------------------------------------

create or replace function private.match_feature_rows(p_match_ids uuid[])
returns setof public.match_anomaly_feature_row
language sql
stable
security definer
set search_path = ''
as $fn$
  with target as (
    select m.id,
           m.kickoff_at,
           m.duration_minutes,
           m.venue_id,
           m.home_score,
           m.away_score,
           coalesce(v.timezone, 'Europe/Istanbul') as tz,
           m.kickoff_at + make_interval(mins => m.duration_minutes) as final_whistle_at
    from public.matches m
    left join public.venues v on v.id = m.venue_id
    where m.id = any (p_match_ids)
  ),
  rep as (
    select sr.match_id,
           count(*)::integer as reporter_count,
           coalesce(var_pop(sr.home_score::numeric), 0)
             + coalesce(var_pop(sr.away_score::numeric), 0) as score_variance,
           min(sr.reported_at) as first_reported_at,
           (array_agg(sr.home_score order by sr.reported_at, sr.id))[1] as first_home,
           (array_agg(sr.away_score order by sr.reported_at, sr.id))[1] as first_away
    from public.score_reports sr
    where sr.match_id = any (p_match_ids)
    group by sr.match_id
  ),
  agree as (
    -- Fraction of (home-side report x away-side report) pairs that match
    -- exactly. 1.0 = the two camps told the same story, 0.0 = nobody agrees.
    select h.match_id,
           (count(*) filter (
              where h.home_score = a.home_score and h.away_score = a.away_score
           ))::numeric / nullif(count(*), 0)::numeric as agreement_ratio
    from public.score_reports h
    join public.score_reports a
      on a.match_id = h.match_id
     and a.team_side = 'away'
    where h.match_id = any (p_match_ids)
      and h.team_side = 'home'
    group by h.match_id
  )
  select
    t.id::uuid,
    coalesce(r.score_variance, 0)::numeric,
    coalesce(extract(epoch from (r.first_reported_at - t.final_whistle_at)), 0)::numeric,
    coalesce(r.reporter_count, 0)::integer,
    coalesce(ag.agreement_ratio, 0)::numeric,
    coalesce(ov.overlap_ratio, 0)::numeric,
    coalesce(dv.deviation, 0)::numeric,
    abs(coalesce(t.home_score, r.first_home, 0) - coalesce(t.away_score, r.first_away, 0))::integer,
    extract(hour from (t.kickoff_at at time zone t.tz))::integer,
    coalesce(vb.bookings_7d, 0)::integer,
    greatest(coalesce(aa.min_age_days, 0), 0)::numeric
  from target t
  left join rep   r  on r.match_id  = t.id
  left join agree ag on ag.match_id = t.id
  -- participant_overlap_ratio: of every earlier match any of these players
  -- appeared in, what share pitted this home side against this away side again?
  -- 1.0 means these two groups only ever play each other.
  left join lateral (
    select case when tot.n = 0 then 0::numeric else h2h.n::numeric / tot.n::numeric end as overlap_ratio
    from (
      select count(distinct m2.id) as n
      from public.match_participants pa
      join public.match_participants pb
        on pb.match_id = pa.match_id
       and pb.team_side <> pa.team_side
      join public.matches m2 on m2.id = pa.match_id
      where m2.id <> t.id
        and m2.kickoff_at < t.kickoff_at
        and pa.player_id in (
          select mp.player_id from public.match_participants mp
          where mp.match_id = t.id and mp.team_side = 'home'
        )
        and pb.player_id in (
          select mp.player_id from public.match_participants mp
          where mp.match_id = t.id and mp.team_side = 'away'
        )
    ) h2h,
    (
      select count(distinct m3.id) as n
      from public.match_participants pc
      join public.matches m3 on m3.id = pc.match_id
      where m3.id <> t.id
        and m3.kickoff_at < t.kickoff_at
        and pc.player_id in (
          select mp.player_id from public.match_participants mp where mp.match_id = t.id
        )
    ) tot
  ) ov on true
  -- historical_report_deviation: mean |reported - confirmed| across every past
  -- report filed by the people reporting this match. A reporter who is usually
  -- right carries more weight than one who is usually two goals off.
  left join lateral (
    select coalesce(avg(
             abs(prev.home_score - m4.home_score) + abs(prev.away_score - m4.away_score)
           ), 0)::numeric as deviation
    from public.score_reports cur
    join public.score_reports prev
      on prev.reported_by = cur.reported_by
     and prev.match_id <> cur.match_id
    join public.matches m4
      on m4.id = prev.match_id
     and m4.score_confirmed_at is not null
     and m4.home_score is not null
     and m4.away_score is not null
     and m4.kickoff_at < t.kickoff_at
    where cur.match_id = t.id
  ) dv on true
  left join lateral (
    select count(*)::integer as bookings_7d
    from public.bookings b
    join public.pitches p on p.id = b.pitch_id
    where p.venue_id = t.venue_id
      and b.created_at >= t.kickoff_at - interval '7 days'
      and b.created_at <  t.kickoff_at
  ) vb on true
  left join lateral (
    select min(extract(epoch from (t.kickoff_at - pr.created_at)) / 86400.0) as min_age_days
    from public.score_reports sr2
    join public.profiles pr on pr.id = sr2.reported_by
    where sr2.match_id = t.id
  ) aa on true;
$fn$;

comment on function private.match_feature_rows(uuid[]) is
  'Single implementation of the Isolation Forest feature vector. All features are measured relative to kickoff_at, never now(), so vectors are reproducible.';

-- Batch entry point for the Python service poller. service_role only.
create or replace function public.matches_pending_anomaly_check(p_limit integer default 100)
returns setof public.match_anomaly_feature_row
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 1000));
begin
  perform private.assert_integrity_reader();

  return query
  select f.*
  from private.match_feature_rows(
    array(
      select m.id
      from public.matches m
      where m.status <> 'cancelled'::public.match_status
        and exists (select 1 from public.score_reports sr where sr.match_id = m.id)
        and (
          m.anomaly_checked_at is null
          or exists (
            select 1 from public.score_reports sr2
            where sr2.match_id = m.id and sr2.reported_at > m.anomaly_checked_at
          )
        )
      order by m.kickoff_at asc
      limit v_limit
    )
  ) f;
end;
$fn$;

comment on function public.matches_pending_anomaly_check(integer) is
  'Poller contract for the Isolation Forest microservice: matches that have at least one score report and have never been scored, or whose reports changed since the last scoring pass. service_role only.';

create or replace function public.anomaly_features(p_match_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_row public.match_anomaly_feature_row;
begin
  perform private.assert_integrity_reader();

  select * into v_row from private.match_feature_rows(array[p_match_id]) limit 1;

  if v_row.match_id is null then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  -- The collusion heuristics ride along as a nested object so the service can
  -- either use them as extra features or surface them verbatim in the reason
  -- codes it posts back through record_anomaly_verdict().
  return to_jsonb(v_row) || jsonb_build_object('collusion', private.collusion_signals_core(p_match_id));
end;
$fn$;

comment on function public.anomaly_features(uuid) is
  'Feature vector for one match as jsonb, key-for-key identical to match_anomaly_feature_row, plus a nested collusion object from public.collusion_signals().';

-- -----------------------------------------------------------------------------
-- 6. Anomaly verdict ingestion
--
-- The Isolation Forest itself lives in a Python service; nothing about the model
-- runs in Postgres. What lives here is the durable half of the contract: the
-- feature vector it reads (section 5) and the verdict it writes (below).
-- Swapping Isolation Forest for anything else is a matter of writing a
-- different model_version into the same call.
-- -----------------------------------------------------------------------------

create or replace function public.record_anomaly_verdict(
  p_match_id            uuid,
  p_source              text    default 'isolation_forest',
  p_anomaly_score       numeric default null,
  p_is_anomalous        boolean default null,
  p_reasons             jsonb   default '[]'::jsonb,
  p_model_version       text    default null,
  p_leaf_depth          integer default null,
  p_average_path_length numeric default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_m         public.matches%rowtype;
  v_threshold numeric := public.anomaly_score_threshold();
  v_anomalous boolean;
  v_flag_id   uuid;
  v_collusion jsonb;
  v_opened    boolean := false;
begin
  perform private.assert_integrity_reader();

  if p_source is null or p_source not in ('rule_engine', 'isolation_forest', 'manual') then
    raise exception using
      errcode = 'PT422',
      message = 'source must be one of rule_engine, isolation_forest, manual.';
  end if;

  if p_anomaly_score is not null and (p_anomaly_score < 0 or p_anomaly_score > 1) then
    raise exception using
      errcode = 'PT422',
      message = 'anomaly_score must be in [0,1]: it is 2^(-E[h(x)]/c(n)).';
  end if;

  select * into v_m from public.matches m where m.id = p_match_id for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  -- A higher score means a shorter isolation path and a more anomalous sample.
  -- An explicit p_is_anomalous from the service always wins over the threshold.
  v_anomalous := coalesce(p_is_anomalous, p_anomaly_score >= v_threshold, false);

  insert into public.match_anomaly_flags
    (match_id, source, anomaly_score, is_anomalous, reasons, model_version, leaf_depth, average_path_length)
  values
    (p_match_id, p_source, p_anomaly_score, v_anomalous,
     coalesce(p_reasons, '[]'::jsonb), p_model_version, p_leaf_depth, p_average_path_length)
  returning id into v_flag_id;

  update public.matches
     set anomaly_score      = coalesce(p_anomaly_score, anomaly_score),
         anomaly_checked_at = now()
   where id = p_match_id;

  v_collusion := private.persist_collusion_signals(p_match_id);

  -- Crossing the threshold forces the match into peer consensus even when the
  -- reports agreed with each other: agreement between colluding parties is
  -- exactly what the detector exists to catch.
  if v_anomalous
     and v_m.status not in (
       'cancelled'::public.match_status,
       'disputed'::public.match_status,
       'finalized'::public.match_status
     )
     and v_m.score_confirmed_at is null then
    perform private.open_consensus_round_unchecked(
      p_match_id,
      'anomaly_detector',
      jsonb_build_object(
        'reasons',       coalesce(p_reasons, '[]'::jsonb),
        'anomaly_score', p_anomaly_score,
        'model_version', p_model_version,
        'threshold',     v_threshold
      )
    );
    v_opened := true;
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    private.actor_id(), 'match.anomaly_recorded', 'matches', p_match_id,
    jsonb_build_object(
      'source',              p_source,
      'anomaly_score',       p_anomaly_score,
      'threshold',           v_threshold,
      'is_anomalous',        v_anomalous,
      'model_version',       p_model_version,
      'leaf_depth',          p_leaf_depth,
      'average_path_length', p_average_path_length,
      'opened_consensus',    v_opened
    )
  );

  return jsonb_build_object(
    'match_id',         p_match_id::text,
    'flag_id',          v_flag_id::text,
    'source',           p_source,
    'anomaly_score',    p_anomaly_score,
    'threshold',        v_threshold,
    'is_anomalous',     v_anomalous,
    'opened_consensus', v_opened,
    'collusion',        v_collusion
  );
end;
$fn$;

comment on function public.record_anomaly_verdict(uuid, text, numeric, boolean, jsonb, text, integer, numeric) is
  'Ingestion contract for the Isolation Forest service. score = 2^(-E[h(x)]/c(n)) in [0,1]; a short average path length (leaf near the root) means the sample was easily isolated and therefore anomalous, which is why higher scores are worse. Crossing anomaly_score_threshold() (default 0.62) opens a peer-consensus round. service_role only.';

-- -----------------------------------------------------------------------------
-- 7. Cryptographic peer consensus
-- -----------------------------------------------------------------------------

-- 7.1 CANONICAL PAYLOAD
--
-- The digest is only meaningful if every client rebuilds byte-identical input,
-- so the canonical form is pinned here in full.
--
-- Canonical bytes = the Postgres `jsonb::text` rendering of the object below.
-- jsonb normalises key order to (key length ASC, then bytewise ASC on the key),
-- and renders `", "` between members and `": "` after each key. For this exact
-- key set that resolves to one, and only one, ordering:
--
--   {"nonce": "<32 lowercase hex chars>",
--    "match_id": "<lowercase uuid>",
--    "away_score": <int>,
--    "home_score": <int>,
--    "reported_at": "YYYY-MM-DDTHH:MM:SSZ",
--    "participant_ids": ["<uuid>", "<uuid>", ...]}
--
-- rendered with no newlines, exactly one space after each ':' and each ',',
-- and no trailing space. A JS client must therefore emit the fields in the
-- order nonce, match_id, away_score, home_score, reported_at, participant_ids
-- (not plain alphabetical -- 'nonce' sorts first because it is the shortest
-- key, and 'away_score' precedes 'home_score' only because they tie on length).
--
-- Value rules:
--   nonce            lowercase hex of the 16 server-issued bytes.
--   match_id         canonical lowercase uuid text.
--   away/home_score  JSON integers, no quotes, no decimal point.
--   reported_at      earliest score report on the match, forced to UTC and
--                    truncated to whole seconds. Never rendered through
--                    to_jsonb(timestamptz), whose output depends on the session
--                    TimeZone GUC and would silently differ per connection.
--   participant_ids  every row in match_participants for the match, as lowercase
--                    uuid strings, sorted ascending by byte (COLLATE "C").
--                    Adding or removing a participant changes the digest by
--                    design: an approval is bound to a roster as well as to a
--                    scoreline, and a roster change requires a fresh round.
--
-- Clients should hardcode the field order above rather than re-derive it from
-- the sorting rule. The digest itself is not a secret: anyone entitled to read
-- the payload can compute it, and the server hands the expected value back in
-- the mismatch error so honest clients can resync. What the check buys is
-- evidence. A stored approval says exactly which scoreline, roster and round
-- its owner assented to, and a client showing a stale score can never have
-- that assent counted.
create or replace function public.consensus_payload(p_match_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_m            public.matches%rowtype;
  v_uid          uuid := (select auth.uid());
  v_home         integer;
  v_away         integer;
  v_reported     timestamptz;
  v_participants jsonb;
begin
  select * into v_m from public.matches m where m.id = p_match_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  -- Readable by the people bound by it: the line-up, the host venue, admins,
  -- and server-side callers.
  if v_uid is not null
     and not private.is_integrity_admin()
     and not exists (
       select 1 from public.match_participants mp
       where mp.match_id = p_match_id and mp.player_id = v_uid
     )
     and not exists (
       select 1 from public.venues v
       where v.id = v_m.venue_id and v.owner_id = v_uid
     ) then
    raise exception using
      errcode = 'PT403',
      message = 'Only people involved in this match can see its consensus payload.';
  end if;

  if v_m.consensus_nonce is null then
    raise exception using
      errcode = 'PT409',
      message = 'No consensus round is open for this match.',
      hint    = 'Call public.open_consensus_round(match_id) first.';
  end if;

  select s.home_score, s.away_score, s.reported_at
    into v_home, v_away, v_reported
  from private.consensus_scoreline(p_match_id) s;

  if v_home is null or v_away is null then
    raise exception using
      errcode = 'PT409',
      message = 'Nobody has reported a score for this match yet, so there is nothing to ratify.';
  end if;

  -- COLLATE "C" is load-bearing: the default database collation may sort text
  -- with locale rules, and the client rebuilding this array will be using plain
  -- code-unit ordering. For lowercase hex uuids the two happen to agree today,
  -- but pinning byte order here means the digest can never drift because
  -- somebody changed the database collation.
  select coalesce(jsonb_agg(to_jsonb(x.pid) order by x.pid collate "C"), '[]'::jsonb)
    into v_participants
  from (
    select mp.player_id::text as pid
    from public.match_participants mp
    where mp.match_id = p_match_id
  ) x;

  return jsonb_build_object(
    'nonce',           encode(v_m.consensus_nonce, 'hex'),
    'match_id',        p_match_id::text,
    'away_score',      v_away,
    'home_score',      v_home,
    'reported_at',     to_char((v_reported at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'participant_ids', v_participants
  );
end;
$fn$;

comment on function public.consensus_payload(uuid) is
  'The canonical payload approvers sign. Canonical bytes are the jsonb::text rendering: keys ordered by (length, bytewise) => nonce, match_id, away_score, home_score, reported_at, participant_ids; one space after every colon and comma; UTC second-precision timestamp; participant uuids sorted ascending as text. Rebuild these exact bytes client-side or your digest will not match.';

-- 7.2 Opening a round -- unchecked internal core.
create or replace function private.open_consensus_round_unchecked(
  p_match_id uuid,
  p_reason   text  default 'score_disagreement',
  p_context  jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_m        public.matches%rowtype;
  v_nonce    bytea;
  v_deadline timestamptz;
  v_stale    integer := 0;
  v_notified integer := 0;
  v_hours    numeric := private.integrity_setting('consensus_hours', 24);
begin
  select * into v_m from public.matches m where m.id = p_match_id for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  if v_m.status in ('cancelled'::public.match_status) then
    raise exception using errcode = 'PT409', message = 'This match was cancelled.';
  end if;

  if v_m.score_confirmed_at is not null or v_m.status = 'finalized'::public.match_status then
    raise exception using
      errcode = 'PT409',
      message = 'The result of this match is already final.';
  end if;

  v_nonce    := extensions.gen_random_bytes(16);
  v_deadline := now() + make_interval(mins => (v_hours * 60)::int);

  -- Rotating the nonce invalidates every digest signed against the old one, so
  -- the stale votes are archived to the audit log and cleared: the UNIQUE
  -- (match_id, approver_id) constraint would otherwise lock everyone out of the
  -- new round.
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  select ca.approver_id, 'match.consensus_vote_superseded', 'matches', p_match_id,
         jsonb_build_object(
           'decision',       ca.decision,
           'payload_digest', encode(ca.payload_digest, 'hex'),
           'nonce',          encode(ca.nonce, 'hex'),
           'signature_alg',  ca.signature_alg,
           'approved_at',    ca.approved_at
         )
  from public.consensus_approvals ca
  where ca.match_id = p_match_id;

  delete from public.consensus_approvals ca where ca.match_id = p_match_id;
  get diagnostics v_stale = row_count;

  update public.matches
     set consensus_nonce           = v_nonce,
         consensus_nonce_issued_at = now(),
         requires_consensus        = true,
         consensus_deadline        = v_deadline,
         status                    = 'requires_consensus'::public.match_status
   where id = p_match_id;

  v_notified := private.notify_participants(
    p_match_id,
    'match.consensus_required',
    'Confirm the final score',
    case p_reason
      when 'score_disagreement'   then 'The results reported for your match do not line up. Review the score and cast your vote before the deadline.'
      when 'scoreline_superseded' then 'A new report changed the score on the table, so the vote has restarted. Please review it again.'
      when 'anomaly_detector'     then 'This result was flagged for review. Please confirm the score so it can be recorded.'
      else 'Please confirm the final score for your match before the deadline.'
    end,
    jsonb_build_object('reason', p_reason, 'deadline', v_deadline, 'context', coalesce(p_context, '{}'::jsonb))
  );

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    private.actor_id(), 'match.consensus_opened', 'matches', p_match_id,
    jsonb_build_object(
      'reason',           p_reason,
      'deadline',         v_deadline,
      'superseded_votes', v_stale,
      'notified',         v_notified,
      'context',          coalesce(p_context, '{}'::jsonb)
    )
  );

  return jsonb_build_object(
    'match_id',           p_match_id::text,
    'nonce',              encode(v_nonce, 'hex'),
    'consensus_deadline', v_deadline,
    'reason',             p_reason,
    'superseded_votes',   v_stale,
    'notified',           v_notified
  );
end;
$fn$;

-- 7.3 Opening a round -- authorised public entry point.
create or replace function public.open_consensus_round(p_match_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_m   public.matches%rowtype;
begin
  select * into v_m from public.matches m where m.id = p_match_id;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  if v_uid is not null and not private.is_integrity_admin() then
    -- A participant may only open a round on a match that actually has
    -- conflicting reports; the venue owner may always escalate their own match.
    if exists (select 1 from public.venues v where v.id = v_m.venue_id and v.owner_id = v_uid) then
      null;
    elsif exists (
      select 1 from public.match_participants mp
      where mp.match_id = p_match_id and mp.player_id = v_uid
    ) then
      if (
        select count(distinct (sr.home_score, sr.away_score))
        from public.score_reports sr
        where sr.match_id = p_match_id
      ) < 2 then
        raise exception using
          errcode = 'PT409',
          message = 'There is nothing to vote on yet: the reported scores do not conflict.';
      end if;
    else
      raise exception using
        errcode = 'PT403',
        message = 'Only people involved in this match can open a consensus round.';
    end if;
  end if;

  return private.open_consensus_round_unchecked(p_match_id, 'manual', jsonb_build_object('opened_by', v_uid));
end;
$fn$;

comment on function public.open_consensus_round(uuid) is
  'Mints a fresh 16-byte nonce for the match, clears superseded votes (archiving them to audit_log), flips the match into requires_consensus with a 24h deadline, and notifies the line-up. Callable by participants with conflicting reports, the venue owner, admins and service_role.';

-- 7.4 Casting a vote.
--
-- A bare "I approve" does not say what was approved: a client could be shown
-- 3-2, vote yes, and have the server finalise 5-0. So the client has to send
-- digest(canonical_payload, 'sha256') computed over the bytes it actually
-- rendered, and the server compares that against its own recomputation. An
-- approval is then a commitment to one specific scoreline, one specific roster
-- and one specific round nonce.
--
-- p_signature is an HMAC-SHA256 produced client-side over the digest using a
-- key derived from the user's Supabase session (a per-session secret, never the
-- JWT itself). The server stores it as evidence rather than verifying it, so it
-- is a tamper-evident receipt and not an authentication factor; GoTrue has
-- already authenticated the session.
--
-- Upgrade path to Ed25519: the signature_alg column drives interpretation, and
-- p_signature_alg is the fifth (defaulted) parameter, so the existing four-arg
-- call site keeps working unchanged. When device keypairs land, clients pass
-- 'ed25519' plus a base64 signature over the same digest bytes, a verifier is
-- added here keyed on signature_alg, and historical 'hmac-sha256' rows stay
-- valid under their original semantics. Nothing about the canonical payload,
-- the digest or the quorum rule changes.
create or replace function public.submit_consensus_approval(
  p_match_id      uuid,
  p_decision      text,
  p_client_digest bytea,
  p_signature     text default null,
  p_signature_alg text default 'hmac-sha256'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid            uuid := (select auth.uid());
  v_m              public.matches%rowtype;
  v_side           text;
  v_is_confirmed   boolean;
  v_payload        jsonb;
  v_server_digest  bytea;
  v_approval_id    uuid;
  v_finalization   jsonb;
begin
  if v_uid is null then
    raise exception using
      errcode = 'PT401',
      message = 'You must be signed in to vote on a match result.';
  end if;

  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception using
      errcode = 'PT422',
      message = 'decision must be approve or reject.';
  end if;

  if p_signature_alg is null or p_signature_alg not in ('hmac-sha256', 'ed25519') then
    raise exception using
      errcode = 'PT422',
      message = 'signature_alg must be hmac-sha256 or ed25519.';
  end if;

  -- Serialises this vote against concurrent votes, round rotations and
  -- finalisation on the same match.
  select * into v_m from public.matches m where m.id = p_match_id for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  select mp.team_side, mp.is_confirmed
    into v_side, v_is_confirmed
  from public.match_participants mp
  where mp.match_id = p_match_id and mp.player_id = v_uid;

  if v_side is null then
    raise exception using
      errcode = 'PT403',
      message = 'Only players who took part in this match can vote on its result.';
  end if;

  if not v_m.requires_consensus or v_m.consensus_nonce is null then
    raise exception using
      errcode = 'PT409',
      message = 'There is no open consensus round for this match.';
  end if;

  if v_m.score_confirmed_at is not null or v_m.status = 'finalized'::public.match_status then
    raise exception using
      errcode = 'PT409',
      message = 'The result of this match is already final.';
  end if;

  if v_m.status = 'disputed'::public.match_status then
    raise exception using
      errcode = 'PT409',
      message = 'This result has been escalated to an administrator, so voting is closed.';
  end if;

  if v_m.consensus_deadline is not null and now() > v_m.consensus_deadline then
    raise exception using
      errcode = 'PT409',
      message = 'The voting window for this match has closed.',
      hint    = 'An administrator now has to settle the result.';
  end if;

  if exists (
    select 1 from public.consensus_approvals ca
    where ca.match_id = p_match_id and ca.approver_id = v_uid
  ) then
    raise exception using
      errcode = 'PT409',
      message = 'You have already voted in this round.';
  end if;

  -- Recompute the canonical bytes server-side and bind the vote to them.
  v_payload       := public.consensus_payload(p_match_id);
  v_server_digest := extensions.digest(v_payload::text, 'sha256');

  if p_client_digest is null then
    raise exception using
      errcode = 'PT422',
      message = 'A payload digest is required.',
      hint    = 'Send sha256 of the canonical payload rendered exactly as documented on public.consensus_payload().';
  end if;

  if p_client_digest <> v_server_digest then
    raise exception using
      errcode = 'PT409',
      message = 'Your vote does not match the result currently on the table.',
      detail  = format('expected sha256 %s', encode(v_server_digest, 'hex')),
      hint    = 'Reload the match, re-read public.consensus_payload() and vote again.';
  end if;

  insert into public.consensus_approvals
    (match_id, approver_id, decision, canonical_payload, payload_digest, nonce, signature, signature_alg)
  values
    (p_match_id, v_uid, p_decision, v_payload, v_server_digest, v_m.consensus_nonce, p_signature, p_signature_alg)
  returning id into v_approval_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    v_uid, 'match.consensus_vote', 'matches', p_match_id,
    jsonb_build_object(
      'decision',       p_decision,
      'team_side',      v_side,
      'is_confirmed',   coalesce(v_is_confirmed, false),
      'signature_alg',  p_signature_alg,
      'payload_digest', encode(v_server_digest, 'hex')
    )
  );

  -- Every vote is a chance to reach quorum; finalize is idempotent and cheap.
  v_finalization := public.finalize_consensus(p_match_id);

  return jsonb_build_object(
    'approval_id',    v_approval_id::text,
    'match_id',       p_match_id::text,
    'decision',       p_decision,
    'team_side',      v_side,
    'signature_alg',  p_signature_alg,
    'payload_digest', encode(v_server_digest, 'hex'),
    'finalization',   v_finalization
  );
end;
$fn$;

comment on function public.submit_consensus_approval(uuid, text, bytea, text, text) is
  'Casts one signed vote in the open consensus round. Recomputes sha256 over the canonical payload server-side and rejects on a digest mismatch, which is what binds an approval to a specific scoreline, roster and nonce rather than a bare yes. signature is an HMAC-SHA256 receipt derived from the session-scoped key; pass signature_alg = ed25519 to switch to device keys without changing the call shape.';

-- 7.5 Applying ratings exactly once.
--
-- public.apply_match_rating(uuid) is owned by the rating migration. It is
-- resolved dynamically so this migration applies cleanly whether or not that
-- one has run yet, and so a partial install degrades into "rating deferred"
-- rather than a hard failure in the middle of finalisation.
create or replace function private.apply_rating_once(p_match_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_m  public.matches%rowtype;
  v_fn oid;
begin
  select * into v_m from public.matches m where m.id = p_match_id for update;
  if not found then
    return false;
  end if;

  if not v_m.is_ranked then
    return false;
  end if;

  -- The row lock plus this guard is what makes double-application impossible
  -- even if two finalisation paths race.
  if v_m.rating_applied_at is not null then
    return false;
  end if;

  v_fn := to_regprocedure('public.apply_match_rating(uuid)');

  if v_fn is null then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      null, 'match.rating_deferred', 'matches', p_match_id,
      jsonb_build_object('reason', 'public.apply_match_rating(uuid) is not installed')
    );
    -- rating_applied_at deliberately stays NULL so the pending-rating backfill
    -- (idx_matches_pending_rating) still picks this match up later.
    return false;
  end if;

  -- The rating engine raises on malformed line-ups (e.g. an empty side), and
  -- this bridge is reached from AFTER-INSERT triggers on ordinary user writes
  -- (score_reports -> evaluate_score_consensus -> here). A bare call would let
  -- a rating-engine raise abort the caller's whole transaction, i.e. an
  -- unrelated player's INSERT. The BEGIN/EXCEPTION opens a subtransaction so a
  -- failure rolls back only the rating work and the caller commits.
  begin
    execute 'select public.apply_match_rating($1)' using p_match_id;
  exception when others then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      null, 'match.rating_deferred', 'matches', p_match_id,
      jsonb_build_object(
        'reason',   'public.apply_match_rating(uuid) raised',
        'sqlstate', sqlstate,
        'error',    sqlerrm
      )
    );
    -- rating_applied_at deliberately stays NULL so the pending-rating backfill
    -- (idx_matches_pending_rating) still picks this match up later.
    return false;
  end;

  -- If the rating function already stamped the match this is a no-op, and the
  -- WHERE clause keeps the idempotency guard trigger from firing.
  update public.matches
     set rating_applied_at = now()
   where id = p_match_id
     and rating_applied_at is null;

  return true;
end;
$fn$;

comment on function private.apply_rating_once(uuid) is
  'Row-locked, single-shot bridge to public.apply_match_rating(uuid). Resolves the target dynamically so this migration is independent of the rating migration order; logs match.rating_deferred and leaves rating_applied_at NULL when the rating engine is absent.';

-- Belt to the apply_rating_once braces: once a match has been rated, its stamp
-- may not be moved or cleared. An administrative recompute must opt in with
--   set local app.allow_rating_reset = 'on';
create or replace function public.guard_rating_idempotency()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  if old.rating_applied_at is not null
     and new.rating_applied_at is distinct from old.rating_applied_at
     and coalesce(current_setting('app.allow_rating_reset', true), 'off') <> 'on' then
    raise exception using
      errcode = 'PT409',
      message = 'Ratings for this match have already been applied and cannot be applied again.',
      hint    = 'Admin recomputes must set local app.allow_rating_reset to on for the transaction.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_matches_guard_rating_idempotency on public.matches;
create trigger trg_matches_guard_rating_idempotency
  before update of rating_applied_at on public.matches
  for each row
  when (old.rating_applied_at is not null)
  execute function public.guard_rating_idempotency();

-- 7.6 Quorum and finalisation.
create or replace function public.finalize_consensus(p_match_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_m          public.matches%rowtype;
  v_eligible   integer;
  v_lineup     integer;
  v_quorum     integer;
  v_approvals  integer;
  v_rejections integer;
  v_home_ok    boolean;
  v_away_ok    boolean;
  v_payload    jsonb;
  v_digest     bytea;
  v_home       integer;
  v_away       integer;
  v_rated      boolean := false;
begin
  select * into v_m from public.matches m where m.id = p_match_id for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  if (select auth.uid()) is not null
     and not private.is_integrity_admin()
     and not exists (
       select 1 from public.match_participants mp
       where mp.match_id = p_match_id and mp.player_id = (select auth.uid())
     )
     and not exists (
       select 1 from public.venues v
       where v.id = v_m.venue_id and v.owner_id = (select auth.uid())
     ) then
    raise exception using
      errcode = 'PT403',
      message = 'Only people involved in this match can close its consensus round.';
  end if;

  -- Idempotent: a second call after finalisation is a no-op, not an error.
  if v_m.status = 'finalized'::public.match_status or v_m.score_confirmed_at is not null then
    return jsonb_build_object(
      'decision',   'already_finalized',
      'match_id',   p_match_id::text,
      'home_score', v_m.home_score,
      'away_score', v_m.away_score
    );
  end if;

  -- Also idempotent on the way out: once a round has been escalated to a human
  -- the quorum arithmetic must not run again, or every sweep would re-page the
  -- admins for the same match.
  if v_m.status = 'disputed'::public.match_status then
    return jsonb_build_object('decision', 'already_disputed', 'match_id', p_match_id::text);
  end if;

  if not v_m.requires_consensus or v_m.consensus_nonce is null then
    return jsonb_build_object('decision', 'no_open_round', 'match_id', p_match_id::text);
  end if;

  -- Electorate: confirmed participants. is_confirmed defaults to false in 0001
  -- and plenty of pickup matches never run a check-in, so fall back to the full
  -- line-up rather than handing quorum to a single voter.
  select (count(*) filter (where mp.is_confirmed))::integer,
         count(*)::integer
    into v_eligible, v_lineup
  from public.match_participants mp
  where mp.match_id = p_match_id;

  if coalesce(v_eligible, 0) = 0 then
    v_eligible := coalesce(v_lineup, 0);
  end if;

  if v_eligible < 2 then
    return jsonb_build_object(
      'decision',  'insufficient_electorate',
      'match_id',  p_match_id::text,
      'eligible',  v_eligible,
      'detail',    'A consensus round needs at least two participants; escalate to an administrator.'
    );
  end if;

  -- Two thirds, rounded up, never fewer than two.
  v_quorum := greatest(2, ceil(2.0 * v_eligible / 3.0)::integer);

  -- A round can be opened by an admin or the detector before anyone has filed a
  -- report; there is then nothing to ratify and consensus_payload would raise.
  if not exists (select 1 from public.score_reports sr where sr.match_id = p_match_id) then
    return jsonb_build_object('decision', 'no_scoreline', 'match_id', p_match_id::text);
  end if;

  -- The scoreline currently on the table, and its canonical digest.
  v_payload := public.consensus_payload(p_match_id);
  v_digest  := extensions.digest(v_payload::text, 'sha256');

  -- A vote only counts when it was cast against both the current round nonce
  -- and the current canonical payload. The nonce filter is belt (rotating a
  -- round already clears the old votes); the digest filter is the braces and
  -- does the real work here, because a late score report can change the
  -- most-corroborated scoreline underneath an open round, and nobody may be
  -- counted as approving a result they were never shown.
  select
    (count(*) filter (where ca.decision = 'approve'))::integer,
    (count(*) filter (where ca.decision = 'reject'))::integer,
    bool_or(ca.decision = 'approve' and mp.team_side = 'home'),
    bool_or(ca.decision = 'approve' and mp.team_side = 'away')
    into v_approvals, v_rejections, v_home_ok, v_away_ok
  from public.consensus_approvals ca
  join public.match_participants mp
    on mp.match_id = ca.match_id and mp.player_id = ca.approver_id
  where ca.match_id = p_match_id
    and ca.nonce = v_m.consensus_nonce
    and ca.payload_digest = v_digest;

  -- Approval quorum: 2/3 of the electorate and at least one approval from each
  -- side. The cross-side requirement is the anti-collusion half of the rule --
  -- one stacked dressing room can never ratify a result on its own.
  if v_approvals >= v_quorum and coalesce(v_home_ok, false) and coalesce(v_away_ok, false) then
    v_home := (v_payload ->> 'home_score')::integer;
    v_away := (v_payload ->> 'away_score')::integer;

    update public.matches
       set home_score         = v_home,
           away_score         = v_away,
           status             = 'finalized'::public.match_status,
           score_confirmed_at = now(),
           requires_consensus = false,
           consensus_deadline = null
     where id = p_match_id;

    v_rated := private.apply_rating_once(p_match_id);

    perform private.notify_participants(
      p_match_id,
      'match.finalized',
      'Final score confirmed',
      format('The result %s-%s has been ratified by your team-mates and opponents.', v_home, v_away),
      jsonb_build_object('homeScore', v_home, 'awayScore', v_away, 'via', 'peer_consensus')
    );

    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      private.actor_id(), 'match.consensus_finalized', 'matches', p_match_id,
      jsonb_build_object(
        'home_score',     v_home,
        'away_score',     v_away,
        'approvals',      v_approvals,
        'rejections',     v_rejections,
        'quorum',         v_quorum,
        'eligible',       v_eligible,
        'rating_applied', v_rated
      )
    );

    return jsonb_build_object(
      'decision',       'finalized',
      'match_id',       p_match_id::text,
      'home_score',     v_home,
      'away_score',     v_away,
      'approvals',      v_approvals,
      'rejections',     v_rejections,
      'quorum',         v_quorum,
      'eligible',       v_eligible,
      'rating_applied', v_rated
    );
  end if;

  -- Rejection quorum, or approval already arithmetically impossible.
  if v_rejections >= v_quorum or (v_eligible - v_rejections) < v_quorum then
    update public.matches
       set status = 'disputed'::public.match_status
     where id = p_match_id;

    perform private.notify_admins(
      'match.disputed',
      'Match result rejected by its players',
      'A consensus round closed with a rejection quorum. This result needs a human decision.',
      jsonb_build_object(
        'matchId',    p_match_id::text,
        'approvals',  v_approvals,
        'rejections', v_rejections,
        'eligible',   v_eligible
      )
    );

    perform private.notify_participants(
      p_match_id,
      'match.disputed',
      'Result sent to the referees',
      'Your match result could not be agreed, so an administrator will settle it.',
      jsonb_build_object('approvals', v_approvals, 'rejections', v_rejections)
    );

    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      private.actor_id(), 'match.consensus_rejected', 'matches', p_match_id,
      jsonb_build_object(
        'approvals',  v_approvals,
        'rejections', v_rejections,
        'quorum',     v_quorum,
        'eligible',   v_eligible
      )
    );

    -- requires_consensus stays true and consensus_deadline is left in place so
    -- the match keeps showing up in the admin queue (idx_matches_requires_consensus).
    return jsonb_build_object(
      'decision',   'disputed',
      'match_id',   p_match_id::text,
      'approvals',  v_approvals,
      'rejections', v_rejections,
      'quorum',     v_quorum,
      'eligible',   v_eligible
    );
  end if;

  return jsonb_build_object(
    'decision',           'pending',
    'match_id',           p_match_id::text,
    'approvals',          v_approvals,
    'rejections',         v_rejections,
    'quorum',             v_quorum,
    'eligible',           v_eligible,
    'both_sides_present', coalesce(v_home_ok, false) and coalesce(v_away_ok, false),
    'payload_digest',     encode(v_digest, 'hex'),
    'consensus_deadline', v_m.consensus_deadline
  );
end;
$fn$;

comment on function public.finalize_consensus(uuid) is
  'Row-locked, idempotent quorum evaluation: finalises when ceil(2/3) of the confirmed line-up approved AND at least one approval came from each side, then applies ratings exactly once. A rejection quorum (or an arithmetically unreachable approval) moves the match to disputed and pages the admins.';

-- -----------------------------------------------------------------------------
-- 8. Corroboration pass -- runs after every score report
-- -----------------------------------------------------------------------------

create or replace function public.evaluate_score_consensus(p_match_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_m            public.matches%rowtype;
  v_total        integer;
  v_home_reports integer;
  v_away_reports integer;
  v_neutral      integer;
  v_distinct     integer;
  v_variance     numeric;
  v_first_at     timestamptz;
  v_agreed_home  integer;
  v_agreed_away  integer;
  v_decision     text;
  v_accept_after timestamptz;
  v_collusion    jsonb;
  v_rated        boolean := false;
  v_round        jsonb;
  v_current_digest bytea;
  v_uid          uuid := (select auth.uid());
  v_privileged   boolean;
  v_hours        numeric := private.integrity_setting('uncontested_accept_hours', 24);
begin
  select * into v_m from public.matches m where m.id = p_match_id for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'That match does not exist.';
  end if;

  -- Anyone involved may trigger a re-evaluation (the UI does it on refresh),
  -- but only admins and server-side callers get to see the collusion internals
  -- in the verdict: telling a player which of their opponents share an IP hash
  -- would hand the cheats a debugger for the detector.
  v_privileged := v_uid is null or private.is_integrity_admin();

  if not v_privileged
     and not exists (
       select 1 from public.match_participants mp
       where mp.match_id = p_match_id and mp.player_id = v_uid
     )
     and not exists (
       select 1 from public.venues v
       where v.id = v_m.venue_id and v.owner_id = v_uid
     ) then
    raise exception using
      errcode = 'PT403',
      message = 'Only people involved in this match can evaluate its result.';
  end if;

  -- 'disputed' is terminal here for the same reason it is terminal in
  -- public.finalize_consensus (section 7.6): once a round has been escalated to
  -- a human, the quorum arithmetic must not run again and silently overturn the
  -- escalation.
  if v_m.status in ('cancelled'::public.match_status,
                    'finalized'::public.match_status,
                    'disputed'::public.match_status)
     or v_m.score_confirmed_at is not null then
    return jsonb_build_object('decision', 'noop', 'match_id', p_match_id::text, 'reason', 'match is not open for scoring');
  end if;

  select
    count(*)::integer,
    (count(*) filter (where sr.team_side = 'home'))::integer,
    (count(*) filter (where sr.team_side = 'away'))::integer,
    (count(*) filter (where sr.team_side is null))::integer,
    coalesce(var_pop(sr.home_score::numeric), 0) + coalesce(var_pop(sr.away_score::numeric), 0),
    min(sr.reported_at),
    count(distinct (sr.home_score, sr.away_score))::integer
    into v_total, v_home_reports, v_away_reports, v_neutral, v_variance, v_first_at, v_distinct
  from public.score_reports sr
  where sr.match_id = p_match_id;

  if coalesce(v_total, 0) = 0 then
    return jsonb_build_object('decision', 'awaiting_reports', 'match_id', p_match_id::text, 'reports_count', 0, 'variance', 0);
  end if;

  -- Two independent reports that agree exactly. Independent means different
  -- team_side values, and `is distinct from` deliberately treats a NULL side
  -- (venue owner / admin, the neutral observer) as different from both 'home'
  -- and 'away', so an owner corroborating either camp closes the match.
  select r1.home_score, r1.away_score
    into v_agreed_home, v_agreed_away
  from public.score_reports r1
  join public.score_reports r2
    on r2.match_id = r1.match_id
   and r2.id <> r1.id
   and r2.home_score = r1.home_score
   and r2.away_score = r1.away_score
   and r2.team_side is distinct from r1.team_side
  where r1.match_id = p_match_id
  order by r1.reported_at asc, r1.id asc
  limit 1;

  if v_agreed_home is not null then
    v_decision := 'accepted';
  elsif v_distinct > 1 then
    v_decision := 'contested';
  else
    -- One scoreline, but only one camp has spoken.
    --
    -- Policy: an uncontested report is accepted by default once the 24 hour
    -- rebuttal window has elapsed. Silence is treated as assent because the
    -- alternative -- results left permanently unrated whenever the losing side
    -- never opens the app -- is the more common failure and the one players
    -- complain about. The window runs from the first report, and any
    -- conflicting report inside it flips the match straight to contested.
    v_accept_after := v_first_at + make_interval(mins => (v_hours * 60)::int);
    if now() >= v_accept_after then
      select sr.home_score, sr.away_score into v_agreed_home, v_agreed_away
      from public.score_reports sr
      where sr.match_id = p_match_id
      order by sr.reported_at asc, sr.id asc
      limit 1;
      v_decision := 'accepted_by_default';
    else
      v_decision := 'awaiting_counterparty';
    end if;
  end if;

  v_collusion := private.persist_collusion_signals(p_match_id);

  if v_decision in ('accepted', 'accepted_by_default') then
    update public.matches
       set home_score         = v_agreed_home,
           away_score         = v_agreed_away,
           status             = 'finalized'::public.match_status,
           score_confirmed_at = now(),
           requires_consensus = false,
           consensus_deadline = null
     where id = p_match_id;

    v_rated := private.apply_rating_once(p_match_id);

    perform private.notify_participants(
      p_match_id,
      'match.finalized',
      'Final score confirmed',
      format('The result %s-%s is now official.', v_agreed_home, v_agreed_away),
      jsonb_build_object('homeScore', v_agreed_home, 'awayScore', v_agreed_away, 'via', v_decision)
    );

    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      private.actor_id(), 'match.score_finalized', 'matches', p_match_id,
      jsonb_build_object(
        'home_score',    v_agreed_home,
        'away_score',    v_agreed_away,
        'decision',      v_decision,
        'reports_count', v_total,
        'rating_applied', v_rated
      )
    );

  elsif v_decision = 'contested' then
    -- Cheap in-database verdict first, so there is always a rule_engine trail
    -- even when the Python service is down.
    insert into public.match_anomaly_flags
      (match_id, source, anomaly_score, is_anomalous, reasons, model_version)
    values (
      p_match_id,
      'rule_engine',
      least(1.0, round(v_variance / 20.0, 6)),
      true,
      jsonb_build_array('score_disagreement')
        || case when coalesce((v_collusion ->> 'is_suspicious')::boolean, false)
                then jsonb_build_array('collusion_suspected') else '[]'::jsonb end,
      'rule_engine.v1'
    );

    -- Open a round, or rotate an open one whose voters have been overtaken by
    -- events. A late report can change the most-corroborated scoreline while a
    -- round is running; every approval already cast was a commitment to the old
    -- scoreline and must be re-asked rather than silently re-purposed.
    -- finalize_consensus refuses to count those digests either way, so without
    -- the rotation the round would stall until its deadline.
    if v_m.requires_consensus and v_m.consensus_nonce is not null then
      v_current_digest := extensions.digest(public.consensus_payload(p_match_id)::text, 'sha256');
    end if;

    if not v_m.requires_consensus or v_m.consensus_nonce is null then
      v_round := private.open_consensus_round_unchecked(
        p_match_id,
        'score_disagreement',
        jsonb_build_object('variance', v_variance, 'reports_count', v_total, 'collusion', v_collusion)
      );
    elsif exists (
      select 1
      from public.consensus_approvals ca
      where ca.match_id = p_match_id
        and ca.payload_digest <> v_current_digest
    ) then
      v_round := private.open_consensus_round_unchecked(
        p_match_id,
        'scoreline_superseded',
        jsonb_build_object('variance', v_variance, 'reports_count', v_total, 'collusion', v_collusion)
      );
    else
      v_round := jsonb_build_object(
        'match_id',           p_match_id::text,
        'nonce',              encode(v_m.consensus_nonce, 'hex'),
        'consensus_deadline', v_m.consensus_deadline,
        'reason',             'round_already_open'
      );
    end if;

  elsif v_decision = 'awaiting_counterparty' then
    if v_m.status in ('scheduled'::public.match_status, 'live'::public.match_status) then
      update public.matches
         set status = 'awaiting_report'::public.match_status
       where id = p_match_id;
    end if;
  end if;

  return jsonb_build_object(
    'decision',            v_decision,
    'match_id',            p_match_id::text,
    'variance',            round(coalesce(v_variance, 0), 6),
    'reports_count',       v_total,
    'home_reports',        v_home_reports,
    'away_reports',        v_away_reports,
    'neutral_reports',     v_neutral,
    'distinct_scorelines', v_distinct,
    'agreed_home_score',   v_agreed_home,
    'agreed_away_score',   v_agreed_away,
    'accept_after',        v_accept_after,
    'consensus_deadline',  coalesce((v_round ->> 'consensus_deadline')::timestamptz, v_m.consensus_deadline),
    'consensus_nonce',     v_round ->> 'nonce',
    'rating_applied',      v_rated,
    'collusion',           case when v_privileged then v_collusion else null end
  );
end;
$fn$;

comment on function public.evaluate_score_consensus(uuid) is
  'Corroboration pass over every report on a match. Two agreeing reports from opposing sides finalise it; disagreement raises the variance, flags the rule engine and opens a consensus round with a 24h deadline; a single uncontested report is accepted by default 24h after it was filed.';

create or replace function public.trg_evaluate_score_consensus()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  perform public.evaluate_score_consensus(new.match_id);
  return null;
end;
$fn$;

drop trigger if exists trg_score_reports_evaluate on public.score_reports;
create trigger trg_score_reports_evaluate
  after insert on public.score_reports
  for each row execute function public.trg_evaluate_score_consensus();

-- -----------------------------------------------------------------------------
-- 9. Time-based sweeper (cron / edge function, service_role)
--
-- Two deadlines in this design only fire with the passage of time, so something
-- has to knock on them: the 24h uncontested acceptance and the 24h consensus
-- deadline. Run this every few minutes.
-- -----------------------------------------------------------------------------

create or replace function public.expire_consensus_rounds(p_limit integer default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_limit     integer := greatest(1, least(coalesce(p_limit, 200), 2000));
  v_id        uuid;
  v_accepted  integer := 0;
  v_finalized integer := 0;
  v_escalated integer := 0;
  v_verdict   jsonb;
  v_hours     numeric := private.integrity_setting('uncontested_accept_hours', 24);
begin
  perform private.assert_integrity_reader();

  -- 9.1 Uncontested reports past their rebuttal window.
  for v_id in
    select m.id
    from public.matches m
    where m.score_confirmed_at is null
      and m.status not in ('cancelled'::public.match_status, 'finalized'::public.match_status)
      and not m.requires_consensus
      and exists (
        select 1 from public.score_reports sr
        where sr.match_id = m.id
          and sr.reported_at <= now() - make_interval(mins => (v_hours * 60)::int)
      )
    order by m.kickoff_at asc
    limit v_limit
  loop
    v_verdict := public.evaluate_score_consensus(v_id);
    if v_verdict ->> 'decision' = 'accepted_by_default' then
      v_accepted := v_accepted + 1;
    end if;
  end loop;

  -- 9.2 Consensus rounds whose deadline has passed: one last quorum check, then
  -- escalate to a human.
  for v_id in
    select m.id
    from public.matches m
    where m.requires_consensus
      and m.consensus_deadline is not null
      and m.consensus_deadline < now()
      and m.score_confirmed_at is null
      -- Already escalated matches stay put: they belong to the admin queue
      -- (idx_matches_requires_consensus), not to the sweeper.
      and m.status not in ('cancelled'::public.match_status, 'disputed'::public.match_status)
    order by m.consensus_deadline asc
    limit v_limit
  loop
    v_verdict := public.finalize_consensus(v_id);

    if v_verdict ->> 'decision' = 'finalized' then
      v_finalized := v_finalized + 1;
    elsif v_verdict ->> 'decision' in ('pending', 'insufficient_electorate', 'no_scoreline') then
      update public.matches
         set status = 'disputed'::public.match_status
       where id = v_id
         and status <> 'disputed'::public.match_status;

      perform private.notify_admins(
        'match.disputed',
        'Consensus round expired',
        'Nobody reached quorum before the deadline. This match result needs a human decision.',
        jsonb_build_object('matchId', v_id::text, 'verdict', v_verdict)
      );

      insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
      values (null, 'match.consensus_expired', 'matches', v_id, v_verdict);

      v_escalated := v_escalated + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'accepted_by_default', v_accepted,
    'finalized',           v_finalized,
    'escalated',           v_escalated,
    'limit',               v_limit
  );
end;
$fn$;

comment on function public.expire_consensus_rounds(integer) is
  'Cron sweeper. Accepts uncontested reports once their 24h rebuttal window elapses and escalates consensus rounds that timed out without quorum to disputed. service_role only; run every few minutes.';

-- -----------------------------------------------------------------------------
-- 10. RLS policy for the one table this migration owns
--
-- Everything else that reads these signals goes through a SECURITY DEFINER RPC
-- or through service_role, which bypasses RLS entirely.
-- -----------------------------------------------------------------------------

drop policy if exists match_collusion_signals_admin_select on public.match_collusion_signals;
create policy match_collusion_signals_admin_select
  on public.match_collusion_signals
  for select
  to authenticated
  using ( (select private.is_integrity_admin()) );

-- -----------------------------------------------------------------------------
-- 11. Grants
--
-- Participant-facing RPCs -> authenticated. Ingestion / intelligence RPCs ->
-- service_role only. anon never gets EXECUTE on anything here. The role guards
-- keep the migration runnable on a plain Postgres without Supabase roles.
-- -----------------------------------------------------------------------------

do $grants$
declare
  -- Callable by signed-in end users. Each of these does its own authorisation.
  v_participant_fns text[] := array[
    'public.consensus_payload(uuid)',
    'public.open_consensus_round(uuid)',
    'public.submit_consensus_approval(uuid, text, bytea, text, text)',
    'public.finalize_consensus(uuid)',
    'public.evaluate_score_consensus(uuid)',
    'public.anomaly_score_threshold()'
  ];
  -- Machine-facing. These expose cross-match behavioural intelligence and the
  -- ability to force a match into consensus, so they stay server-side.
  v_service_fns text[] := array[
    'public.record_anomaly_verdict(uuid, text, numeric, boolean, jsonb, text, integer, numeric)',
    'public.matches_pending_anomaly_check(integer)',
    'public.anomaly_features(uuid)',
    'public.collusion_signals(uuid)',
    'public.expire_consensus_rounds(integer)'
  ];
  v_all_fns text[];
  v_fn text;
begin
  v_all_fns := v_participant_fns || v_service_fns;

  foreach v_fn in array v_all_fns loop
    execute format('revoke all on function %s from public', v_fn);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', v_fn);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach v_fn in array v_participant_fns loop
      execute format('grant execute on function %s to authenticated', v_fn);
    end loop;
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach v_fn in array v_all_fns loop
      execute format('grant execute on function %s to service_role', v_fn);
    end loop;
    execute 'grant select, insert, update, delete on public.match_collusion_signals to service_role';
  end if;

  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.match_collusion_signals to authenticated';
  end if;

  -- private.* helpers are reachable from stored policy/generated expressions by
  -- OID regardless of schema USAGE, but the RLS policy above is evaluated as the
  -- querying role, so EXECUTE must be explicit.
  execute 'revoke all on function private.is_integrity_admin() from public';
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function private.is_integrity_admin() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function private.is_integrity_admin() to service_role';
  end if;
end
$grants$;
