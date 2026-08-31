-- =============================================================================
-- Halisaha — 0006_realtime.sql
-- Secure Realtime / WAL configuration.
--
-- Depends on: 0001_schema.sql (tables), 0002_rls.sql (the SELECT policies that
-- authorise Postgres Changes), 0003_auth_rbac_gdpr.sql (the JWT `user_role`
-- claim used by private.is_admin()).
--
-- Two transports, deliberately used for different jobs:
--
--   * Postgres Changes — sourced from the WAL via a logical replication slot.
--     Every changed row is re-checked against the subscribing user's SELECT
--     policy before it is delivered. Authoritative, but the authorisation cost
--     is O(subscribers x changed rows) and it runs inside the Realtime server's
--     database connection. Used for state that has to be correct and is
--     comparatively low frequency: matches, bookings, match_participants,
--     notifications.
--
--   * Broadcast — a pub/sub topic. Sending does not read the database and
--     receiving does not re-check a row policy; authorisation happens once, at
--     channel-join time, against realtime.messages RLS. Used for the
--     high-frequency path (live score ticks, presence).
--
-- The client subscribes to both and reconciles: broadcast is fast, Postgres
-- Changes is the source of truth. See lib/realtime/channels.ts.
--
-- Idempotent: safe to re-run.
-- =============================================================================

set search_path = public, extensions;


-- =============================================================================
-- 1. POSTGRES CHANGES — the supabase_realtime publication
-- =============================================================================
-- Only four tables are published. A publication is a WAL filter, not a
-- subscription: every table in it makes the walsender decode and emit rows for
-- every write, whether or not anyone is listening. Publishing tables nobody
-- subscribes to (player_stats, audit_log, stripe_events...) is pure WAL and CPU
-- burn on the replication slot, so the list stays minimal and explicit.
--
--   matches             live score / status for the match screen
--   match_participants  roster changes ("X joined")
--   bookings            venue dashboard + "your booking was confirmed"
--   notifications       the in-app bell
--
-- Guarded so a re-run, or a database where Supabase already created the
-- publication (hosted projects ship it empty), is a no-op.

do $publication$
declare
  v_table      text;
  v_tables     text[] := array[
    'matches',
    'match_participants',
    'bookings',
    'notifications'
  ];
  v_all_tables boolean;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- An explicit operation list keeps TRUNCATE out of the stream from the start.
    execute 'create publication supabase_realtime with (publish = ''insert,update,delete'')';
    raise notice '0006_realtime: created publication supabase_realtime';
  end if;

  select p.puballtables into v_all_tables
  from pg_publication p
  where p.pubname = 'supabase_realtime';

  if v_all_tables then
    -- FOR ALL TABLES publishes everything; ALTER ... ADD TABLE would error and
    -- the minimal-surface intent is already lost. Flag it loudly instead.
    raise warning '0006_realtime: supabase_realtime is FOR ALL TABLES — every write in public is decoded into the WAL stream. Recreate it with an explicit table list.';
  else
    foreach v_table in array v_tables loop
      if not exists (
        select 1
        from pg_publication_tables pt
        where pt.pubname    = 'supabase_realtime'
          and pt.schemaname = 'public'
          and pt.tablename  = v_table
      ) then
        execute format(
          'alter publication supabase_realtime add table public.%I',
          v_table
        );
        raise notice '0006_realtime: added public.% to supabase_realtime', v_table;
      end if;
    end loop;
  end if;
end
$publication$;


-- -----------------------------------------------------------------------------
-- 1b. Operation filter
-- -----------------------------------------------------------------------------
-- Restrict the stream to row DML. TRUNCATE is in the Postgres default and is
-- useless to a client (it carries no rows and cannot be RLS-filtered); dropping
-- it also means a maintenance TRUNCATE can never fan out to every connected
-- socket. This is a publication-level property, so it applies to all four
-- tables at once.
do $pubops$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime set (publish = ''insert,update,delete'')';
  end if;
exception
  when insufficient_privilege then
    raise warning '0006_realtime: not the owner of publication supabase_realtime; skipped SET (publish = ...). Re-run as the publication owner.';
end
$pubops$;


