-- =============================================================================
-- Halisaha — 0007_cron_decay.sql
-- pg_cron scheduled housekeeping.
--
-- WHAT THIS FILE OWNS
--   * public.decay_inactive_ratings        — incremental TrueSkill sigma decay
--   * public.purge_expired_consent_requests— GDPR Art. 8 token hygiene
--   * public.purge_cron_run_details        — keep cron.job_run_details bounded
--   * public.cron_job_health               — one-row-per-job status view
--   * five cron jobs, guarded so re-running the migration never duplicates them
--     (one of them drives public.expire_consensus_rounds from 0005)
--
-- DEPENDS ON: 0001_schema.sql (all tables), 0004_trueskill.sql
--             (public.apply_match_rating, public.rating_config) and
--             0005_integrity_consensus.sql (public.expire_consensus_rounds).
--
-- No env vars are required by this migration.
--
-- pg_cron on Supabase
--   pg_cron needs to be in shared_preload_libraries, so on a hosted Supabase
--   project it must first be enabled from Dashboard -> Database -> Extensions
--   (or via the SQL editor by a superuser). It is not relocatable: the
--   extension always installs into a schema literally named "cron", and on
--   Supabase it can only be installed in the "postgres" database. Jobs created
--   with cron.schedule() run against the database named by the
--   cron.database_name GUC (the "postgres" database by default); use
--   cron.schedule_in_database() to target another one.
--
--   Everything below is written so that a database without pg_cron still
--   applies cleanly: the functions are always created, only the scheduling is
--   skipped (with a NOTICE). Call the functions from an external scheduler
--   (Vercel Cron, GitHub Actions, Supabase Edge Function) in that case.
-- =============================================================================

set search_path = public, extensions;

do $ext$
begin
  -- Dynamic SQL: a plain CREATE EXTENSION would be parsed by PL/pgSQL at
  -- compile time on some builds, and we want the failure to land in the
  -- EXCEPTION handler below rather than aborting the migration.
  execute 'create extension if not exists pg_cron';
  raise notice '0007_cron_decay: pg_cron is available.';
exception
  when others then
    raise notice '0007_cron_decay: pg_cron could not be created (%). Housekeeping functions are still installed; schedule them externally.', sqlerrm;
end
$ext$;


-- -----------------------------------------------------------------------------
-- 1. public.decay_inactive_ratings
-- -----------------------------------------------------------------------------
-- Why decay at all: TrueSkill's sigma is the model's uncertainty about a
-- player. A player who has not played for six months is genuinely less well
-- known than the day they stopped, so sigma should widen. mu is never touched,
-- because there is no evidence their skill changed, only that we are less sure
-- of it.
-- Widening sigma lowers the displayed conservative_rating (mu - 3*sigma) and
-- lets the next match move them faster, which is exactly the desired behaviour.
--
-- The growth is incremental. It is applied in variance space, proportional to
-- the days actually elapsed since the last decay:
--
--     sigma <- least(cap, sqrt(sigma^2 + days_elapsed * growth^2))
--
-- Variance is additive, so N applications of one day are identical to one
-- application of N days. That makes the job idempotent in outcome and
-- self-healing: a missed night, a week of downtime, or a double run within the
-- same day all converge to the same sigma. Nothing needs to be replayed.
--
-- The decay clock starts only after the inactivity grace period, so a player
-- who returns on day 29 is never penalised for the grace window.

