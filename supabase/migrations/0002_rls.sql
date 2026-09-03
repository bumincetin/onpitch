-- =============================================================================
-- OnPitch — 0002_rls.sql
-- Row Level Security layer: private helper predicates, privilege reset,
-- per-command policies for 16 of the 19 public tables (three are deliberately
-- left policy-less, see section 4.8), the avatars storage bucket, and the
-- indexes those policies depend on.
--
-- Depends on: 0001_schema.sql (tables, enums, indexes, RLS already ENABLED
-- with zero policies, so the database is currently failing closed).
--
-- Requires Supabase: this file references auth.uid() / auth.jwt() and the
-- anon / authenticated / service_role roles.
-- =============================================================================
--
-- -----------------------------------------------------------------------------
-- Why every auth/helper call is wrapped in a scalar subquery
-- -----------------------------------------------------------------------------
--
-- An RLS policy expression is not evaluated once per statement. The planner
-- injects it as a qual on the scan node of the protected relation, so it is
-- evaluated once PER CANDIDATE ROW.
--
--   USING ( auth.uid() = booked_by )          -- FORBIDDEN
--
-- auth.uid() is a plain function call sitting directly in the qual. Postgres
-- treats it as a per-row filter expression: for a 500k-row bookings table it
-- calls current_setting()/jsonb parsing 500k times. Worse, because the qual is
-- `f(...) = column` rather than `column = <constant>`, the planner cannot turn
-- it into an index scan condition. It degrades to
-- `Seq Scan on bookings  Filter: (uid() = booked_by)`.
--
--   USING ( (select auth.uid()) = booked_by )  -- CORRECT
--
-- The scalar subquery has no correlation to the outer row, so the planner
-- hoists it into an InitPlan: it runs exactly ONCE, before the scan, and its
-- result is substituted as a Param. The qual becomes `booked_by = $0`, which
-- is an ordinary constant comparison — so idx_bookings_booked_by can be used
-- and the plan collapses to
--   InitPlan 1 (returns $0)
--     -> Result
--   Index Scan using idx_bookings_booked_by on bookings
--     Index Cond: (booked_by = $0)
--
-- The same hoist applies to (select auth.jwt()), (select auth.role()) and to
-- any helper whose arguments are CONSTANT, e.g. (select private.is_admin()).
--
-- Correlated helpers cannot be hoisted:
--   USING ( (select private.owns_venue(venue_id)) )
-- references a column of the row under test, so it is a correlated SubPlan,
-- not an InitPlan, and it does run per row. The wrapper is still worth having
-- (it keeps one uniform, greppable style and lets the executor treat the call
-- as a single scalar subplan node), but the real optimisation for those cases
-- is structural, and this file applies it consistently:
--
--   1. Put the hoistable, index-backed disjunct FIRST. `owner_id = (select
--      auth.uid())` short-circuits before any correlated helper runs, so the
--      expensive path is only reached for rows the cheap path did not accept.
--   2. Every column compared in a policy is indexed (section 7 tops up what
--      0001 did not already cover).
--   3. Helpers are STABLE, so the executor may reuse a result within a scan
--      for repeated identical arguments, and SECURITY DEFINER, so the nested
--      lookups inside them are not themselves re-filtered by RLS.
--
-- Inside a helper function body a bare auth.uid() would already be fine (the
-- body runs once per call, not once per row); the wrappers are kept there too
-- purely so the house rule has zero exceptions to remember.
--
-- -----------------------------------------------------------------------------
-- SECURITY DEFINER + FORCE RLS
-- -----------------------------------------------------------------------------
-- private.can_view_profile() reads public.profiles, and public.profiles' own
-- SELECT policy calls it. That is only safe because the helper is SECURITY
-- DEFINER and its owner (postgres on Supabase) holds BYPASSRLS, so RLS is not
-- re-applied inside the function body. BYPASSRLS is checked before the FORCE
-- flag, so `force row level security` below does not change this.
-- If you ever see "stack depth limit exceeded" or an infinite-recursion error
-- on public.profiles, the migration role lacks BYPASSRLS; the escape hatch is
--   alter table public.profiles no force row level security;
-- A warning is raised at the bottom of section 1 if that is the case.
-- =============================================================================

set search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Preconditions
-- -----------------------------------------------------------------------------

do $preconditions$
begin
  if to_regprocedure('auth.uid()') is null then
    raise exception
      'auth.uid() not found. 0002_rls.sql targets Supabase (GoTrue installs the auth schema).';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    raise exception 'Role "authenticated" not found. 0002_rls.sql targets Supabase.';
  end if;

  if not (select rolbypassrls from pg_roles where rolname = current_user) then
    raise warning
      'Migration role % lacks BYPASSRLS. SECURITY DEFINER helpers that read the table they protect (private.can_view_profile -> public.profiles) will recurse under FORCE ROW LEVEL SECURITY. If that bites, run: alter table public.profiles no force row level security;',
      current_user;
  end if;
end
$preconditions$;

-- -----------------------------------------------------------------------------
-- 2. Helper predicates (schema `private`)
--
-- Every one is:
--   stable            -> safe in a qual, result may be reused inside a scan
--   security definer  -> nested lookups are not re-filtered by RLS, which is
--                        what makes non-recursive self-referencing policies and
--                        cross-table checks possible at all
--   set search_path = '' -> immune to search_path hijacking; every identifier
--                        below is therefore fully schema-qualified
--
-- All of them return boolean-or-enum and never return NULL for a missing row
-- (exists() yields false), so a policy can never fail open on a dangling id.
-- -----------------------------------------------------------------------------

-- 2.1 current_role — JWT claim first, profiles table as fallback.
-- Quoted because CURRENT_ROLE is a reserved SQL key word.
create or replace function private."current_role"()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  with claim as (
    select coalesce(
      nullif((select auth.jwt()) ->> 'user_role', ''),
      nullif((select auth.jwt()) -> 'app_metadata' ->> 'user_role', '')
    ) as raw
  )
  select coalesce(
    -- Only trust the claim when it is a real enum label; a junk claim must not
    -- raise 22P02 inside a policy (that would take the whole query down).
    (select c.raw::public.app_role
       from claim c
      where c.raw in ('admin', 'venue_owner', 'player')),
    (select p.role
       from public.profiles p
      where p.id = (select auth.uid())
        and p.deleted_at is null),
    'player'::public.app_role
  );
$$;

comment on function private."current_role"() is
  'Effective app_role for the caller. Reads the user_role JWT claim (top level, then app_metadata) and falls back to public.profiles.role. Defaults to player for anon/unknown.';

-- 2.2 is_admin
create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and (select private."current_role"()) = 'admin'::public.app_role;
$$;

comment on function private.is_admin() is 'True when the caller is an authenticated platform admin.';

-- 2.3 owns_venue — strict ownership, deliberately NOT admin-inclusive so the
-- policies stay honest about which grant they are relying on.
create or replace function private.owns_venue(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.venues v
     where v.id = p_venue_id
       and v.owner_id = (select auth.uid())
  );
$$;

comment on function private.owns_venue(uuid) is 'True when the caller is venues.owner_id for this venue. Does not include admins.';

-- 2.4 owns_pitch — ownership of the pitch's parent venue.
create or replace function private.owns_pitch(p_pitch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.pitches pt
      join public.venues v on v.id = pt.venue_id
     where pt.id = p_pitch_id
       and v.owner_id = (select auth.uid())
  );
$$;

comment on function private.owns_pitch(uuid) is 'True when the caller owns the venue this pitch belongs to.';

-- 2.5 is_team_member — active membership, plus the founding owner who may not
-- have an explicit team_members row.
create or replace function private.is_team_member(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.team_members tm
     where tm.team_id = p_team_id
       and tm.player_id = (select auth.uid())
       and tm.left_at is null
  )
  or exists (
    select 1
      from public.teams t
     where t.id = p_team_id
       and t.owner_id = (select auth.uid())
  );
$$;

comment on function private.is_team_member(uuid) is 'True for an active (left_at is null) member of the team, or the team owner.';

-- 2.6 is_team_captain — write authority on a team.
create or replace function private.is_team_captain(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.teams t
     where t.id = p_team_id
       and t.owner_id = (select auth.uid())
  )
  or exists (
    select 1
      from public.team_members tm
     where tm.team_id = p_team_id
       and tm.player_id = (select auth.uid())
       and tm.left_at is null
       and tm.role in ('captain'::public.team_member_role, 'vice_captain'::public.team_member_role)
  );
$$;

comment on function private.is_team_captain(uuid) is 'True for the team owner, a captain, or a vice_captain. This is the team write predicate.';

-- 2.7 is_match_participant — on the line-up, or on either team's active roster.
create or replace function private.is_match_participant(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.match_participants mp
     where mp.match_id = p_match_id
       and mp.player_id = (select auth.uid())
  )
  or exists (
    select 1
      from public.matches m
      join public.team_members tm
        on tm.team_id in (m.home_team_id, m.away_team_id)
     where m.id = p_match_id
       and tm.player_id = (select auth.uid())
       and tm.left_at is null
  );
$$;

comment on function private.is_match_participant(uuid) is 'True when the caller is in the match line-up or on the active roster of either side.';