-- =============================================================================
-- 2. REPLICA IDENTITY
-- =============================================================================
-- REPLICA IDENTITY controls what the WAL records as the OLD tuple on UPDATE and
-- DELETE.
--
--   DEFAULT (primary key)  -> OLD contains the primary key columns only.
--   FULL                   -> OLD contains every column of the pre-image.
--
-- public.matches gets FULL for two reasons, both load-bearing:
--
--   (a) RLS. Realtime authorises a change event by running the subscriber's
--       SELECT policy against the record. For an UPDATE it must be able to
--       evaluate that policy against the OLD record as well — otherwise a row
--       the user was allowed to see, updated so that they may no longer see it,
--       cannot be reasoned about. With DEFAULT identity the OLD record is just
--       the id, so any policy that reads another column (home_team_id,
--       venue_id, status) cannot be evaluated against it.
--
--   (b) UPDATE payload completeness. With DEFAULT identity the payload's
--       `old_record` is `{ id }` and unchanged columns are absent from the
--       diff, so a client cannot render a whole match card without a follow-up
--       SELECT per event. finalize_consensus() and apply_match_rating() each
--       touch only a couple of columns, which is exactly the case FULL fixes.
--
-- The cost is real: FULL writes the entire pre-image of the row into the WAL on
-- every UPDATE and DELETE. On a hot table that multiplies WAL volume, slows the
-- walsender, and inflates the replication slot's retained-WAL footprint if a
-- subscriber lags. matches is low-write (a handful of updates per fixture) so
-- it can pay it. bookings, match_participants and notifications are high-write
-- and/or insert-mostly, so they keep DEFAULT identity — their clients only ever
-- need the NEW record, and their policies key off columns present in it.
alter table public.matches             replica identity full;

-- Stated explicitly so a re-run is deterministic even if someone flipped one of
-- these to FULL by hand in the dashboard.
alter table public.bookings            replica identity default;
alter table public.match_participants  replica identity default;
alter table public.notifications       replica identity default;


-- =============================================================================
-- 3. RLS AND POSTGRES CHANGES — where authorisation actually happens
-- =============================================================================
-- There is NO separate "realtime permission" for Postgres Changes. When a
-- client subscribes to `postgres_changes` on public.matches, the Realtime
-- server:
--
--   1. reads the change from the replication slot,
--   2. opens a transaction as the `authenticated` role with the subscriber's
--      JWT claims installed in `request.jwt.claims`,
--   3. runs the SELECT policies of public.matches against the record,
--   4. delivers the event only if a permissive policy returns true.
--
-- Consequences that this migration cannot fix and 0002_rls.sql must get right:
--
--   * The matches SELECT policy from 0002 is the live-feed ACL. Widen it and
--     you widen the realtime stream, for every already-connected socket, with
--     no separate review. Narrow it and live scores stop arriving. Any change
--     to that policy is a change to what the world can watch.
--
--   * That policy is executed once per subscriber per changed row. The
--     wrapped-subquery rule — (select auth.uid()), (select private.f(...)) —
--     decides between one InitPlan and one function call per row per socket.
--
--   * DELETE events are not RLS-filtered by Realtime (there is no new record to
--     test, and under DEFAULT identity the old record is only a primary key).
--     Treat any published DELETE as public. This is why the domain model
--     soft-transitions instead of deleting: bookings move to status
--     'cancelled', matches to 'cancelled'. Never introduce a hard DELETE on a
--     published table that would leak an id a user must not learn.
--
--   * The JWT on the socket is checked at join time and on each
--     `realtime.setAuth()` call, not continuously. An expired token makes the
--     socket go silent rather than error, so the client must re-call setAuth()
--     on every token refresh — see docs/RUNBOOK.md.
--
-- Every column those policies touch is already indexed by 0001 (idx_matches_*,
-- idx_bookings_*, idx_match_participants_*, idx_notifications_user_id), so this
-- migration adds no indexes.