create or replace function public.decay_inactive_ratings(
  p_inactive_days        integer          default 30,
  p_daily_sigma_growth   double precision default 0.03,
  p_sigma_cap            double precision default 8.3333333333,
  p_batch_size           integer          default 500,
  p_max_batches          integer          default 500,
  p_min_days             double precision default 0.5
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $decay_inactive_ratings$
declare
  v_now     timestamptz := now();
  v_grace   interval;
  v_cutoff  timestamptz;
  v_batch   integer;
  v_total   integer := 0;
  v_i       integer := 0;
begin
  if p_inactive_days is null or p_inactive_days < 0 then
    raise exception 'decay_inactive_ratings: p_inactive_days must be >= 0, got %', p_inactive_days
      using errcode = '22023';
  end if;
  if p_daily_sigma_growth is null or p_daily_sigma_growth < 0 then
    raise exception 'decay_inactive_ratings: p_daily_sigma_growth must be >= 0, got %', p_daily_sigma_growth
      using errcode = '22023';
  end if;
  if p_sigma_cap is null or p_sigma_cap <= 0 then
    raise exception 'decay_inactive_ratings: p_sigma_cap must be > 0, got %', p_sigma_cap
      using errcode = '22023';
  end if;
  if p_batch_size is null or p_batch_size < 1 then
    raise exception 'decay_inactive_ratings: p_batch_size must be >= 1, got %', p_batch_size
      using errcode = '22023';
  end if;

  v_grace  := make_interval(days => p_inactive_days);
  v_cutoff := v_now - v_grace;

  -- Batched so the job never holds a long lock on player_ratings. SKIP LOCKED
  -- means an overlapping run (or a concurrent trueskill2_update on one of these
  -- players) is stepped over rather than waited on; the skipped rows decay on
  -- the next pass, and because the growth is proportional to elapsed
  -- time they lose nothing by waiting.
  loop
    v_i := v_i + 1;

    with candidates as (
      select pr.player_id,
             greatest(
               coalesce(pr.last_decay_at, '-infinity'::timestamptz),
               coalesce(pr.last_match_at, pr.created_at) + v_grace
             ) as ref_at
        from public.player_ratings pr
       where pr.sigma < p_sigma_cap
         -- Sargable half of the predicate: lets the planner use
         -- idx_player_ratings_last_match_at instead of scanning everything.
         and (pr.last_match_at is null or pr.last_match_at < v_cutoff)
         and pr.created_at < v_cutoff
         and greatest(
               coalesce(pr.last_decay_at, '-infinity'::timestamptz),
               coalesce(pr.last_match_at, pr.created_at) + v_grace
             ) < v_now - make_interval(secs => p_min_days * 86400.0)
       -- Ascending player_id matches the lock order used by
       -- private.ensure_rating_row, so the two can never deadlock each other.
       order by pr.player_id
       limit p_batch_size
       for update skip locked
    )
    update public.player_ratings t
       set sigma = least(
             p_sigma_cap,
             sqrt(
               t.sigma * t.sigma
               + greatest(
                   (extract(epoch from (v_now - c.ref_at)) / 86400.0)::double precision,
                   0.0::double precision
                 ) * p_daily_sigma_growth * p_daily_sigma_growth
             )
           ),
           last_decay_at = v_now
      from candidates c
     where t.player_id = c.player_id;

    get diagnostics v_batch = row_count;
    v_total := v_total + v_batch;

    -- Each updated row gets last_decay_at = v_now, so it can no longer satisfy
    -- the predicate in this transaction: the candidate set strictly shrinks and
    -- the loop is guaranteed to terminate. p_max_batches is a belt-and-braces
    -- circuit breaker.
    exit when v_batch = 0 or v_i >= p_max_batches;
  end loop;

  if v_total > 0 then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      null,
      'ratings.decayed',
      'player_ratings',
      null,
      jsonb_build_object(
        'rows', v_total,
        'batches', v_i,
        'inactive_days', p_inactive_days,
        'daily_sigma_growth', p_daily_sigma_growth,
        'sigma_cap', p_sigma_cap
      )
    );
  end if;

  return v_total;
end;
$decay_inactive_ratings$;

comment on function public.decay_inactive_ratings(integer, double precision, double precision, integer, integer, double precision) is
$c$Widens sigma for inactive players and returns the number of rows touched.