-- 2.8 shares_team_with — used by can_view_profile. Touches only team_members,
-- never public.profiles, so it can be called from the profiles policy without
-- widening the recursion surface.
create or replace function private.shares_team_with(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.team_members mine
      join public.team_members theirs on theirs.team_id = mine.team_id
     where mine.player_id = (select auth.uid())
       and mine.left_at is null
       and theirs.player_id = p_profile_id
       and theirs.left_at is null
  );
$$;

comment on function private.shares_team_with(uuid) is 'True when the caller and the target profile are both active members of at least one common team.';

-- 2.9 can_view_profile — the visibility contract.
--   * self and admins always
--   * active teammates always (they need each other's display name to play)
--   * everyone else only for adults who opted in to public/members visibility
--   * soft-deleted profiles are invisible to everyone but admins
-- Minors are private-by-default here as well as by the
-- profiles_minor_privacy_locked_check constraint in 0001: belt and braces,
-- because that constraint only forbids storing 'public', it does not stop a
-- 'members' minor from being listed.
create or replace function private.can_view_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = p_profile_id
       and (
         p.id = (select auth.uid())
         or (select private.is_admin())
         or (
           p.deleted_at is null
           and (
             (select private.shares_team_with(p_profile_id))
             or (
               p.is_minor is not true
               and p.profile_visibility in ('public', 'members')
               and (select auth.uid()) is not null
             )
           )
         )
       )
  );
$$;

comment on function private.can_view_profile(uuid) is 'Profile visibility predicate: self | admin | active teammate | adult with public/members visibility. Soft-deleted rows are admin-only. Minors are never listable to strangers.';

-- 2.10 is_venue_visible — a venue is listable when active, mine, or I am admin.
create or replace function private.is_venue_visible(p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.venues v
     where v.id = p_venue_id
       and (
         v.is_active
         or v.owner_id = (select auth.uid())
         or (select private.is_admin())
       )
  );
$$;

comment on function private.is_venue_visible(uuid) is 'True when the venue is published, owned by the caller, or the caller is an admin.';

-- 2.11 pitch_is_bookable — active pitch inside an active venue. Used as an
-- INSERT guard on bookings so nobody can reserve an unpublished facility.
create or replace function private.pitch_is_bookable(p_pitch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.pitches pt
      join public.venues v on v.id = pt.venue_id
     where pt.id = p_pitch_id
       and pt.is_active
       and v.is_active
  );
$$;

comment on function private.pitch_is_bookable(uuid) is 'True when the pitch is active and its venue is published. Gate for booking inserts.';

-- 2.12 can_manage_match / can_view_match — the shared write and read predicates
-- for the whole match cluster (matches, participants, stats, reports,
-- consensus, anomaly flags). Defining them once keeps six tables consistent.
-- can_manage_match is declared FIRST because check_function_bodies is on by
-- default and a `language sql` body is parsed at CREATE time: a forward
-- reference here would abort the migration with "function does not exist".
create or replace function private.can_manage_match(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.is_admin())
      or exists (
        select 1
          from public.matches m
         where m.id = p_match_id
           and (
             m.created_by = (select auth.uid())
             or (m.venue_id is not null and (select private.owns_venue(m.venue_id)))
             or (m.pitch_id is not null and (select private.owns_pitch(m.pitch_id)))
           )
      );
$$;

comment on function private.can_manage_match(uuid) is 'Write predicate for the match cluster: the organiser (created_by), the hosting venue owner, or an admin. Plain participants are excluded.';

create or replace function private.can_view_match(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.is_match_participant(p_match_id))
      or (select private.can_manage_match(p_match_id));
$$;

comment on function private.can_view_match(uuid) is 'Read predicate for the match cluster: participants, the organiser, the hosting venue owner, or an admin.';

-- 2.12a match_accepts_self_join — may the caller add themselves to this sheet?
--
-- It has to be SECURITY DEFINER. This is called from the INSERT
-- policy on match_participants, where a policy qual runs as the INVOKING user:
-- an inline `exists (select 1 from public.matches ...)` there would be filtered
-- by matches_select_involved, which is built on can_view_match, which is built
-- on is_match_participant — so the one person the self-join branch exists to
-- serve (somebody not yet on the sheet) is exactly the person who cannot see
-- the row, and every legitimate join would be refused. Reading the match
-- through a definer helper is what makes the predicate answerable.
--
-- The two branches are the only surfaces that constitute an invitation: an open
-- pickup match (organiser-created, no clubs on either side) or a club fixture
-- where the caller is on the active roster. is_team_member(null) is false,
-- which is the wanted answer when only one side is a club.
create or replace function private.match_accepts_self_join(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.matches m
     where m.id = p_match_id
       and m.status in ('scheduled'::public.match_status, 'live'::public.match_status)
       and (
         (
           m.created_by is not null
           and m.home_team_id is null
           and m.away_team_id is null
         )
         or private.is_team_member(m.home_team_id)
         or private.is_team_member(m.away_team_id)
       )
  );
$$;

comment on function private.match_accepts_self_join(uuid) is 'True when the caller may add themselves to this match line-up: an open pickup match, or a club fixture they are rostered for, and only while the match is scheduled or live. SECURITY DEFINER because the caller cannot yet SELECT the match.';

-- 2.12b match_has_score_reports — evidence guard for the match DELETE policy.
--
-- Also SECURITY DEFINER, and here it matters more, because the helper is used
-- under a NOT EXISTS. If the subquery were RLS-filtered and returned nothing
-- because the caller could not see the reports, the guard would read "no
-- evidence here" and permit the delete. A definer helper makes the answer
-- independent of the caller's visibility, so the failure mode is closed.
create or replace function private.match_has_score_reports(p_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.score_reports sr
     where sr.match_id = p_match_id
  );
$$;

comment on function private.match_has_score_reports(uuid) is 'True when any score report has been filed for this match. Used by matches_delete_organiser_scheduled to stop evidence being cascade-deleted; SECURITY DEFINER so an RLS-filtered empty result can never read as "no reports".';

-- 2.12c has_transacting_consent — the GDPR Art. 8 gate, in the database.
--
-- 0003 defines public.assert_consented(uuid) and documents it as "call this
-- first in every booking / match-joining RPC", but nothing in SQL ever calls
-- it: the gate lives only in three TypeScript route handlers, and PostgREST
-- reaches public.bookings and public.match_participants directly, so a minor
-- with a raw anon key and their own JWT walks straight past it. This is the
-- predicate form, used by the restrictive INSERT policies in 5.7 and 5.9.
--
-- A NULL date_of_birth does NOT pass. The only age gate at signup is browser
-- JavaScript and supabase.auth.signUp() is a direct client call, so "unknown
-- age" is a state a minor can choose; treating it as adult would make the gate
-- opt-out. The 16 threshold and the 'granted' status mirror
-- public.assert_consented exactly.
--
-- age_years() lives in 0003, which has not run yet at this point in the
-- migration order, so the arithmetic is inlined rather than delegated.
create or replace function private.has_transacting_consent(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = p_user_id
       and p.deleted_at is null
       and (
         (
           p.date_of_birth is not null
           and extract(year from age(current_date, p.date_of_birth))::integer >= 16
         )
         or p.parental_consent_status = 'granted'::public.consent_status
       )
  );
$$;

comment on function private.has_transacting_consent(uuid) is 'GDPR Art. 8 gate as an RLS predicate: true for an adult (16+) or a minor whose guardian consent is granted. A NULL date_of_birth is NOT consent. Mirrors public.assert_consented(uuid) from 0003.';

-- 2.13 Execute grants.
-- Default EXECUTE for PUBLIC is stripped so anon can never probe these, then
-- re-granted to authenticated only. service_role and postgres reach them as
-- owner / via the schema grants already issued by 0001.
--
-- USAGE on schema `private` is also granted to authenticated. Strictly it is
-- not needed for the policies themselves — a stored policy qual carries the
-- function OID and only ACL_EXECUTE is re-checked at runtime, never schema
-- name resolution (the same mechanism 0001 relies on for the is_minor
-- generated column). It is granted anyway because relying on that subtlety to
-- keep the entire authorization layer working is not a bet worth taking, and
-- direct callability leaks nothing: every helper only answers questions about
-- the caller's own access to an id the caller already holds.
-- anon deliberately gets neither USAGE nor EXECUTE; no anon policy below
-- references a helper.
grant usage on schema private to authenticated;

revoke all on function private."current_role"()               from public;
revoke all on function private.is_admin()                     from public;
revoke all on function private.owns_venue(uuid)               from public;
revoke all on function private.owns_pitch(uuid)               from public;
revoke all on function private.is_team_member(uuid)           from public;
revoke all on function private.is_team_captain(uuid)          from public;
revoke all on function private.is_match_participant(uuid)     from public;
revoke all on function private.shares_team_with(uuid)         from public;
revoke all on function private.can_view_profile(uuid)         from public;
revoke all on function private.is_venue_visible(uuid)         from public;
revoke all on function private.pitch_is_bookable(uuid)        from public;
revoke all on function private.can_view_match(uuid)           from public;
revoke all on function private.can_manage_match(uuid)         from public;
revoke all on function private.match_accepts_self_join(uuid)   from public;
revoke all on function private.match_has_score_reports(uuid)  from public;
revoke all on function private.has_transacting_consent(uuid) from public;