-- =============================================================================
-- 4. BROADCAST — topic authorisation helpers
-- =============================================================================
-- Topic convention (mirrored verbatim in lib/realtime/channels.ts):
--
--   match:<match_id>            public live score. Readable by anyone who could
--                               SELECT the match; writable by participants, the
--                               venue owner and admins.
--   match:<match_id>:private    confirmed participants (+ admins) only. Carries
--                               consensus prompts and dispute traffic.
--   venue:<venue_id>            the owning venue owner (+ admins). Occupancy and
--                               booking ticks for the dashboard.
--
-- "public" above means "a wide audience", not "unauthenticated". All three are
-- Realtime PRIVATE channels — the client must join with
-- `{ config: { private: true } }` — because that is what makes Realtime consult
-- realtime.messages RLS at all. A channel joined without private:true performs
-- no authorisation whatsoever, so joining without private:true is how a
-- Supabase broadcast feed gets leaked.
--
-- Topic strings arrive from the client and are attacker-controlled. Every
-- helper below is total: given garbage it returns NULL/false, never an error.
-- A cast such as `split_part(topic, ':', 2)::uuid` on a malformed topic raises
-- 22P02 inside the policy, which surfaces as a failed channel join and, worse,
-- as a distinguishable error the caller can probe. Extraction is therefore done
-- with `substring(... from <anchored regex>)`, which returns NULL when there is
-- no match; NULL then makes every downstream EXISTS false, so a malformed topic
-- fails closed without raising.

-- Extract the match id from `match:<uuid>` or `match:<uuid>:private`.
create or replace function private.realtime_match_topic_id(p_topic text)
returns uuid
language sql
immutable
parallel safe
returns null on null input
set search_path = ''
as $$
  select substring(
    p_topic
    from '^match:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?::private)?$'
  )::uuid
$$;

comment on function private.realtime_match_topic_id(text) is
  'Parses the match uuid out of a realtime topic. Returns NULL for any malformed topic (fails closed, never raises).';

-- True only for the participants-only variant.
create or replace function private.realtime_is_private_match_topic(p_topic text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    p_topic ~ '^match:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:private$',
    false
  )
$$;

comment on function private.realtime_is_private_match_topic(text) is
  'True when the topic is the participants-only match channel. False for NULL or malformed input.';

-- Extract the venue id from `venue:<uuid>`.
create or replace function private.realtime_venue_topic_id(p_topic text)
returns uuid
language sql
immutable
parallel safe
returns null on null input
set search_path = ''
as $$
  select substring(
    p_topic
    from '^venue:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
  )::uuid
$$;

comment on function private.realtime_venue_topic_id(text) is
  'Parses the venue uuid out of a realtime topic. Returns NULL for any malformed topic (fails closed, never raises).';


-- -----------------------------------------------------------------------------
-- 4b. Authorisation predicates
-- -----------------------------------------------------------------------------
-- private.is_match_participant / private.owns_venue / private.is_admin are
-- shared with 0002_rls.sql. They are created here only if absent, so that when
-- 0002 already defined them its definitions stay authoritative and this
-- migration cannot silently redefine the semantics its policies depend on.
-- A plain `create or replace` would have overwritten them, since 0006 runs last.
--
-- Note on membership: is_match_participant tests for the existence of a
-- match_participants row, not for is_confirmed = true. That is deliberate for
-- the private topic: the consensus prompt ("was the score 3-2?") is broadcast
-- on match:<id>:private, and an unconfirmed player is precisely the person who
-- has to receive it — gating the channel on is_confirmed would hide the message
-- from everyone who still has to act on it. Confirmation gates the result
-- (finalize_consensus counts only confirmed participants for its quorum), not
-- the socket.