sigma <- least(cap, sqrt(sigma^2 + days_elapsed * growth^2)); mu is never
touched. Growth accrues only after p_inactive_days of inactivity and is
proportional to the time since the last decay, so the job is self-healing: a
missed run, a week of downtime, or two runs in one day all converge to the same
sigma. Batched with FOR UPDATE SKIP LOCKED (ascending player_id, matching the
rating engine's lock order) so it never long-locks player_ratings.
SECURITY DEFINER; service_role only.$c$;


-- -----------------------------------------------------------------------------
-- 2. Stale consensus rounds — owned by 0005, not by this file
-- -----------------------------------------------------------------------------
-- This file used to define public.expire_stale_consensus(), a second and
-- contradictory implementation of consensus expiry. It has been removed because
-- 0005_integrity_consensus.sql already owns that policy and its rules are the
-- authoritative ones:
--
--   * it counts only votes carrying the round's consensus_nonce AND the current
--     payload_digest, so approvals of a superseded scoreline cannot be counted;
--   * it joins consensus_approvals to match_participants, so the electorate is
--     the line-up rather than "anyone who managed to insert a row" (the RLS
--     policy admits the whole club roster);
--   * its quorum is 2/3 of the electorate plus at least one approval from each
--     side — the anti-collusion half of the rule — rather than a bare majority;
--   * it resolves the scoreline from public.consensus_payload() and writes
--     home_score/away_score itself, rather than requiring a home_score that
--     nothing can have written yet;
--   * it leaves requires_consensus true on escalation, which is what keeps an
--     escalated match in idx_matches_requires_consensus, i.e. in the admin
--     queue.
--
-- The scheduled job in section 6 therefore drives public.expire_consensus_rounds()
-- from 0005 instead. That function also covers the second time-based deadline
-- this file never handled at all: the 24h uncontested-report acceptance.

drop function if exists public.expire_stale_consensus(integer);

-- -----------------------------------------------------------------------------
-- 3. public.purge_expired_consent_requests
-- -----------------------------------------------------------------------------
-- GDPR cuts both ways here. Art. 5(1)(e) storage limitation says an expired,
-- never-used consent token is dead data and must go. Art. 7(1) accountability
-- says a consent that was actually granted or revoked is evidence and must be
-- kept. So this only deletes rows still in 'pending' past their expiry; granted
-- and revoked rows are never touched by this job.

create or replace function public.purge_expired_consent_requests(
  p_retain_days integer default 7,
  p_batch_size  integer default 1000,
  p_max_batches integer default 200
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $purge_expired_consent_requests$
declare
  v_cutoff timestamptz;
  v_batch  integer;
  v_total  integer := 0;
  v_i      integer := 0;
begin
  if p_retain_days is null or p_retain_days < 0 then
    raise exception 'purge_expired_consent_requests: p_retain_days must be >= 0, got %', p_retain_days
      using errcode = '22023';
  end if;

  v_cutoff := now() - make_interval(days => p_retain_days);

  loop
    v_i := v_i + 1;

    delete from public.parental_consent_requests pcr
     where pcr.id in (
       select c.id
         from public.parental_consent_requests c
        where c.status = 'pending'
          and c.expires_at < v_cutoff
        order by c.expires_at
        limit p_batch_size
        for update skip locked
     );

    get diagnostics v_batch = row_count;
    v_total := v_total + v_batch;

    exit when v_batch = 0 or v_i >= p_max_batches;
  end loop;

  if v_total > 0 then
    -- Aggregate only. Never log the guardian address or the token hash here:
    -- audit_log is the one table that must stay free of fresh PII.
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      null,
      'consent.expired_requests_purged',
      'parental_consent_requests',
      null,
      jsonb_build_object('rows', v_total, 'retain_days', p_retain_days)
    );
  end if;

  return v_total;
end;
$purge_expired_consent_requests$;

comment on function public.purge_expired_consent_requests(integer, integer, integer) is
$c$Deletes parental_consent_requests that are still 'pending' and are past
expires_at plus p_retain_days, and returns the row count. Granted and revoked
rows are deliberately retained as GDPR Art. 7(1) consent evidence. Batched with
FOR UPDATE SKIP LOCKED. SECURITY DEFINER; service_role only.$c$;


-- -----------------------------------------------------------------------------
-- 4. public.purge_cron_run_details
-- -----------------------------------------------------------------------------
-- pg_cron appends to cron.job_run_details forever and never trims it. On a busy
-- project that table becomes the largest thing in the database. Dynamic SQL is
-- used so this function is creatable (and harmlessly callable) on a database
-- without pg_cron installed.

create or replace function public.purge_cron_run_details(
  p_retain_days integer default 14
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $purge_cron_run_details$
declare
  v_total integer := 0;
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron') then
    return 0;
  end if;

  execute format(
    'delete from cron.job_run_details where end_time < now() - make_interval(days => %s)',
    (greatest(p_retain_days, 0))::text
  );
  get diagnostics v_total = row_count;

  return v_total;
end;
$purge_cron_run_details$;

comment on function public.purge_cron_run_details(integer) is
  'Trims cron.job_run_details to the last p_retain_days of finished runs and returns the row count. A no-op when pg_cron is not installed. SECURITY DEFINER; service_role only.';


-- -----------------------------------------------------------------------------
-- 4a. public.refresh_aged_out_minors
-- -----------------------------------------------------------------------------
-- profiles.is_minor is `generated always as (private.is_minor_dob(date_of_birth))
-- stored`, and private.is_minor_dob is declared IMMUTABLE while its body reads
-- current_date. That is what lets it back a STORED column at all, but it means
-- the value is a snapshot taken at the last write to the row: a 15-year-old who
-- turns 16 stays is_minor = true, and parental_consent_status stays 'pending',
-- until something touches their row again. 0001 and 0003 both name a nightly
-- re-touch as the compensating control for this ("the parental-consent job
-- re-touches profiles whose date_of_birth crosses the threshold") — but no such
-- job was ever created, here or anywhere else. This function is that job.
--
-- The UPDATE names parental_consent_status in its SET list even though it
-- assigns the column to itself, and that is load-bearing. The BEFORE trigger
-- public.enforce_minor_privacy() is what actually rewrites 'pending' to
-- 'not_required' for an aged-out row, and the audit trigger that records the
-- transition is `after update OF parental_consent_status`, which PostgreSQL
-- fires only when that column appears in the statement's SET list. Touching
-- updated_at alone would age the account out silently and unaudited.
create or replace function public.refresh_aged_out_minors(
  p_batch_size integer default 1000
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $refresh_aged_out_minors$
declare
  v_total integer := 0;
begin
  update public.profiles p
     set updated_at              = now(),
         parental_consent_status = p.parental_consent_status
   where p.id in (
     select q.id
       from public.profiles q
      where q.is_minor
        and q.date_of_birth is not null
        and public.age_years(q.date_of_birth) >= 16
      order by q.date_of_birth
      limit greatest(coalesce(p_batch_size, 1000), 1)
   );

  get diagnostics v_total = row_count;
  return v_total;
end;
$refresh_aged_out_minors$;

comment on function public.refresh_aged_out_minors(integer) is
$c$Re-touches profiles whose stored is_minor snapshot has gone stale because the
subject turned 16, so the generated column recomputes and enforce_minor_privacy
clears the no-longer-required 'pending' consent. Returns the row count.
parental_consent_status is named in the SET list so the consent audit trigger
fires on the transition. SECURITY DEFINER; service_role only.$c$;


-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
do $grants$
begin
  revoke all on function public.decay_inactive_ratings(integer, double precision, double precision, integer, integer, double precision) from public;
  revoke all on function public.purge_expired_consent_requests(integer, integer, integer) from public;
  revoke all on function public.purge_cron_run_details(integer) from public;
  revoke all on function public.refresh_aged_out_minors(integer) from public;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.decay_inactive_ratings(integer, double precision, double precision, integer, integer, double precision) to service_role;
    grant execute on function public.purge_expired_consent_requests(integer, integer, integer) to service_role;
    grant execute on function public.purge_cron_run_details(integer) to service_role;
    grant execute on function public.refresh_aged_out_minors(integer) to service_role;
  end if;
end
$grants$;


-- -----------------------------------------------------------------------------
-- 6. Schedule the jobs (idempotent)
-- -----------------------------------------------------------------------------
-- All times are UTC: pg_cron evaluates schedules against the server clock, and
-- Supabase runs Postgres in UTC. Europe/Istanbul is UTC+3 year round (no DST),
-- so 03:15 UTC is 06:15 local — comfortably after the last evening kickoff.

do $cron$
declare
  r record;
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron') then
    raise notice '0007_cron_decay: schema "cron" not found, skipping job scheduling. Enable pg_cron and re-run this block, or drive the functions from an external scheduler.';
    return;
  end if;

  -- Unschedule guard. cron.unschedule(name) throws when the job is missing, so
  -- go through cron.job and use the jobid overload; re-running the migration is
  -- then always safe and never leaves duplicates behind.
  for r in
    select jobid
      from cron.job
     where jobname in (
       'nightly-rating-decay',
       'expire-consensus-rounds',
       -- Retired: the job that drove the removed public.expire_stale_consensus().
       -- Kept in this list so re-running the migration drops it rather than
       -- leaving a second sweeper racing on the same rows.
       'expire-stale-consensus',
       'purge-expired-consent-requests',
       'purge-cron-run-details',
       'refresh-aged-out-minors'
     )
  loop
    perform cron.unschedule(r.jobid);
  end loop;

  -- 03:15 UTC daily: widen sigma for everyone who has gone quiet.
  perform cron.schedule(
    'nightly-rating-decay',
    '15 3 * * *',
    $job$ select public.decay_inactive_ratings(); $job$
  );

  -- Every 10 minutes: 0005's sweeper. It knocks on the only two deadlines in
  -- the design that fire with the passage of time and nothing else -- the 24h
  -- uncontested-report acceptance and the 24h consensus deadline -- so without
  -- this job neither ever fires. Safe under cron: expire_consensus_rounds opens
  -- with private.assert_integrity_reader(), which returns immediately when
  -- auth.uid() is null.
  perform cron.schedule(
    'expire-consensus-rounds',
    '*/10 * * * *',
    $job$ select public.expire_consensus_rounds(200); $job$
  );

  -- 03:45 UTC daily: GDPR storage limitation on dead consent tokens.
  perform cron.schedule(
    'purge-expired-consent-requests',
    '45 3 * * *',
    $job$ select public.purge_expired_consent_requests(); $job$
  );

  -- 04:15 UTC daily: keep pg_cron's own history table bounded.
  perform cron.schedule(
    'purge-cron-run-details',
    '15 4 * * *',
    $job$ select public.purge_cron_run_details(); $job$
  );

  -- 03:30 UTC daily: re-touch profiles whose stored is_minor snapshot went
  -- stale overnight, so an aged-out account stops being treated as a minor.
  perform cron.schedule(
    'refresh-aged-out-minors',
    '30 3 * * *',
    $job$ select public.refresh_aged_out_minors(); $job$
  );

  raise notice '0007_cron_decay: scheduled 5 jobs (nightly-rating-decay, expire-consensus-rounds, refresh-aged-out-minors, purge-expired-consent-requests, purge-cron-run-details).';
end
$cron$;


-- -----------------------------------------------------------------------------
-- 7. Observability
-- -----------------------------------------------------------------------------
-- A view over cron.* can only be created when pg_cron exists, so it is built
-- with dynamic SQL inside the same kind of guard. It runs with the privileges
-- of its owner (the migration role), and is granted to service_role only —
-- never to anon or authenticated, because cron.job exposes the command text.

do $health$
begin
  if not exists (select 1 from pg_catalog.pg_namespace where nspname = 'cron') then
    raise notice '0007_cron_decay: skipping public.cron_job_health (pg_cron not installed).';
    return;
  end if;

  execute $ddl$
    create or replace view public.cron_job_health as
    select j.jobid,
           j.jobname,
           j.schedule,
           j.active,
           d.runid          as last_runid,
           d.status         as last_status,
           d.return_message as last_message,
           d.start_time     as last_start,
           d.end_time       as last_end,
           d.end_time - d.start_time as last_duration
      from cron.job j
      left join lateral (
        select d2.runid, d2.status, d2.return_message, d2.start_time, d2.end_time
          from cron.job_run_details d2
         where d2.jobid = j.jobid
         order by d2.start_time desc
         limit 1
      ) d on true
  $ddl$;

  execute 'comment on view public.cron_job_health is ''Most recent run of every pg_cron job. Admin/service_role only: cron.job exposes the raw command text.''';

  execute 'revoke all on public.cron_job_health from public';

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.cron_job_health from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.cron_job_health from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select on public.cron_job_health to service_role';
  end if;
end
$health$;


-- -----------------------------------------------------------------------------
-- 8. Operator cheat sheet
-- -----------------------------------------------------------------------------
-- Last run of every job:
--     select * from public.cron_job_health order by last_start desc nulls last;
--
-- Full run history, newest first (the canonical pg_cron inspection query):
--     select d.runid, j.jobname, d.status, d.return_message,
--            d.start_time, d.end_time, d.end_time - d.start_time as duration
--       from cron.job_run_details d
--       join cron.job j using (jobid)
--      order by d.start_time desc
--      limit 50;
--
-- Only failures in the last day:
--     select j.jobname, d.start_time, d.return_message
--       from cron.job_run_details d
--       join cron.job j using (jobid)
--      where d.status <> 'succeeded'
--        and d.start_time > now() - interval '1 day'
--      order by d.start_time desc;
--
-- Currently scheduled jobs:
--     select jobid, jobname, schedule, active, database, username, command
--       from cron.job order by jobname;
--
-- Pause / resume a job without dropping it:
--     update cron.job set active = false where jobname = 'nightly-rating-decay';
--
-- Run any of them by hand (safe: every one is idempotent / incremental):
--     select public.decay_inactive_ratings();
--     select public.expire_consensus_rounds(200);
--     select public.purge_expired_consent_requests();
--     select public.purge_cron_run_details();
--     select public.refresh_aged_out_minors();
--
-- Dry-run the decay maths for a single player before changing the constants:
--     select player_id, sigma,
--            least(8.3333333333,
--                  sqrt(sigma*sigma
--                       + (extract(epoch from (now() - coalesce(last_decay_at, last_match_at)))/86400.0)::double precision
--                         * 0.03 * 0.03)) as sigma_after
--       from public.player_ratings
--      where last_match_at < now() - interval '30 days';
-- =============================================================================