grant execute on function private."current_role"()            to authenticated;
grant execute on function private.is_admin()                  to authenticated;
grant execute on function private.owns_venue(uuid)            to authenticated;
grant execute on function private.owns_pitch(uuid)            to authenticated;
grant execute on function private.is_team_member(uuid)        to authenticated;
grant execute on function private.is_team_captain(uuid)       to authenticated;
grant execute on function private.is_match_participant(uuid)  to authenticated;
grant execute on function private.shares_team_with(uuid)      to authenticated;
grant execute on function private.can_view_profile(uuid)      to authenticated;
grant execute on function private.is_venue_visible(uuid)      to authenticated;
grant execute on function private.pitch_is_bookable(uuid)     to authenticated;
grant execute on function private.can_view_match(uuid)        to authenticated;
grant execute on function private.can_manage_match(uuid)      to authenticated;
grant execute on function private.match_accepts_self_join(uuid) to authenticated;
grant execute on function private.match_has_score_reports(uuid) to authenticated;
grant execute on function private.has_transacting_consent(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Enable + FORCE row level security on every public table
--
-- ENABLE is idempotent (0001 already did it). FORCE is the addition: it strips
-- the implicit exemption the table OWNER enjoys, so a compromised or careless
-- `postgres` session inside the API path is still policed. It does not close
-- the service_role escape hatch — BYPASSRLS is evaluated before the FORCE flag,
-- so the admin client (createAdminClient()) still sees and writes everything.
-- -----------------------------------------------------------------------------

alter table public.profiles                  enable row level security;
alter table public.profiles                  force  row level security;
alter table public.teams                     enable row level security;
alter table public.teams                     force  row level security;
alter table public.team_members              enable row level security;
alter table public.team_members              force  row level security;
alter table public.venues                    enable row level security;
alter table public.venues                    force  row level security;
alter table public.pitches                   enable row level security;
alter table public.pitches                   force  row level security;
alter table public.pitch_availability_blocks  enable row level security;
alter table public.pitch_availability_blocks  force  row level security;
alter table public.bookings                  enable row level security;
alter table public.bookings                  force  row level security;
alter table public.matches                   enable row level security;
alter table public.matches                   force  row level security;
alter table public.match_participants        enable row level security;
alter table public.match_participants        force  row level security;
alter table public.player_ratings            enable row level security;
alter table public.player_ratings            force  row level security;
alter table public.player_stats              enable row level security;
alter table public.player_stats              force  row level security;
alter table public.score_reports             enable row level security;
alter table public.score_reports             force  row level security;
alter table public.match_anomaly_flags       enable row level security;
alter table public.match_anomaly_flags       force  row level security;
alter table public.consensus_approvals       enable row level security;
alter table public.consensus_approvals       force  row level security;
alter table public.venue_payouts             enable row level security;
alter table public.venue_payouts             force  row level security;
alter table public.stripe_events             enable row level security;
alter table public.stripe_events             force  row level security;
alter table public.parental_consent_requests enable row level security;
alter table public.parental_consent_requests force  row level security;
alter table public.audit_log                 enable row level security;
alter table public.audit_log                 force  row level security;
alter table public.notifications             enable row level security;
alter table public.notifications             force  row level security;

-- -----------------------------------------------------------------------------
-- 4. Privilege reset — the layer below RLS
--
-- RLS filters rows. It cannot stop a user from writing a column they should
-- never touch, because an UPDATE policy's WITH CHECK only ever sees the NEW
-- row and has no way to assert "this column did not change". Column-level
-- GRANTs are the only mechanism in PostgreSQL that expresses that, so they are
-- the hard guarantee for money, Stripe ids, roles and consent state, and the
-- policies below restate the same rule where a reader of the policies will
-- find it. Read every `grant update (...)` below as the definitive list of
-- what an end user may ever write to that table.
--
-- Everything is revoked from anon and authenticated first so nothing survives
-- from Supabase's default privileges. service_role is untouched throughout and
-- remains the full-access escape hatch.
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

revoke all on table public.profiles                  from anon, authenticated;
revoke all on table public.teams                     from anon, authenticated;
revoke all on table public.team_members              from anon, authenticated;
revoke all on table public.venues                    from anon, authenticated;
revoke all on table public.pitches                   from anon, authenticated;
revoke all on table public.pitch_availability_blocks from anon, authenticated;
revoke all on table public.bookings                  from anon, authenticated;
revoke all on table public.matches                   from anon, authenticated;
revoke all on table public.match_participants        from anon, authenticated;
revoke all on table public.player_ratings            from anon, authenticated;
revoke all on table public.player_stats              from anon, authenticated;
revoke all on table public.score_reports             from anon, authenticated;
revoke all on table public.match_anomaly_flags       from anon, authenticated;
revoke all on table public.consensus_approvals       from anon, authenticated;
revoke all on table public.venue_payouts             from anon, authenticated;
revoke all on table public.stripe_events             from anon, authenticated;
revoke all on table public.parental_consent_requests from anon, authenticated;
revoke all on table public.audit_log                 from anon, authenticated;
revoke all on table public.notifications             from anon, authenticated;

-- INSERT is column-scoped too, wherever a table has server-owned columns. A
-- column omitted from an INSERT grant cannot be supplied at all, so the row
-- takes its DEFAULT — which is exactly the safe value in every case below.
-- This is what stops, for example, a signup from squatting someone else's
-- stripe_customer_id or a score report from arriving with a forged ip_hash.

-- 4.1 profiles — no DELETE ever (erasure is a soft delete performed by the
-- server). role is insertable (self-serve signup picks player or venue_owner,
-- capped by the restrictive policy in 5.1) but never updatable. Stripe ids,
-- consent state and deleted_at are neither, so privilege escalation and
-- payment-identity theft are blocked by the grant itself and not only by a
-- policy that a later edit could widen.
-- SELECT is column-scoped too, and here it has to be. profiles is the one table
-- whose row-level visibility contract deliberately opens rows to STRANGERS:
-- profiles_select_self_or_visible (5.1) and private.can_view_profile both admit
-- any adult, non-deleted profile whose profile_visibility is 'public' or
-- 'members'. RLS is row-level, so a table-wide SELECT grant hands every such
-- row's email, phone, date_of_birth, guardian_email, guardian_name,
-- stripe_account_id and stripe_customer_id to any logged-in user. The column
-- list below is the public directory surface and nothing more.
--
-- The owner's own sensitive columns are served by public.my_profile() (5.1a),
-- a SECURITY DEFINER RPC keyed on auth.uid(). Note that a policy qual is
-- evaluated by the executor and is NOT subject to the caller's column
-- privileges, so deleted_at / is_minor / profile_visibility keep working inside
-- the policies whether or not they appear here.
grant select (
  id, display_name, full_name, avatar_url, role,
  city, preferred_position, bio,
  profile_visibility, created_at
) on table public.profiles to authenticated;
grant insert (
  id, email, full_name, display_name, avatar_url, role, date_of_birth,
  guardian_email, guardian_name,
  location_sharing_enabled, profile_visibility, marketing_opt_in,
  phone, city, preferred_position, bio, onboarding_completed_at
) on table public.profiles to authenticated;
-- date_of_birth is deliberately ABSENT from the UPDATE grant. It is insertable
-- (signup collects it) but not updatable, because is_minor is GENERATED STORED
-- and is recomputed on every UPDATE of the row: a minor who PATCHed an adult
-- birth date would flip is_minor to false in the same statement, at which point
-- enforce_minor_privacy (0003, section 6) rewrites their 'pending' consent to
-- 'not_required' and profiles_minor_privacy_locked_check stops applying — a
-- one-request escape from the entire Art. 8 gate. Genuine corrections go
-- through a server-side path that re-enters the consent flow.
grant update (
  full_name, display_name, avatar_url,
  guardian_email, guardian_name,
  location_sharing_enabled, profile_visibility, marketing_opt_in,
  phone, city, preferred_position, bio,
  last_seen_at, onboarding_completed_at
) on table public.profiles to authenticated;

-- 4.2 teams / team_members. owner_id is insertable (you found the team) but
-- not updatable: transferring a team is a server-side operation.
grant select, delete on table public.teams to authenticated;
grant insert (name, slug, owner_id, city, crest_url, description, is_public)
  on table public.teams to authenticated;
grant update (name, slug, city, crest_url, description, is_public)
  on table public.teams to authenticated;

grant select, delete on table public.team_members to authenticated;
-- role is deliberately ABSENT from the INSERT grant. The insert policy's
-- self-join branch only ever constrains player_id / left_at / t.is_public — it
-- says nothing about role — and PostgreSQL does not evaluate an UPDATE policy
-- on an INSERT, so team_members_update_no_self_promotion below is no defence
-- here. With role ungrantable the row takes its DEFAULT 'member', which is the
-- only safe value: private.is_team_captain() returns true for 'captain' and
-- 'vice_captain', so a self-inserted captain row is an immediate takeover of
-- any public team (roster edits, team UPDATE, team DELETE). A captain
-- promoting a co-captain does it in two statements; the UPDATE path is already
-- guarded.
grant insert (team_id, player_id, jersey_number)
  on table public.team_members to authenticated;
grant update (role, jersey_number, left_at)
  on table public.team_members to authenticated;

-- 4.3 venues / pitches / availability blocks.
-- The Stripe mirror columns (stripe_account_id, charges_enabled,
-- payouts_enabled, onboarding_completed_at) are webhook-owned and appear in
-- neither the INSERT nor the UPDATE grant. That is precisely what lets the
-- venues_update_publish_requires_stripe restrictive policy in 5.4 be trusted:
-- charges_enabled in the NEW row is guaranteed to be the value Stripe last
-- wrote, not something the owner just typed.
--
-- anon gets SELECT only, on venues and pitches only. A logged-out visitor has
-- to be able to browse facilities before signing up; that is the entire public
-- surface of this database.
grant select on table public.venues  to anon;
grant select on table public.pitches to anon;

grant select, delete on table public.venues to authenticated;
grant insert (
  owner_id, name, slug, description,
  address_line1, address_line2, city, district, postal_code, country,
  latitude, longitude, amenities, photos,
  phone, contact_email, timezone
) on table public.venues to authenticated;
grant update (
  name, slug, description,
  address_line1, address_line2, city, district, postal_code, country,
  latitude, longitude, amenities, photos,
  phone, contact_email, timezone, is_active
) on table public.venues to authenticated;

grant select, delete on table public.pitches to authenticated;
grant insert (
  venue_id, name, format, surface, is_indoor, capacity,
  hourly_rate_minor, currency, opening_time, closing_time, slot_minutes, is_active
) on table public.pitches to authenticated;
grant update (
  name, format, surface, is_indoor, capacity,
  hourly_rate_minor, currency, opening_time, closing_time, slot_minutes, is_active
) on table public.pitches to authenticated;

grant select, delete on table public.pitch_availability_blocks to authenticated;
grant insert (pitch_id, block_range, reason, created_by)
  on table public.pitch_availability_blocks to authenticated;
grant update (block_range, reason)
  on table public.pitch_availability_blocks to authenticated;

-- 4.4 bookings — the money table.
-- No DELETE grant at all. UPDATE is narrowed to three columns so that every
-- amount, payment_status and every Stripe identifier are physically
-- unreachable from an end-user session; only the service_role webhook/route
-- path can move them.
-- The only client-side mutation left is "cancel", which the restrictive policy
-- in 5.7 pins down further.
--
-- INSERT still has to accept the amounts (the row is created before the
-- PaymentIntent exists), so subtotal/fee/total are the one place where a
-- client-supplied number reaches this table. They must be recomputed
-- server-side from pitches.hourly_rate_minor before any charge is created.
-- RLS cannot express that invariant; the checkout route has to.
grant select on table public.bookings to authenticated;
grant insert (
  pitch_id, booked_by, team_id, time_range, status, payment_status,
  subtotal_minor, platform_fee_minor, total_minor, currency, notes
) on table public.bookings to authenticated;
grant update (status, cancelled_at, cancellation_reason)
  on table public.bookings to authenticated;

-- 4.5 match cluster. player_stats and match_anomaly_flags are read-only to
-- users: they are written by the rating engine and the integrity checker, both
-- of which run as service_role. The result-integrity columns on matches
-- (home_score, away_score, score_confirmed_at, requires_consensus,
-- anomaly_score, match_quality, rating_applied_at) appear in no grant at all,
-- so a score can only ever enter the system through score_reports.
grant select, delete on table public.matches to authenticated;
grant insert (
  booking_id, pitch_id, venue_id, format, status, kickoff_at,
  duration_minutes, home_team_id, away_team_id, is_ranked, created_by
) on table public.matches to authenticated;
grant update (kickoff_at, duration_minutes, format, home_team_id, away_team_id, status)
  on table public.matches to authenticated;

grant select, delete on table public.match_participants to authenticated;
grant insert (match_id, player_id, team_side, is_confirmed)
  on table public.match_participants to authenticated;
-- team_side is settable at INSERT (you pick a side when you join) and frozen
-- afterwards. Freezing it is a correctness requirement.
-- public.finalize_consensus reads the side live at vote-counting time — it
-- joins consensus_approvals back to match_participants — and requires at least
-- one approval from each side. That cross-side conjunct is the anti-collusion
-- half of the quorum rule. If a voter can flip their own team_side after
-- casting an approval (the vote row is untouched: nonce and payload_digest
-- still match) then one stacked dressing room re-counts as both sides and
-- ratifies its own scoreline. Moving a player between sides is a server-side
-- operation. is_confirmed stays writable: that is the player's own check-in.
grant update (is_confirmed)
  on table public.match_participants to authenticated;

grant select on table public.player_ratings      to authenticated;
grant select on table public.player_stats        to authenticated;
grant select on table public.match_anomaly_flags to authenticated;

-- Score reports and consensus votes are append-only evidence: insert once,
-- never edit, never delete. The unique constraints in 0001 make "once" literal.
--
-- score_reports.payload_hash and .ip_hash are the server's tamper-evidence
-- fields (a hash the client chose proves nothing), so they are withheld from
-- the INSERT grant and stay NULL unless the server route writes the row.
--
-- consensus_approvals is the opposite shape: payload_digest and nonce are NOT
-- NULL with no default, so withholding them would make the table
-- uninsertable. The nonce is server-issued and single-use and the signature is
-- HMAC'd with a server secret the client does not hold, so the client is only
-- ever echoing back values it was handed. What RLS guarantees here is narrow:
-- the vote is attributable to a real participant, voting as themselves,
-- exactly once (consensus_approvals_unique). Verifying that digest, nonce and
-- signature actually agree is the consensus route's job, not this file's.
grant select on table public.score_reports to authenticated;
grant insert (match_id, reported_by, team_side, home_score, away_score, client_reported_at)
  on table public.score_reports to authenticated;

grant select on table public.consensus_approvals to authenticated;
grant insert (match_id, approver_id, decision, canonical_payload, payload_digest, nonce, signature)
  on table public.consensus_approvals to authenticated;

-- 4.6 venue_payouts — read-only mirror of Stripe payouts.
grant select on table public.venue_payouts to authenticated;

-- 4.7 notifications — the server writes them, the owner reads/dismisses them.
grant select, delete on table public.notifications to authenticated;
grant update (read_at) on table public.notifications to authenticated;

-- 4.8 No grants at all, and no policies below, for:
--       public.stripe_events
--       public.audit_log
--       public.parental_consent_requests
-- These are service_role-only by design and the omission is deliberate:
--   * stripe_events is the webhook idempotency ledger. Exposing it would leak
--     raw Stripe payloads (customer emails, card metadata) and let a client
--     poison replay protection by pre-inserting an evt_* id.
--   * audit_log is the GDPR Art. 5(2) accountability trail. It must be
--     append-only from the application's perspective and unreadable by the
--     subjects it records, including admins going through PostgREST — admin
--     dashboards read it through createAdminClient().
--   * parental_consent_requests holds token_hash and guardian_ip_hash. Any
--     read access is a path to brute-forcing a consent token, so the whole
--     GDPR Art. 8 flow lives in server routes on the service_role client.
-- With RLS enabled, FORCE set and zero policies, these three tables return
-- zero rows and reject every write for anon and authenticated. That is the
-- intended state; do not "fix" it by adding a policy.

-- -----------------------------------------------------------------------------
-- 5. Policies. One policy per command per audience — never FOR ALL, so that
-- read access and write access can never drift into each other by accident.
-- -----------------------------------------------------------------------------

-- =============================== 5.1 profiles ================================
-- The three cheap, hoistable/row-local disjuncts come first; can_view_profile
-- (correlated, does a lookup) is only reached for the teammate case.

drop policy if exists profiles_select_self_or_visible on public.profiles;
create policy profiles_select_self_or_visible
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_admin())
    or (
      deleted_at is null
      and is_minor is not true
      and profile_visibility in ('public', 'members')
    )
    or (select private.can_view_profile(id))
  );

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
  on public.profiles
  for insert
  to authenticated
  with check (
    id = (select auth.uid())
    and deleted_at is null
  );

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_admin())
  )
  with check (
    id = (select auth.uid())
    or (select private.is_admin())
  );