do $helpers$
begin
  if to_regprocedure('private.is_match_participant(uuid)') is null then
    execute $ddl$
      create function private.is_match_participant(p_match_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select exists (
          select 1
          from public.match_participants mp
          where mp.match_id  = p_match_id
            and mp.player_id = (select auth.uid())
        )
      $body$;
    $ddl$;
    raise notice '0006_realtime: created private.is_match_participant(uuid)';
  end if;

  if to_regprocedure('private.owns_venue(uuid)') is null then
    execute $ddl$
      create function private.owns_venue(p_venue_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        select exists (
          select 1
          from public.venues v
          where v.id       = p_venue_id
            and v.owner_id = (select auth.uid())
        )
      $body$;
    $ddl$;
    raise notice '0006_realtime: created private.owns_venue(uuid)';
  end if;

  if to_regprocedure('private.is_admin()') is null then
    execute $ddl$
      create function private.is_admin()
      returns boolean
      language sql
      stable
      security definer
      set search_path = ''
      as $body$
        -- JWT claim first (reads no rows); profiles is the fallback for sessions
        -- minted before the custom_access_token hook was enabled.
        select coalesce(
                 ((select auth.jwt()) ->> 'user_role') = 'admin',
                 false
               )
            or exists (
                 select 1
                 from public.profiles p
                 where p.id   = (select auth.uid())
                   and p.role = 'admin'
               )
      $body$;
    $ddl$;
    raise notice '0006_realtime: created private.is_admin()';
  end if;
end
$helpers$;

-- Delegates "may this user read this match?" to the SELECT policy on
-- public.matches. It is SECURITY INVOKER so that RLS on public.matches is
-- evaluated for the caller, which makes the broadcast topic ACL and the
-- Postgres Changes ACL the same rule by construction; they cannot drift apart.
-- A non-existent or unreadable match yields false.
create or replace function private.realtime_can_read_match(p_match_id uuid)
returns boolean
language sql
stable
security invoker
returns null on null input
set search_path = ''
as $$
  select exists (
    select 1
    from public.matches m
    where m.id = p_match_id
  )
$$;

comment on function private.realtime_can_read_match(uuid) is
  'SECURITY INVOKER on purpose: reuses the matches SELECT policy from 0002 as the broadcast topic ACL so the two cannot diverge.';

-- "Does the caller own the venue this match is played at?" — used by the write
-- policy so the venue owner running the scoreboard can emit ticks. SECURITY
-- DEFINER deliberately: the write path must not inherit whatever the matches
-- SELECT policy happens to say about venue owners, or a policy change in 0002
-- would silently mute the scoreboard.
create or replace function private.realtime_owns_match_venue(p_match_id uuid)
returns boolean
language sql
stable
security definer
returns null on null input
set search_path = ''
as $$
  select exists (
    select 1
    from public.matches m
    join public.venues v on v.id = m.venue_id
    where m.id       = p_match_id
      and v.owner_id = (select auth.uid())
  )
$$;

comment on function private.realtime_owns_match_venue(uuid) is
  'True when the current user owns the venue of the given match. Bypasses RLS so the scoreboard write path does not depend on the matches SELECT policy.';

-- The `private` schema has no USAGE grant for authenticated (0001), and it stays
-- that way: nobody may call these by name from SQL. RLS policy expressions are
-- stored already parsed, so name resolution — which is what schema USAGE gates —
-- happened at CREATE POLICY time; only EXECUTE is re-checked at run time, by
-- OID. Granting EXECUTE alone therefore makes the policies work without opening
-- the schema up. Function EXECUTE also defaults to PUBLIC, so revoke first.
do $grants$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'private.realtime_match_topic_id(text)',
    'private.realtime_is_private_match_topic(text)',
    'private.realtime_venue_topic_id(text)',
    'private.realtime_can_read_match(uuid)',
    'private.realtime_owns_match_venue(uuid)',
    'private.is_match_participant(uuid)',
    'private.owns_venue(uuid)',
    'private.is_admin()'
  ] loop
    if to_regprocedure(v_fn) is not null then
      execute format('revoke all on function %s from public', v_fn);
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('grant execute on function %s to authenticated', v_fn);
      end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute format('grant execute on function %s to service_role', v_fn);
      end if;
    end if;
  end loop;
end
$grants$;


-- =============================================================================
-- 5. BROADCAST — realtime.messages policies
-- =============================================================================
-- realtime.messages is the authorisation surface for private channels. On join,
-- Realtime sets the `realtime.topic` GUC (read back by realtime.topic()) and
-- runs a SELECT against realtime.messages to decide READ, and a dry-run INSERT
-- to decide WRITE. Its rows are ephemeral and partitioned away, so treat it as
-- an RLS-shaped ACL rather than as a message store to query.
--
-- No UPDATE or DELETE policies exist: RLS with zero policies denies, and there
-- is no legitimate reason for a client to mutate a delivered message. `anon`
-- gets nothing at all.
--
-- Wrapped in a guard because the realtime schema only exists on a Supabase
-- stack; a bare Postgres used for a CI schema check must not fail the migration.

do $rtpolicies$
begin
  if to_regclass('realtime.messages') is null
     or to_regprocedure('realtime.topic()') is null then
    raise notice '0006_realtime: realtime.messages / realtime.topic() not present — skipping broadcast policies (non-Supabase target?).';
    return;
  end if;

  -- ---- READ: match:<id> — the wide live-score topic -------------------------
  execute $p$drop policy if exists "rt_match_public_read" on realtime.messages$p$;
  execute $p$
    create policy "rt_match_public_read"
    on realtime.messages
    for select
    to authenticated
    using (
      extension in ('broadcast', 'presence')
      and not (select private.realtime_is_private_match_topic((select realtime.topic())))
      and (select private.realtime_can_read_match(
             (select private.realtime_match_topic_id((select realtime.topic())))
           ))
    )
  $p$;

  -- ---- READ: match:<id>:private — participants + admins ---------------------
  execute $p$drop policy if exists "rt_match_private_read" on realtime.messages$p$;
  execute $p$
    create policy "rt_match_private_read"
    on realtime.messages
    for select
    to authenticated
    using (
      extension in ('broadcast', 'presence')
      and (select private.realtime_is_private_match_topic((select realtime.topic())))
      and (
        (select private.is_match_participant(
           (select private.realtime_match_topic_id((select realtime.topic())))
         ))
        or (select private.is_admin())
      )
    )
  $p$;

  -- ---- READ: venue:<id> — the owner dashboard -------------------------------
  execute $p$drop policy if exists "rt_venue_read" on realtime.messages$p$;
  execute $p$
    create policy "rt_venue_read"
    on realtime.messages
    for select
    to authenticated
    using (
      extension in ('broadcast', 'presence')
      and (
        (select private.owns_venue(
           (select private.realtime_venue_topic_id((select realtime.topic())))
         ))
        or (select private.is_admin())
      )
    )
  $p$;

  -- ---- WRITE: match:<id> ----------------------------------------------------
  -- Read is wide, write is narrow. A spectator who may watch the score must not
  -- be able to push one: only people on the pitch, the venue owner running the
  -- scoreboard, and admins may emit onto the wide match topic.
  execute $p$drop policy if exists "rt_match_public_write" on realtime.messages$p$;
  execute $p$
    create policy "rt_match_public_write"
    on realtime.messages
    for insert
    to authenticated
    with check (
      extension in ('broadcast', 'presence')
      and not (select private.realtime_is_private_match_topic((select realtime.topic())))
      and (select private.realtime_match_topic_id((select realtime.topic()))) is not null
      and (
        (select private.is_match_participant(
           (select private.realtime_match_topic_id((select realtime.topic())))
         ))
        or (select private.is_admin())
        or (select private.realtime_owns_match_venue(
              (select private.realtime_match_topic_id((select realtime.topic())))
            ))
      )
    )
  $p$;

  -- ---- WRITE: match:<id>:private --------------------------------------------
  execute $p$drop policy if exists "rt_match_private_write" on realtime.messages$p$;
  execute $p$
    create policy "rt_match_private_write"
    on realtime.messages
    for insert
    to authenticated
    with check (
      extension in ('broadcast', 'presence')
      and (select private.realtime_is_private_match_topic((select realtime.topic())))
      and (
        (select private.is_match_participant(
           (select private.realtime_match_topic_id((select realtime.topic())))
         ))
        or (select private.is_admin())
      )
    )
  $p$;

  -- ---- WRITE: venue:<id> ----------------------------------------------------
  execute $p$drop policy if exists "rt_venue_write" on realtime.messages$p$;
  execute $p$
    create policy "rt_venue_write"
    on realtime.messages
    for insert
    to authenticated
    with check (
      extension in ('broadcast', 'presence')
      and (
        (select private.owns_venue(
           (select private.realtime_venue_topic_id((select realtime.topic())))
         ))
        or (select private.is_admin())
      )
    )
  $p$;

  -- RLS is already enabled on realtime.messages by Supabase; assert rather than
  -- assume, because policies on a table without RLS are inert.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'realtime.messages'::regclass) then
    execute 'alter table realtime.messages enable row level security';
  end if;

  raise notice '0006_realtime: installed 6 realtime.messages policies';