-- RESTRICTIVE: role is not self-assignable.
-- 'admin' can never be claimed at signup. venue_owner is allowed because a
-- facility owner registers through the same self-serve signup a player does.
drop policy if exists profiles_insert_role_not_admin on public.profiles;
create policy profiles_insert_role_not_admin
  on public.profiles
  as restrictive
  for insert
  to authenticated
  with check (
    (select private.is_admin())
    or role in ('player'::public.app_role, 'venue_owner'::public.app_role)
  );

-- RESTRICTIVE: role may not be escalated on update.
-- private."current_role"() is STABLE, so inside this statement it still reads
-- the caller's PRE-update role; requiring the NEW value to equal it is exactly
-- "the role did not change". Admins are exempt. Belt and braces on top of the
-- fact that `role` is absent from the column-level UPDATE grant in 4.1. That
-- grant is the lock; this policy states the same rule where a reader of the
-- policies will find it.
drop policy if exists profiles_update_role_locked on public.profiles;
create policy profiles_update_role_locked
  on public.profiles
  as restrictive
  for update
  to authenticated
  using (true)
  with check (
    (select private.is_admin())
    or role = (select private."current_role"())
  );

-- ------------------------------ 5.1a my_profile ------------------------------
-- The column-scoped SELECT grant in 4.1 is what stops one authenticated user
-- reading another's email / phone / date_of_birth / guardian_* / stripe_*. It
-- is a role-level privilege, so it necessarily also applies to the owner's own
-- row. This RPC hands those columns back to the owner. It is SECURITY DEFINER
-- and keyed strictly on auth.uid(), so it can only ever return the caller's own
-- row and takes no argument that could be pointed at somebody else.
--
-- Callers: use this instead of `select *` on public.profiles from a cookie-bound
-- client (see @/lib/rbac getSessionUser and the guardian-consent path in
-- app/auth/callback).
create or replace function public.my_profile()
returns public.profiles
language sql
stable
security definer
set search_path = ''
as $$
  select p.*
    from public.profiles p
   where p.id = (select auth.uid())
     and p.deleted_at is null;
$$;

comment on function public.my_profile() is
  'Returns the calling user''s own profile row in full, including the columns withheld from the column-scoped SELECT grant (email, phone, date_of_birth, guardian_*, stripe_*). Keyed on auth.uid(); cannot be pointed at another user. Soft-deleted profiles return no row.';

revoke all on function public.my_profile() from public, anon;
grant execute on function public.my_profile() to authenticated;

-- ================================ 5.2 teams ==================================

drop policy if exists teams_select_public_or_member on public.teams;
create policy teams_select_public_or_member
  on public.teams
  for select
  to authenticated
  using (
    is_public
    or owner_id = (select auth.uid())
    or (select private.is_team_member(id))
    or (select private.is_admin())
  );

drop policy if exists teams_insert_own on public.teams;
create policy teams_insert_own
  on public.teams
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

drop policy if exists teams_update_captain on public.teams;
create policy teams_update_captain
  on public.teams
  for update
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (select private.is_team_captain(id))
    or (select private.is_admin())
  )
  with check (
    owner_id = (select auth.uid())
    or (select private.is_team_captain(id))
    or (select private.is_admin())
  );

-- Deleting a team destroys its membership history; only the founding owner
-- (or an admin) may do it, never a promoted captain.
drop policy if exists teams_delete_owner on public.teams;
create policy teams_delete_owner
  on public.teams
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (select private.is_admin())
  );

-- ============================ 5.3 team_members ===============================

drop policy if exists team_members_select_visible on public.team_members;
create policy team_members_select_visible
  on public.team_members
  for select
  to authenticated
  using (
    player_id = (select auth.uid())
    or (select private.is_team_member(team_id))
    or (select private.is_admin())
    or exists (
      select 1
        from public.teams t
       where t.id = team_members.team_id
         and t.is_public
    )
  );

-- Two legitimate ways to gain a row: a captain adds you, or you join a public
-- team yourself. Both are covered here; a private team is invite-only because
-- the self-join branch requires t.is_public.
drop policy if exists team_members_insert_captain_or_self_join on public.team_members;
create policy team_members_insert_captain_or_self_join
  on public.team_members
  for insert
  to authenticated
  with check (
    (select private.is_team_captain(team_id))
    or (select private.is_admin())
    or (
      player_id = (select auth.uid())
      and left_at is null
      and exists (
        select 1
          from public.teams t
         where t.id = team_members.team_id
           and t.is_public
      )
    )
  );

drop policy if exists team_members_update_captain_or_self on public.team_members;
create policy team_members_update_captain_or_self
  on public.team_members
  for update
  to authenticated
  using (
    player_id = (select auth.uid())
    or (select private.is_team_captain(team_id))
    or (select private.is_admin())
  )
  with check (
    player_id = (select auth.uid())
    or (select private.is_team_captain(team_id))
    or (select private.is_admin())
  );

-- RESTRICTIVE: a rank-and-file member editing their own row (setting a jersey
-- number, or left_at to leave the team) must not be able to promote themselves
-- to captain on the way past.
drop policy if exists team_members_update_no_self_promotion on public.team_members;
create policy team_members_update_no_self_promotion
  on public.team_members
  as restrictive
  for update
  to authenticated
  using (true)
  with check (
    (select private.is_team_captain(team_id))
    or (select private.is_admin())
    or role = 'member'::public.team_member_role
  );

drop policy if exists team_members_delete_captain_or_self on public.team_members;
create policy team_members_delete_captain_or_self
  on public.team_members
  for delete
  to authenticated
  using (
    player_id = (select auth.uid())
    or (select private.is_team_captain(team_id))
    or (select private.is_admin())
  );

-- ================================ 5.4 venues =================================
-- Venue and pitch listings are the only genuinely public surface in the
-- product: a logged-out visitor has to be able to browse facilities before
-- signing up. Those two anon policies are row-local (`is_active` only) and
-- reference no helper, which is why anon needs neither schema `private` USAGE
-- nor any EXECUTE grant.

drop policy if exists venues_select_active_anon on public.venues;
create policy venues_select_active_anon
  on public.venues
  for select
  to anon
  using (is_active);

drop policy if exists venues_select_active_or_own on public.venues;
create policy venues_select_active_or_own
  on public.venues
  for select
  to authenticated
  using (
    is_active
    or owner_id = (select auth.uid())
    or (select private.is_admin())
  );

-- A venue is always born unpublished and unlinked from Stripe. Publishing is
-- gated separately by venues_update_publish_requires_stripe below.
drop policy if exists venues_insert_owner on public.venues;
create policy venues_insert_owner
  on public.venues
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and (select private."current_role"()) in ('venue_owner'::public.app_role, 'admin'::public.app_role)
    and is_active = false
    and charges_enabled = false
    and payouts_enabled = false
    and stripe_account_id is null
  );

drop policy if exists venues_update_owner on public.venues;
create policy venues_update_owner
  on public.venues
  for update
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (select private.is_admin())
  )
  with check (
    owner_id = (select auth.uid())
    or (select private.is_admin())
  );

-- RESTRICTIVE: you may only flip is_active on once Stripe says the connected
-- account can actually take money. charges_enabled is not in the column-level
-- UPDATE grant, so in the NEW row it necessarily still holds the value the
-- account.updated webhook last wrote — which is what makes this check sound.
drop policy if exists venues_update_publish_requires_stripe on public.venues;
create policy venues_update_publish_requires_stripe
  on public.venues
  as restrictive
  for update
  to authenticated
  using (true)
  with check (
    (select private.is_admin())
    or is_active = false
    or charges_enabled = true
  );

drop policy if exists venues_delete_owner on public.venues;
create policy venues_delete_owner
  on public.venues
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid())
    or (select private.is_admin())
  );

-- ================================ 5.5 pitches ================================

drop policy if exists pitches_select_active_anon on public.pitches;
create policy pitches_select_active_anon
  on public.pitches
  for select
  to anon
  using (is_active);

drop policy if exists pitches_select_visible on public.pitches;
create policy pitches_select_visible
  on public.pitches
  for select
  to authenticated
  using (
    (is_active and (select private.is_venue_visible(venue_id)))
    or (select private.owns_pitch(id))
    or (select private.is_admin())
  );

drop policy if exists pitches_insert_venue_owner on public.pitches;
create policy pitches_insert_venue_owner
  on public.pitches
  for insert
  to authenticated
  with check (
    (select private.owns_venue(venue_id))
    or (select private.is_admin())
  );

drop policy if exists pitches_update_venue_owner on public.pitches;
create policy pitches_update_venue_owner
  on public.pitches
  for update
  to authenticated
  using (
    (select private.owns_venue(venue_id))
    or (select private.is_admin())
  )
  with check (
    (select private.owns_venue(venue_id))
    or (select private.is_admin())
  );

drop policy if exists pitches_delete_venue_owner on public.pitches;
create policy pitches_delete_venue_owner
  on public.pitches
  for delete
  to authenticated
  using (
    (select private.owns_venue(venue_id))
    or (select private.is_admin())
  );

-- ====================== 5.6 pitch_availability_blocks ========================
-- Signed-in users need these to render an accurate slot grid. anon gets no
-- policy: blackout `reason` text can name a private hirer, so the calendar is
-- behind the login wall even though the venue listing is not.

drop policy if exists pitch_blocks_select_bookable on public.pitch_availability_blocks;
create policy pitch_blocks_select_bookable
  on public.pitch_availability_blocks
  for select
  to authenticated
  using (
    (select private.pitch_is_bookable(pitch_id))
    or (select private.owns_pitch(pitch_id))
    or (select private.is_admin())
  );

drop policy if exists pitch_blocks_insert_owner on public.pitch_availability_blocks;
create policy pitch_blocks_insert_owner
  on public.pitch_availability_blocks
  for insert
  to authenticated
  with check (
    ((select private.owns_pitch(pitch_id)) or (select private.is_admin()))
    and (created_by is null or created_by = (select auth.uid()))
  );