exception
  when insufficient_privilege then
    raise warning '0006_realtime: insufficient privilege on realtime.messages — broadcast policies NOT installed. Re-run as the owner of realtime.messages (postgres / supabase_admin) or apply them from the SQL editor.';
end
$rtpolicies$;


-- =============================================================================
-- 6. BROADCAST — server-side score fan-out
-- =============================================================================
-- Scores are written by SECURITY DEFINER functions (finalize_consensus,
-- apply_match_rating) and by webhook handlers, not by the browser. Those writes
-- would otherwise only reach clients through Postgres Changes — one RLS
-- evaluation per subscriber per row. This trigger turns them into a single
-- broadcast as well, so a match with 200 spectators costs one message rather
-- than 200 policy evaluations.
--
-- realtime.send() is used rather than realtime.broadcast_changes(): the latter
-- ships the whole NEW/OLD record, which on the wide `match:<id>` topic would
-- publish anomaly_score, match_quality, predicted_draw_probability and every
-- other internal column to anyone watching the game. The payload below is
-- explicit and minimal; the integrity fields go only to the participants topic.
--
-- SECURITY DEFINER because realtime.send() inserts into realtime.messages, and
-- the writing role (a webhook's service_role, or an ordinary authenticated user
-- calling a definer function) must not need direct rights there.

create or replace function public.broadcast_match_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_changed         text[]  := '{}';
  v_score_changed   boolean := (new.home_score is distinct from old.home_score)
                            or (new.away_score is distinct from old.away_score);
  v_status_changed  boolean := (new.status is distinct from old.status);
  v_event           text;
  v_public_payload  jsonb;
  v_private_payload jsonb;
begin
  if v_score_changed then
    v_changed := v_changed || array['home_score', 'away_score'];
  end if;
  if v_status_changed then
    v_changed := v_changed || array['status'];
  end if;

  -- Score wins the event name when both changed: it is what the scoreboard
  -- animates on. `changed` carries the full list either way.
  v_event := case when v_score_changed then 'score' else 'status' end;

  v_public_payload := jsonb_build_object(
    'match_id',     new.id,
    'event',        v_event,
    'changed',      to_jsonb(v_changed),
    'status',       new.status,
    'home_team_id', new.home_team_id,
    'away_team_id', new.away_team_id,
    'home_score',   new.home_score,
    'away_score',   new.away_score,
    'kickoff_at',   new.kickoff_at,
    'updated_at',   new.updated_at,
    'previous', jsonb_build_object(
      'status',     old.status,
      'home_score', old.home_score,
      'away_score', old.away_score
    )
  );

  -- Participants also get the result-integrity state, which drives the
  -- "confirm the score" prompt; it never goes on the wide topic.
  v_private_payload := v_public_payload || jsonb_build_object(
    'requires_consensus', new.requires_consensus,
    'consensus_deadline', new.consensus_deadline,
    'score_confirmed_at', new.score_confirmed_at,
    'is_ranked',          new.is_ranked,
    'rating_applied_at',  new.rating_applied_at
  );

  begin
    -- realtime.send(payload, event, topic, private)
    -- private => true: these are private channels, authorised by the
    -- realtime.messages policies in section 5.
    perform realtime.send(
      v_public_payload,
      v_event,
      'match:' || new.id::text,
      true
    );

    perform realtime.send(
      v_private_payload,
      v_event,
      'match:' || new.id::text || ':private',
      true
    );
  exception
    when others then
      -- Fan-out is best effort. A broadcast failure — a missing realtime schema
      -- on a bare Postgres, a full messages partition — must never roll back a
      -- finalised score. Postgres Changes is the authoritative transport and
      -- still delivers the row.
      raise warning 'broadcast_match_event: realtime fan-out failed for match % (%): %',
        new.id, sqlstate, sqlerrm;
  end;

  return null;  -- AFTER trigger; the return value is ignored.
end
$fn$;

comment on function public.broadcast_match_event() is
  'AFTER UPDATE ON matches: pushes score/status changes onto match:<id> (minimal payload) and match:<id>:private (adds consensus state). Best effort — never fails the write.';

revoke all on function public.broadcast_match_event() from public;

-- The WHEN clause is the filter, not an IF inside the body: a match row updated
-- only for anomaly_checked_at or match_quality must not wake 200 sockets, and a
-- WHEN clause is evaluated before the function is even entered.
drop trigger if exists trg_matches_broadcast_event on public.matches;
create trigger trg_matches_broadcast_event
  after update on public.matches
  for each row
  when (
    old.home_score is distinct from new.home_score
    or old.away_score is distinct from new.away_score
    or old.status    is distinct from new.status
  )
  execute function public.broadcast_match_event();