drop policy if exists pitch_blocks_update_owner on public.pitch_availability_blocks;
create policy pitch_blocks_update_owner
  on public.pitch_availability_blocks
  for update
  to authenticated
  using (
    (select private.owns_pitch(pitch_id))
    or (select private.is_admin())
  )
  with check (
    (select private.owns_pitch(pitch_id))
    or (select private.is_admin())
  );

drop policy if exists pitch_blocks_delete_owner on public.pitch_availability_blocks;
create policy pitch_blocks_delete_owner
  on public.pitch_availability_blocks
  for delete
  to authenticated
  using (
    (select private.owns_pitch(pitch_id))
    or (select private.is_admin())
  );

-- =============================== 5.7 bookings ================================
-- Visible to the booker, everyone on the booking's team, and the venue owner
-- who has to honour it. booked_by is the hoistable, index-backed disjunct and
-- is deliberately first: it is the case that matters for "my bookings" pages.
--
-- A stranger browsing the pitch sees none of these rows, so an availability
-- lookup cannot be a plain select on this table. See the note in section 8.

drop policy if exists bookings_select_stakeholders on public.bookings;
create policy bookings_select_stakeholders
  on public.bookings
  for select
  to authenticated
  using (
    booked_by = (select auth.uid())
    or (select private.owns_pitch(pitch_id))
    or (team_id is not null and (select private.is_team_member(team_id)))
    or (select private.is_admin())
  );

-- Every lifecycle field is pinned to its zero value at insert time: a booking
-- is born pending, unpaid, unrefunded and unattached to any Stripe object.
-- These are pure assertions about the NEW row, which is the one thing WITH
-- CHECK can enforce soundly.
--
-- The amounts are the deliberate exception. The row exists before the
-- PaymentIntent does, so subtotal/fee/total have to be insertable, and RLS has
-- no way to prove they match pitches.hourly_rate_minor. Treat every amount on
-- a freshly inserted booking as untrusted and recompute it server-side before
-- charging; that is the checkout route's contract, not this file's.
drop policy if exists bookings_insert_self on public.bookings;
create policy bookings_insert_self
  on public.bookings
  for insert
  to authenticated
  with check (
    booked_by = (select auth.uid())
    and status = 'pending'::public.booking_status
    and payment_status = 'requires_payment'::public.payment_status
    and refunded_amount_minor = 0
    and cancelled_at is null
    and stripe_payment_intent_id is null
    and stripe_checkout_session_id is null
    and stripe_charge_id is null
    and stripe_transfer_id is null
    and application_fee_id is null
    and connected_account_id is null
    and subtotal_minor > 0
    and total_minor > 0
    and (select private.pitch_is_bookable(pitch_id))
    and (team_id is null or (select private.is_team_member(team_id)))
  );

drop policy if exists bookings_update_cancel on public.bookings;
create policy bookings_update_cancel
  on public.bookings
  for update
  to authenticated
  using (
    booked_by = (select auth.uid())
    or (select private.owns_pitch(pitch_id))
    or (select private.is_admin())
  )
  with check (
    booked_by = (select auth.uid())
    or (select private.owns_pitch(pitch_id))
    or (select private.is_admin())
  );

-- RESTRICTIVE: the only client-initiated state change on a booking is a
-- cancellation. Combined with the three-column UPDATE grant in 4.4 this means
-- a compromised user session cannot mark a booking paid, cannot alter an
-- amount, cannot attach a forged Stripe id, and cannot resurrect a cancelled
-- slot. Refunds, confirmations and completions are service_role transitions
-- driven by Stripe webhooks.
--
-- As with matches above, the WITH CHECK only sees the NEW row, so on its own it
-- also permits confirmed+paid -> cancelled. That transition frees the slot
-- immediately (bookings_no_double_booking's partial index excludes 'cancelled',
-- 0001 section 8) while payment_status stays 'succeeded' and
-- refunded_amount_minor stays 0 — because neither column is in any end-user
-- grant — leaving the row in a state no server path produces and no refund
-- owed to anybody. The USING clause therefore pins the OLD row to bookings
-- that have not yet reached Stripe. Gating on money rather than on
-- payment_status is deliberate: a booking sitting in 'awaiting_payment' with
-- payment_status 'processing' (a Checkout Session was opened and abandoned)
-- must still be cancellable, or the customer is stranded. Anything with a
-- PaymentIntent goes through the cancel route on service_role, which computes
-- the refund and writes payment_status and refunded_amount_minor together.
drop policy if exists bookings_update_cancellation_only on public.bookings;
create policy bookings_update_cancellation_only
  on public.bookings
  as restrictive
  for update
  to authenticated
  using (
    (select private.is_admin())
    or (
      status in (
        'pending'::public.booking_status,
        'awaiting_payment'::public.booking_status
      )
      and stripe_payment_intent_id is null
      and coalesce(refunded_amount_minor, 0) = 0
    )
  )
  with check (
    (select private.is_admin())
    or (
      status = 'cancelled'::public.booking_status
      and cancelled_at is not null
    )
  );

-- RESTRICTIVE: GDPR Art. 8. A minor without granted guardian consent may not
-- book. 0003 ships public.assert_consented() for exactly this and instructs
-- callers to "call this first in every booking / match-joining RPC", but
-- nothing in SQL ever calls it and no other policy or grant in this file
-- carries a consent predicate — so today the gate exists only in TypeScript
-- route handlers, which PostgREST does not go through. Keyed on booked_by
-- rather than auth.uid() so it is the subject of the booking who must be
-- consented, not whoever happens to be inserting the row.
drop policy if exists bookings_insert_requires_consent on public.bookings;
create policy bookings_insert_requires_consent
  on public.bookings
  as restrictive
  for insert
  to authenticated
  with check (
    (select private.is_admin())
    or private.has_transacting_consent(booked_by)
  );

-- No DELETE policy and no DELETE grant: bookings are financial records.

-- =============================== 5.8 matches =================================

drop policy if exists matches_select_involved on public.matches;
create policy matches_select_involved
  on public.matches
  for select
  to authenticated
  using (
    created_by = (select auth.uid())
    or (select private.can_view_match(id))
  );

drop policy if exists matches_insert_organiser on public.matches;
create policy matches_insert_organiser
  on public.matches
  for insert
  to authenticated
  with check (
    created_by = (select auth.uid())
    and status = 'scheduled'::public.match_status
    and requires_consensus = false
    and rating_applied_at is null
    and score_confirmed_at is null
    and home_score is null
    and away_score is null
    and (booking_id is null or exists (
      select 1
        from public.bookings b
       where b.id = matches.booking_id
         and (b.booked_by = (select auth.uid()) or (select private.owns_pitch(b.pitch_id)))
    ))
  );

drop policy if exists matches_update_organiser on public.matches;
create policy matches_update_organiser
  on public.matches
  for update
  to authenticated
  using ((select private.can_manage_match(id)))
  with check ((select private.can_manage_match(id)));

-- RESTRICTIVE: an organiser may reschedule or cancel, never finalize.
-- Moving a match to finalized / requires_consensus / disputed is the output of
-- the score-reconciliation pipeline, and home_score / away_score are not in the
-- column-level UPDATE grant at all, so a result can only ever enter the system
-- through score_reports.
--
-- The USING clause is what makes that stick. A WITH CHECK only ever sees the
-- NEW row, so constraining the new status alone still permits
-- finalized -> scheduled and disputed -> scheduled: the reverted match then
-- satisfies matches_delete_organiser_scheduled below and the organiser can
-- DELETE it, cascading away every score_report, consensus_approval,
-- match_anomaly_flag, player_stats and match_participants row (0001: all five
-- are ON DELETE CASCADE) while the mu/sigma movements in player_ratings, which
-- have no FK to matches, survive. So the OLD row has to be gated too, and
-- score_confirmed_at / rating_applied_at are the durable marks of a match that
-- has left the organiser's hands. Note awaiting_report is editable only while
-- unconfirmed: once apply_match_rating has stamped rating_applied_at, the
-- USING clause above stops matching and the organiser can no longer touch it.
drop policy if exists matches_update_status_limited on public.matches;
create policy matches_update_status_limited
  on public.matches
  as restrictive
  for update
  to authenticated
  using (
    (select private.is_admin())
    or (
      status in (
        'scheduled'::public.match_status,
        'live'::public.match_status,
        'awaiting_report'::public.match_status,
        'cancelled'::public.match_status
      )
      and score_confirmed_at is null
      and rating_applied_at is null
    )
  )
  with check (
    (select private.is_admin())
    or status in ('scheduled'::public.match_status, 'cancelled'::public.match_status)
  );