-- =============================================================================
-- 7. PRESENCE — "who is at the pitch"
-- =============================================================================
-- Presence is ephemeral state held in the Realtime server's CRDT and replicated
-- between Realtime nodes. It never touches the WAL, never touches a table, and
-- is gone when the last member of a channel leaves. Nothing here is durable —
-- attendance that matters is match_participants.is_confirmed, written normally.
--
-- Convention:
--
--   Channel   the same channel as the score feed: `match:<match_id>`. Reusing it
--             means one socket and one authorisation, and presence inherits the
--             topic ACL above automatically (Realtime checks the
--             realtime.messages SELECT policy for extension = 'presence' when
--             reading state, and the INSERT policy on track()). A separate
--             `presence:<id>` topic would need its own policies and could drift.
--
--   Key       the presence key MUST be the profile id (auth.uid()), never a
--             random per-connection id:
--
--               supabase.channel(`match:${matchId}`, {
--                 config: { private: true, presence: { key: user.id } }
--               })
--
--             The key is the deduplication unit. Keyed by user, a player who
--             reconnects on 4G after the wifi drops replaces their own entry
--             instead of appearing twice, and a headcount is
--             Object.keys(presenceState).length. Keyed by connection, the count
--             inflates on every reconnect and never converges.
--
--   Payload   track({ profile_id, display_name, team_side, checked_in_at }).
--             Keep it small — the full state is re-sent to every member on every
--             join and leave, so payload size costs roughly members squared over
--             a session. Do not put coordinates in it: profiles carries
--             location_sharing_enabled, and minors are hard-locked to false by
--             the profiles_minor_privacy_locked_check CHECK in 0001. Presence is
--             not an exemption from that.
--
--   Trust     presence payloads are client-authored. `team_side` in a presence
--             entry is a hint for the roster UI, never an input to scoring or
--             rating. The only fact the server may derive from presence is
--             "someone holding this profile id has a live socket on this match",
--             and even that is only as trustworthy as the topic ACL.


-- =============================================================================
-- 8. CONNECTION POOLING — which string goes where
-- =============================================================================
-- Three connection paths, three endpoints. Using the wrong one is how a
-- serverless deploy exhausts max_connections under load.
--
-- -----------------------------------------------------------------------------
-- (a) Supavisor TRANSACTION mode — port 6543 — for Next.js route handlers
-- -----------------------------------------------------------------------------
--   postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
--
--   Every serverless invocation is short-lived and there can be hundreds
--   concurrently. Transaction mode leases a backend only for the duration of a
--   transaction and returns it immediately, so N functions multiplex onto a
--   small pool.
--
--   `?pgbouncer=true` disables prepared statements, and it is required.
--   Transaction pooling gives consecutive statements different backends, so a
--   PREPARE issued on one connection is invisible to the EXECUTE that lands on
--   another, producing intermittent `prepared statement "s0" already exists` /
--   `does not exist` errors under concurrency. Any client with a statement cache
--   must turn it off (Prisma: `?pgbouncer=true`; postgres.js: `prepare: false`;
--   node-postgres: no named statements).
--
--   Also unavailable in this mode, by design: session-scoped state — SET (use
--   SET LOCAL), LISTEN/NOTIFY, advisory locks held across statements, WITH HOLD
--   cursors, temp tables. Never point a migration runner here.
--
-- -----------------------------------------------------------------------------
-- (b) Supavisor SESSION mode — port 5432 — for migrations, pg_cron, the sidecar
-- -----------------------------------------------------------------------------
--   postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-0-<REGION>.pooler.supabase.com:5432/postgres
--
--   One client holds one backend for the life of the connection. Required by
--   anything that needs session state or runs long: `supabase db push`, the 0007
--   pg_cron decay job, the FastAPI/scikit-learn sidecar's long-lived pool.
--   Session mode assumes a small, bounded, known number of clients, which a
--   serverless function is not.
--
-- -----------------------------------------------------------------------------
-- (c) DIRECT — port 5432 on the database host — for the Realtime WAL slot
-- -----------------------------------------------------------------------------
--   postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres
--
--   Logical replication cannot be pooled: the replication protocol is a
--   long-lived, stateful, non-transactional stream bound to a slot, and no
--   pooler can multiplex it. Realtime connects directly, as does any pg_dump or
--   debug session that needs a real backend. On IPv4-only networks this host
--   needs the IPv4 add-on, or a Supavisor session-mode string as a fallback for
--   the non-replication uses — but never for the slot itself.
--
--   Watch the slot: a Realtime consumer that lags pins WAL on disk, and with
--   matches at REPLICA IDENTITY FULL the pre-images make it grow faster.
--   pg_replication_slots.active = false together with a growing
--   pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) is the alert.
--
-- Env vars consumed by the app (declared in .env.example by the scaffold agent):
--   DATABASE_URL   -> (a) transaction pooler, 6543, used by route handlers
--   DIRECT_URL     -> (b) session pooler, 5432, used by migrations / pg_cron
--   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY -> the Realtime
--                     websocket; the browser never sees a database URI.