-- Only an unplayed, unpaid match can be deleted; anything anchored to a
-- booking is financial history and is cancelled instead.
--
-- status = 'scheduled' is not sufficient on its own: validate_score_report
-- (0005, section 3.1) refuses reports only for cancelled and finalized
-- matches, so a 'scheduled' match can already be carrying filed reports and a
-- live consensus round. Deleting it would cascade that evidence away. The
-- extra clauses say "nothing has been reported, confirmed or rated yet".
drop policy if exists matches_delete_organiser_scheduled on public.matches;
create policy matches_delete_organiser_scheduled
  on public.matches
  for delete
  to authenticated
  using (
    (select private.can_manage_match(id))
    and booking_id is null
    and status = 'scheduled'::public.match_status
    and score_confirmed_at is null
    and rating_applied_at is null
    and not (select private.match_has_score_reports(id))
  );

-- ========================== 5.9 match_participants ===========================

drop policy if exists match_participants_select_involved on public.match_participants;
create policy match_participants_select_involved
  on public.match_participants
  for select
  to authenticated
  using (
    player_id = (select auth.uid())
    or (select private.can_view_match(match_id))
  );

-- Join yourself, or be added by the organiser. is_confirmed must start false:
-- a player confirms their own attendance, nobody confirms it for them.
--
-- The self-join branch must also say WHICH matches you may join. Without a
-- predicate on match_id it reads "any authenticated user may insert themselves
-- into any match by UUID". A match_participants row carries real authority: it
-- makes private.is_match_participant() true, which is what
-- private.can_view_match() is built from, which in turn gates the SELECT
-- policies on matches, match_participants, player_stats and score_reports, the
-- INSERT policies on score_reports and consensus_approvals, and the realtime
-- read/write policies in 0006. It also enlarges the consensus electorate that
-- finalize_consensus counts. So the branch is confined to the two surfaces
-- that constitute an actual invitation, and to a match that has not yet been
-- played out. That predicate is private.match_accepts_self_join (2.12a); it has
-- to be a SECURITY DEFINER helper rather than an inline subquery on
-- public.matches, because a policy qual is evaluated as the INVOKING user and
-- matches_select_involved would hide the very match the joiner is asking about.
drop policy if exists match_participants_insert_self_or_organiser on public.match_participants;
create policy match_participants_insert_self_or_organiser
  on public.match_participants
  for insert
  to authenticated
  with check (
    (
      player_id = (select auth.uid())
      and is_confirmed = false
      and (select private.match_accepts_self_join(match_id))
    )
    or (select private.can_manage_match(match_id))
  );

-- RESTRICTIVE: the same Art. 8 gate as on bookings. Joining a match is the
-- other transacting surface 0003's assert_consented() names, and it is equally
-- unreachable from PostgREST. Keyed on player_id: it is the person being added
-- to the line-up who needs consent, so an organiser cannot add an unconsented
-- minor either.
drop policy if exists match_participants_insert_requires_consent on public.match_participants;
create policy match_participants_insert_requires_consent
  on public.match_participants
  as restrictive
  for insert
  to authenticated
  with check (
    (select private.is_admin())
    or private.has_transacting_consent(player_id)
  );

drop policy if exists match_participants_update_self_or_organiser on public.match_participants;
create policy match_participants_update_self_or_organiser
  on public.match_participants
  for update
  to authenticated
  using (
    player_id = (select auth.uid())
    or (select private.can_manage_match(match_id))
  )
  with check (
    player_id = (select auth.uid())
    or (select private.can_manage_match(match_id))
  );

drop policy if exists match_participants_delete_self_or_organiser on public.match_participants;
create policy match_participants_delete_self_or_organiser
  on public.match_participants
  for delete
  to authenticated
  using (
    player_id = (select auth.uid())
    or (select private.can_manage_match(match_id))
  );

-- ============================ 5.10 player_ratings ============================
-- World-readable to signed-in users: mu / sigma / conservative_rating are
-- non-identifying aggregates and the leaderboard has to be able to sort the
-- whole table on idx_player_ratings_conservative. Gating this per row would
-- turn every leaderboard page into a full scan plus a per-row visibility
-- lookup, which is the pathology this whole file is written to avoid. The
-- name attached to a rating is protected by the profiles policies instead.
--
-- No INSERT / UPDATE / DELETE policy and no write grant: mu and sigma are
-- written exclusively by the TrueSkill update running as service_role. A user
-- who could edit their own rating row would own the leaderboard outright.

drop policy if exists player_ratings_select_all on public.player_ratings;
create policy player_ratings_select_all
  on public.player_ratings
  for select
  to authenticated
  using (true);

-- ============================= 5.11 player_stats =============================
-- Read-only to users. Written by the rating pipeline (service_role), which is
-- also why mu_before/mu_after and the generated rating_delta can be trusted.

drop policy if exists player_stats_select_involved on public.player_stats;
create policy player_stats_select_involved
  on public.player_stats
  for select
  to authenticated
  using (
    player_id = (select auth.uid())
    or (select private.can_view_match(match_id))
  );

-- ============================ 5.12 score_reports =============================
-- Append-only, one row per reporter per match (score_reports_unique). Nobody
-- can edit or withdraw a report after the fact, so a disagreement between two
-- sides is durable evidence and not just a question of who wrote last.

drop policy if exists score_reports_select_involved on public.score_reports;
create policy score_reports_select_involved
  on public.score_reports
  for select
  to authenticated
  using (
    reported_by = (select auth.uid())
    or (select private.can_view_match(match_id))
  );

drop policy if exists score_reports_insert_participant on public.score_reports;
create policy score_reports_insert_participant
  on public.score_reports
  for insert
  to authenticated
  with check (
    reported_by = (select auth.uid())
    and (
      (select private.is_match_participant(match_id))
      or (select private.can_manage_match(match_id))
    )
  );

-- ========================= 5.13 match_anomaly_flags ==========================
-- Deliberately NOT visible to ordinary participants. Showing a player the
-- anomaly score and reason codes computed about their own result hands a
-- cheater the model's decision boundary. Organisers, the hosting venue and
-- admins can see it; nobody can write it.

drop policy if exists match_anomaly_flags_select_managers on public.match_anomaly_flags;
create policy match_anomaly_flags_select_managers
  on public.match_anomaly_flags
  for select
  to authenticated
  using ((select private.can_manage_match(match_id)));

-- ========================= 5.14 consensus_approvals ==========================
-- Append-only signed votes. payload_digest / nonce / signature are supplied by
-- the server round-trip; the policy only guarantees a vote is cast by a real
-- participant, as themselves, exactly once (consensus_approvals_unique).

drop policy if exists consensus_approvals_select_involved on public.consensus_approvals;
create policy consensus_approvals_select_involved
  on public.consensus_approvals
  for select
  to authenticated
  using (
    approver_id = (select auth.uid())
    or (select private.can_view_match(match_id))
  );

drop policy if exists consensus_approvals_insert_participant on public.consensus_approvals;
create policy consensus_approvals_insert_participant
  on public.consensus_approvals
  for insert
  to authenticated
  with check (
    approver_id = (select auth.uid())
    and (select private.is_match_participant(match_id))
  );

-- ============================ 5.15 venue_payouts =============================
-- Read-only mirror of Stripe payouts, scoped to the owning venue. Written only
-- by the payout.* webhook handlers on service_role.

drop policy if exists venue_payouts_select_owner on public.venue_payouts;
create policy venue_payouts_select_owner
  on public.venue_payouts
  for select
  to authenticated
  using (
    (select private.owns_venue(venue_id))
    or (select private.is_admin())
  );

-- ============================ 5.16 notifications =============================
-- Owner only, for every command. user_id = (select auth.uid()) is hoisted to
-- an InitPlan and served by idx_notifications_user_id / the unread partial
-- index, which matters because this table is streamed over Realtime and its
-- policy is therefore evaluated on every change event, not just on reads.
--
-- No INSERT policy: a user must not be able to fabricate a notification for
-- themselves or anyone else. The server creates them on service_role.

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
  on public.notifications
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own
  on public.notifications
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own
  on public.notifications
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- ============ 5.17 stripe_events / audit_log / parental_consent_requests =====
-- Intentionally empty. See the rationale in 4.8. RLS is enabled and forced
-- with zero policies, so these three tables are invisible and immutable to
-- anon and authenticated; service_role bypasses RLS and is the only path in.

-- ======================= 5.18 storage — the `avatars` bucket ==================
-- The only bucket the product uses, and the only storage policies that exist.
--
-- `components/account/avatar-upload.tsx` sends the file straight from the
-- browser to Storage with the anon key and chooses the object key itself, so
-- the key is caller-controlled and storage RLS is the only thing between a
-- signed-in user and overwriting someone else's photo.
-- `app/api/account/route.ts` only validates the URL it is later handed; it
-- never sees the upload.
--
-- `public = true` is load-bearing. That route re-validates the object with an
-- unauthenticated HEAD on the `/storage/v1/object/public/avatars/...` URL, and
-- the component reads the URL back with `getPublicUrl()`. Against a private
-- bucket every avatar PATCH would fail with "That photo is no longer
-- available."
--
-- The limits are the same numbers the route and the component enforce (2 MiB;
-- JPEG/PNG/WebP). Declaring them on the bucket means Storage rejects an
-- oversized or wrong-typed upload even when the client-side file-picker checks
-- are bypassed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Writes are scoped to `<auth.uid()>/<filename>`, which is exactly the key shape
-- the upload component builds. `(storage.foldername(name))[1]` is the first path
-- segment, so a user may only create, replace or delete objects inside a folder
-- named for their own id. `(select auth.uid())` for the InitPlan-hoist reason
-- section 8 explains.
drop policy if exists avatars_insert_own_folder on storage.objects;
create policy avatars_insert_own_folder
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_update_own_folder on storage.objects;
create policy avatars_update_own_folder
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_delete_own_folder on storage.objects;
create policy avatars_delete_own_folder
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Reads are open, matching `public = true`. Avatars are rendered on match
-- rosters and player pages by clients that may not be signed in, and the HEAD
-- re-check in `app/api/account/route.ts` carries no credentials at all. The
-- folder segment is a user id that is already the primary key of a readable
-- `profiles` row and the filename is a random UUID, so the key discloses
-- nothing a reader did not already have.
drop policy if exists avatars_select_public on storage.objects;
create policy avatars_select_public
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'avatars');