-- =============================================================================
-- 9. VERIFICATION
-- =============================================================================
-- Run these after applying. Expected results are stated inline.
--
-- 9.1 What is actually published — expect exactly 4 rows: bookings,
--     match_participants, matches, notifications — and with which operations.
--
--   select pt.schemaname, pt.tablename
--   from pg_publication_tables pt
--   where pt.pubname = 'supabase_realtime'
--   order by pt.schemaname, pt.tablename;
--
--   select pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
--   from pg_publication
--   where pubname = 'supabase_realtime';
--   -- expect: puballtables=f, pubinsert=t, pubupdate=t, pubdelete=t, pubtruncate=f
--
-- 9.2 Replica identity — expect matches='f' (FULL) and every other table 'd'
--     (DEFAULT). Any unexpected 'f' is unaccounted WAL volume.
--
--   select c.relname,
--          c.relreplident,
--          case c.relreplident
--            when 'd' then 'default (primary key)'
--            when 'f' then 'full (every column)'
--            when 'n' then 'nothing'
--            when 'i' then 'index'
--          end as meaning
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public'
--     and c.relkind = 'r'
--     and c.relreplident <> 'd'
--   order by c.relname;
--   -- expect exactly one row: matches | f | full (every column)
--
-- 9.3 The broadcast ACL — expect 6 policies, all TO {authenticated}: 3 SELECT
--     (rt_match_public_read, rt_match_private_read, rt_venue_read) and 3 INSERT
--     (rt_match_public_write, rt_match_private_write, rt_venue_write). A policy
--     whose roles are {public} or include anon is a leak.
--
--   select policyname, cmd, roles, permissive
--   from pg_policies
--   where schemaname = 'realtime' and tablename = 'messages'
--   order by cmd, policyname;
--
--   select relrowsecurity
--   from pg_class
--   where oid = 'realtime.messages'::regclass;   -- expect: t
--
-- 9.4 The fan-out trigger exists and is filtered.
--
--   select tgname, pg_get_triggerdef(oid)
--   from pg_trigger
--   where tgrelid = 'public.matches'::regclass and not tgisinternal;
--   -- expect trg_matches_broadcast_event ... WHEN (... home_score ... status ...)
--
-- 9.5 Topic parsing fails closed rather than raising — all four expect NULL/false.
--
--   select private.realtime_match_topic_id('match:not-a-uuid')          as should_be_null,
--          private.realtime_match_topic_id('match:'' or 1=1--')         as injection_null,
--          private.realtime_match_topic_id(null)                        as null_in_null_out,
--          private.realtime_is_private_match_topic('match:abc:private') as should_be_false;
--
-- 9.6 Negative test — a non-participant must not be able to join a private
--     topic. Run as a user with no row in match_participants for <MATCH_ID>:
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<NON_PARTICIPANT_UUID>","role":"authenticated"}';
--     set local realtime.topic = 'match:<MATCH_ID>:private';
--     select count(*) from realtime.messages;   -- expect 0
--   rollback;
--
-- 9.7 Replication slot health (run on the direct connection).
--
--   select slot_name, active, restart_lsn,
--          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) as retained_wal
--   from pg_replication_slots;
-- =============================================================================