-- -----------------------------------------------------------------------------
-- 6. Realtime note
--
-- Supabase Realtime evaluates the SELECT policy of the subscribing role for
-- every change event, not just for reads. That makes notifications_select_own
-- and bookings_select_stakeholders hot paths on the write side too, which is
-- the other reason the hoistable disjunct is written first in both: on a
-- change event the policy is evaluated against a single row, so an InitPlan
-- that resolves to an index-backed equality is the difference between a
-- constant-time check and a helper round trip per event.
--
-- Adding a table to supabase_realtime does not relax its policies — a client
-- only receives events for rows its SELECT policy already admits. The three
-- policy-less tables in 4.8 must never be added to the publication regardless.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 7. Indexes the policies depend on that 0001 did not already provide.
--
-- Rule applied: every column compared inside a policy or inside a helper is
-- either indexed or the leading column of a composite index. 0001 covered the
-- single-column FK cases; what is missing is the composite/partial shapes that
-- the helper predicates actually probe.
-- -----------------------------------------------------------------------------

-- private.is_team_member / is_team_captain / shares_team_with all probe
-- (player_id, team_id) among ACTIVE memberships. 0001 has idx_team_members_
-- player_id (all rows) and idx_team_members_active on (team_id) — neither can
-- serve "my active row in this team" as an index-only lookup.
create index if not exists idx_team_members_player_active
  on public.team_members (player_id, team_id)
  where left_at is null;

-- private.is_team_captain's second branch. Partial on the two write-capable
-- roles so the index stays tiny relative to the table.
create index if not exists idx_team_members_captains
  on public.team_members (team_id, player_id)
  where left_at is null
    and role in ('captain'::public.team_member_role, 'vice_captain'::public.team_member_role);

-- private.is_match_participant / the match_participants self policies probe
-- (player_id, match_id). match_participants_unique already covers
-- (match_id, player_id); this is the other direction.
create index if not exists idx_match_participants_player_match
  on public.match_participants (player_id, match_id);

-- profiles_select_self_or_visible's third disjunct is entirely row-local, so a
-- partial index on exactly that predicate turns "list discoverable players"
-- into an index scan instead of a filter over every profile.
create index if not exists idx_profiles_discoverable
  on public.profiles (city, display_name)
  where deleted_at is null
    and is_minor is not true
    and profile_visibility in ('public', 'members');

-- private.owns_pitch joins pitches -> venues and filters on venues.owner_id.
-- idx_venues_owner_id exists; this makes the venues side an index-only lookup.
create index if not exists idx_venues_owner_active
  on public.venues (owner_id, is_active);

-- private.pitch_is_bookable filters active pitches by venue. 0001's
-- idx_pitches_venue_active is (venue_id, is_active); this partial form is
-- narrower for the "is this specific pitch bookable" probe.
create index if not exists idx_pitches_active_venue
  on public.pitches (id, venue_id)
  where is_active;

-- bookings_select_stakeholders' team branch filters team_id and skips NULLs.
create index if not exists idx_bookings_team_not_null
  on public.bookings (team_id, created_at desc)
  where team_id is not null;

-- score_reports / consensus_approvals self-branches.
create index if not exists idx_score_reports_reporter_match
  on public.score_reports (reported_by, match_id);

create index if not exists idx_consensus_approvals_approver_match
  on public.consensus_approvals (approver_id, match_id);

-- player_stats_select_involved leads with player_id; 0001's
-- idx_player_stats_player_created is (player_id, created_at desc) and already
-- serves it. No extra index needed here — noted so the omission reads as a
-- decision rather than an oversight.

-- -----------------------------------------------------------------------------
-- 8. Verifying the InitPlan hoist actually happened
--
-- The hoist is what this file is built around, so check for it rather than
-- assuming it.
-- Run the block below in the SQL editor (psql needs the same GUCs set, which is
-- how PostgREST impersonates a user):
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","user_role":"player"}';
--
--   explain (analyze, buffers, verbose)
--   select id, time_range, status from public.bookings where pitch_id = '<some-pitch-uuid>';
--
--   rollback;
--
-- A good plan has the auth call as an InitPlan, evaluated once, with the policy
-- qual reduced to a constant comparison:
--
--   Index Scan using idx_bookings_pitch_id on public.bookings
--     Index Cond: (bookings.pitch_id = '...'::uuid)
--     Filter: ((bookings.booked_by = $0) OR (SubPlan 2) OR ...)
--     InitPlan 1 (returns $0)
--       ->  Result
--             Output: auth.uid()
--
-- A regression has no InitPlan line at all, and uid() appears inside the
-- Filter, meaning it is being called once per row:
--
--   Seq Scan on public.bookings
--     Filter: ((auth.uid() = bookings.booked_by) OR ...)
--
-- If you ever see the second shape, someone dropped the (select ...) wrapper.
-- The same check on a policy whose only qual is hoistable is even starker:
--
--   explain (analyze, buffers) select * from public.notifications;
--   -- expect: Index Scan using idx_notifications_user_id
--   --           Index Cond: (user_id = $0)     <- the hoist, doing real work
--
-- To confirm a helper is not being re-evaluated per row, compare
-- "actual rows" on the SubPlan node against loops=1 on the InitPlan node, and
-- watch total runtime as the table grows; correlated helpers such as
-- (select private.owns_pitch(pitch_id)) legitimately show loops > 1, which is
-- why they are always ORed AFTER the hoistable disjunct.
--
-- KNOWN GAP, by design: bookings_select_stakeholders hides other people's
-- bookings, so a public availability grid cannot be built from
-- `select time_range from bookings`. Expose free/busy through a
-- SECURITY DEFINER RPC that returns only anonymised tstzrange values, or
-- compute it in a route handler on createAdminClient(). Do not relax this
-- policy to make the calendar easier.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 9. Verification — must return zero rows.
--
-- Any table listed here is a hole: RLS off, FORCE off, or enabled-but-orphaned
-- (enabled with no policy and no deliberate service_role-only justification).
-- The three intentionally policy-less tables are excluded by name.
-- -----------------------------------------------------------------------------

select
  c.relname                                        as table_name,
  c.relrowsecurity                                 as rls_enabled,
  c.relforcerowsecurity                            as rls_forced,
  (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count,
  case
    when not c.relrowsecurity      then 'RLS DISABLED'
    when not c.relforcerowsecurity then 'RLS NOT FORCED'
    else 'RLS ENABLED BUT NO POLICIES'
  end                                              as problem
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and (
    c.relrowsecurity is false
    or c.relforcerowsecurity is false
    or (
      not exists (select 1 from pg_policy p where p.polrelid = c.oid)
      and c.relname not in ('stripe_events', 'audit_log', 'parental_consent_requests')
    )
  )
order by c.relname;

-- Companion audit — should also return zero rows. Finds any policy that calls
-- auth.* or a private helper without the scalar-subquery wrapper, which is the
-- regression section 8 warns about.
--
-- It works on the deparsed expression. A wrapped call renders as
--   ( SELECT auth.uid() AS uid)
-- and a bare one as
--   auth.uid()
-- so every *wrapped* occurrence is also a *total* occurrence preceded by
-- SELECT. If the two counts differ, at least one call is naked.
--
-- regexp_count is used rather than a negative lookbehind because PostgreSQL's
-- regex engine (POSIX ARE) has no lookbehind at all — writing the "obvious"
-- (?<!...) form here would fail to compile.
with policy_expr as (
  select
    c.relname                                            as table_name,
    pol.polname                                          as policy_name,
    coalesce(pg_get_expr(pol.polqual,      pol.polrelid), '')
      || ' ' ||
    coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')  as expr
  from pg_policy pol
  join pg_class     c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
)
select
  table_name,
  policy_name,
  total_calls,
  wrapped_calls,
  total_calls - wrapped_calls as unwrapped_calls,
  expr
from (
  select
    table_name,
    policy_name,
    expr,
    regexp_count(expr, '(auth\.(uid|jwt|role)\(\)|private\.)')          as total_calls,
    regexp_count(expr, 'SELECT +(auth\.(uid|jwt|role)\(\)|private\.)')  as wrapped_calls
  from policy_expr
) counted
where total_calls <> wrapped_calls
order by table_name, policy_name;

-- =============================================================================
-- End of 0002_rls.sql
-- =============================================================================
