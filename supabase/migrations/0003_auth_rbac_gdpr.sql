-- =============================================================================
-- OnPitch — 0003_auth_rbac_gdpr.sql
--
-- Auth wiring, RBAC claims and GDPR compliance, implemented in the database so
-- that no application bug can route around it.
--
--   1. auth.users -> public.profiles provisioning (public.handle_new_user)
--   2. RBAC in the JWT (public.custom_access_token_hook)
--   3. GDPR Art. 8 age gating (minor privacy lock + verifiable parental consent)
--   4. GDPR Art. 15/17/20 data-subject rights (export / erasure)
--   5. Accountability trail (public.log_audit + role/consent audit triggers)
--
-- Conventions inherited from 0001_schema.sql:
--   * Every function declares `set search_path = ''` and fully schema-qualifies
--     identifiers. Consequently pgcrypto is reached as extensions.digest /
--     extensions.gen_random_bytes.
--   * Money is integer minor units. Timestamps are timestamptz.
--   * Anything auth-derived inside a predicate is wrapped in a scalar subquery,
--     e.g. (select auth.uid()), so Postgres evaluates it once as an initPlan.
--
-- Idempotent: safe to re-run.
-- =============================================================================

set search_path = public, extensions;

-- =============================================================================
-- 0. Internal helpers (private schema, not part of the public API surface)
-- =============================================================================

-- Length-independent-ish bytea comparison. Both operands here are 32-byte
-- SHA-256 digests, so the loop always runs a fixed 32 iterations and the
-- runtime does not vary with the position of the first differing byte.
create or replace function private.bytea_ct_eq(a bytea, b bytea)
returns boolean
language plpgsql
immutable
set search_path = ''
as $bytea_ct_eq$
declare
  v_diff integer := 0;
  v_len  integer;
  i      integer;
begin
  if a is null or b is null then
    return false;
  end if;

  v_len := octet_length(a);
  if v_len <> octet_length(b) then
    v_diff := 1;                       -- guaranteed mismatch, but keep walking
    v_len  := least(v_len, octet_length(b));
  end if;

  for i in 0 .. v_len - 1 loop
    v_diff := v_diff | (get_byte(a, i) # get_byte(b, i));
  end loop;

  return v_diff = 0;
end;
$bytea_ct_eq$;

comment on function private.bytea_ct_eq(bytea, bytea) is
  'Constant-time-ish bytea equality used to compare parental-consent token digests. Never short-circuits on the first differing byte.';

revoke all on function private.bytea_ct_eq(bytea, bytea) from public;

-- =============================================================================
-- 1. Age helper
-- =============================================================================

-- Whole years elapsed since d, as of today. NULL date_of_birth yields NULL,
-- which every caller treats as "age unknown".
--
-- NOTE: this mirrors private.is_minor_dob() from 0001 (under 16 = minor, the
-- GDPR Art. 8 digital-consent age in Turkey and most of the EU) but is STABLE
-- rather than IMMUTABLE, so it is the correct helper for triggers and RPCs and
-- must not be used in a generated column, index or check constraint.
create or replace function public.age_years(d date)
returns integer
language sql
stable
set search_path = ''
as $age_years$
  select case
           when d is null then null
           else extract(year from age(current_date, d))::integer
         end;
$age_years$;

comment on function public.age_years(date) is
  'Whole years between d and current_date; NULL when d is NULL. STABLE — the runtime counterpart of the IMMUTABLE private.is_minor_dob() that backs profiles.is_minor.';

-- =============================================================================
-- 2. Accountability trail — public.log_audit
-- =============================================================================

-- Writes one row to public.audit_log. SECURITY DEFINER so callers never need
-- INSERT on the (admin-only) audit table, and so a trigger firing under a
-- restricted role can still record.
--
-- actor_id is taken from the JWT. It is deliberately NOT a parameter: callers
-- must not be able to attribute an action to somebody else. When the caller is
-- the service role (no JWT) or the acting profile no longer exists, actor_id is
-- left NULL rather than violating the FK.
create or replace function public.log_audit(
  p_action      text,
  p_entity_type text  default null,
  p_entity_id   uuid  default null,
  p_metadata    jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $log_audit$
declare
  v_actor uuid;
  v_id    bigint;
begin
  if p_action is null or btrim(p_action) = '' then
    raise exception 'log_audit: p_action is required'
      using errcode = '22004';
  end if;

  select p.id
    into v_actor
    from public.profiles p
   where p.id = (select auth.uid());

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (v_actor, btrim(p_action), p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$log_audit$;

comment on function public.log_audit(text, text, uuid, jsonb) is
  'Appends a row to public.audit_log (GDPR Art. 5(2) accountability). actor_id is derived from the JWT, never supplied by the caller. service_role only.';

-- =============================================================================
-- 3. auth.users -> public.profiles provisioning
-- =============================================================================

-- AFTER INSERT ON auth.users. Creates the paired public.profiles row from
-- new.raw_user_meta_data (the `options.data` blob a client passes to
-- supabase.auth.signUp).
--
-- SECURITY: raw_user_meta_data is fully client-controlled. The requested role
-- is therefore an allow-list of exactly {'player','venue_owner'} and everything
-- else — including a literal 'admin' — is coerced to 'player'. Admin is only
-- ever granted out-of-band by an operator using the service role.
--
-- The visibility switches (location_sharing_enabled, profile_visibility) are
-- intentionally not read from metadata: they default to the private-by-default
-- values in 0001 and, for minors, are hard-locked by
-- public.enforce_minor_privacy() below.
--
-- marketing_opt_in is the one exception, and it IS read from metadata, because
-- it records an affirmative act of consent the subject performed at the point
-- of collection (GDPR Art. 4(11) / Art. 7) rather than a default the platform
-- gets to choose. If it were dropped here there would be nowhere else it is
-- ever written, so a ticked box on the signup form would be silently discarded
-- and the record of consent lost. It stays false unless the metadata says
-- otherwise, malformed values fall back to false, and for a minor
-- public.enforce_minor_privacy() (a BEFORE trigger, so it runs first) forces
-- it back to false regardless of what was sent.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $handle_new_user$
declare
  v_meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_requested text;
  v_role      public.app_role := 'player';
  v_dob       date;
  v_full_name text;
  v_display   text;
  v_marketing boolean := false;
begin
  -- --- role: allow-list, never trust the client -----------------------------
  v_requested := lower(btrim(coalesce(v_meta ->> 'role', v_meta ->> 'requested_role', '')));
  if v_requested = 'venue_owner' then
    v_role := 'venue_owner'::public.app_role;
  else
    v_role := 'player'::public.app_role;   -- covers '', 'player', 'admin', junk
  end if;

  -- --- date of birth: never let a malformed string abort the signup ---------
  begin
    v_dob := nullif(btrim(coalesce(v_meta ->> 'date_of_birth', v_meta ->> 'dob', '')), '')::date;
  exception
    when others then
      v_dob := null;
  end;
  if v_dob is not null and v_dob <= date '1900-01-01' then
    v_dob := null;                          -- would trip profiles_dob_sane_check
  end if;

  -- --- the 13 floor -----------------------------------------------------------
  -- MINIMUM_SIGNUP_AGE in @/lib/gdpr is enforced only in the browser
  -- (components/auth/age-gate.tsx), and supabase.auth.signUp() is a direct
  -- client call, so nothing server-side has ever rejected an under-13 account.
  -- This trigger must never raise. Its contract is that a signup cannot fail
  -- because of what is (or is not) in the metadata, and a raise here surfaces
  -- as an opaque GoTrue 500 rather than as an age message. So the
  -- birth date is discarded and the attempt is recorded instead. A NULL
  -- date_of_birth is a blocking state in public.assert_consented() below, so
  -- such an account cannot book or join a match; it is not a silent pass.
  if v_dob is not null and public.age_years(v_dob) < 13 then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      null, 'profile.signup_underage', 'profiles', new.id,
      jsonb_build_object('reason', 'declared age below MINIMUM_SIGNUP_AGE (13)')
    );
    v_dob := null;
  end if;

  -- --- marketing consent: opt-IN only, and never let junk abort the signup --
  begin
    v_marketing := coalesce((v_meta ->> 'marketing_opt_in')::boolean, false);
  exception
    when others then
      v_marketing := false;
  end;

  v_full_name := nullif(btrim(coalesce(v_meta ->> 'full_name', v_meta ->> 'name', '')), '');
  v_display   := nullif(btrim(coalesce(v_meta ->> 'display_name',
                                       v_meta ->> 'username',
                                       v_full_name,
                                       split_part(coalesce(new.email::text, ''), '@', 1))), '');

  -- Only id / email / raw_user_meta_data are touched on auth.users: this trigger
  -- must never break signup because a GoTrue column moved.
  insert into public.profiles (
    id, email, full_name, display_name, avatar_url, role, date_of_birth, phone, city,
    marketing_opt_in
  )
  values (
    new.id,
    nullif(btrim(coalesce(new.email::text, '')), ''),
    v_full_name,
    v_display,
    nullif(btrim(coalesce(v_meta ->> 'avatar_url', v_meta ->> 'picture', '')), ''),
    v_role,
    v_dob,
    nullif(btrim(coalesce(v_meta ->> 'phone', '')), ''),
    nullif(btrim(coalesce(v_meta ->> 'city', '')), ''),
    v_marketing
  )
  on conflict (id) do nothing;

  -- Signup itself is auditable; auth.uid() is not yet populated at this point
  -- (the JWT is minted after the transaction commits), so attribute the action
  -- to the new subject directly instead of going through public.log_audit().
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    new.id,
    'auth.user_provisioned',
    'profiles',
    new.id,
    jsonb_build_object(
      'assigned_role',  v_role,
      'requested_role', nullif(v_requested, ''),
      'role_coerced',   (v_requested is not null and v_requested <> '' and v_requested <> v_role::text),
      'has_dob',        (v_dob is not null)
    )
  );

  return new;
end;
$handle_new_user$;

comment on function public.handle_new_user() is
  'AFTER INSERT ON auth.users: provisions public.profiles from raw_user_meta_data. Client-supplied roles are allow-listed to player|venue_owner; admin can never be self-assigned.';

do $trg_new_user$
begin
  if to_regclass('auth.users') is not null then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created
               after insert on auth.users
               for each row execute function public.handle_new_user()';
  end if;
end
$trg_new_user$;

-- =============================================================================
-- 4. RBAC in the JWT — Supabase custom access token hook
-- =============================================================================

-- Injects the authorization-relevant profile facts into every access token so
-- that middleware / RSC can branch without a round trip:
--
--   claims.user_role               -> 'admin' | 'venue_owner' | 'player'
--   claims.is_minor                -> boolean
--   claims.parental_consent_status -> 'not_required'|'pending'|'granted'|'revoked'
--
-- The claims are a cache, refreshed only when the token is (re)issued. They are
-- correct for routing and UI, but every privileged mutation must still be
-- re-checked against public.profiles by RLS — a role revoked mid-session stays
-- in the old JWT until it expires.
--
-- SECURITY DEFINER: RLS is enabled on public.profiles and this migration's
-- owner (postgres) has BYPASSRLS, so the hook can read the row without the RLS
-- migration having to carve out a supabase_auth_admin policy. The
-- `grant select on public.profiles to supabase_auth_admin` below is kept anyway
-- so the function still works if it is ever flipped to SECURITY INVOKER, but in
-- that case the RLS migration must also add a `for select to supabase_auth_admin
-- using (true)` policy.
--
-- The body can never raise: a failure here would make GoTrue unable to mint
-- tokens and lock every user out, so unexpected errors return the event
-- untouched (the token is then issued without the custom claims).
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $custom_access_token_hook$
declare
  v_user_id uuid;
  v_role    public.app_role;
  v_minor   boolean;
  v_consent public.consent_status;
  v_claims  jsonb;
begin
  v_user_id := nullif(event ->> 'user_id', '')::uuid;
  v_claims  := coalesce(event -> 'claims', '{}'::jsonb);

  select p.role,
         coalesce(p.is_minor, false),
         p.parental_consent_status
    into v_role, v_minor, v_consent
    from public.profiles p
   where p.id = v_user_id;

  if not found then
    -- No profile yet (or it was hard-deleted): fail closed to the least
    -- privileged role rather than omitting the claim entirely, so downstream
    -- code never has to treat "claim missing" as a special case.
    v_role    := 'player'::public.app_role;
    v_minor   := false;
    v_consent := 'not_required'::public.consent_status;
  end if;

  v_claims := jsonb_set(v_claims, '{user_role}',               to_jsonb(v_role::text),    true);
  v_claims := jsonb_set(v_claims, '{is_minor}',                to_jsonb(v_minor),         true);
  v_claims := jsonb_set(v_claims, '{parental_consent_status}', to_jsonb(v_consent::text), true);

  return jsonb_set(event, '{claims}', v_claims, true);
exception
  when others then
    return event;
end;
$custom_access_token_hook$;

comment on function public.custom_access_token_hook(jsonb) is
  'Supabase Auth "Customize Access Token (JWT) Claims" hook. Adds user_role, is_minor and parental_consent_status claims from public.profiles. Executable by supabase_auth_admin only.';

-- -----------------------------------------------------------------------------
-- Enabling the hook
-- -----------------------------------------------------------------------------
-- Local / CI — supabase/config.toml:
--
--     [auth.hook.custom_access_token]
--     enabled = true
--     uri = "pg-functions://postgres/public/custom_access_token_hook"
--
-- Hosted — Dashboard > Authentication > Hooks > "Customize Access Token (JWT)
-- Claims" > type "Postgres" > schema `public` > function
-- `custom_access_token_hook`, then Enable.
--
-- Reading the claims client-side (the JWT payload, not the profile row):
--     const { data: { session } } = await supabase.auth.getSession()
--     const claims = JSON.parse(atob(session!.access_token.split('.')[1]))
--     claims.user_role // 'admin' | 'venue_owner' | 'player'
--
-- Existing sessions keep their old claims until the access token is refreshed
-- (default 1h) — call supabase.auth.refreshSession() after changing a role.
-- -----------------------------------------------------------------------------

-- Grants Supabase requires for the hook. supabase_auth_admin does not exist on
-- a vanilla PostgreSQL cluster, hence the guard.
do $hook_grants$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant usage on schema public to supabase_auth_admin';
    execute 'grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin';
    execute 'grant select on table public.profiles to supabase_auth_admin';
  end if;
end
$hook_grants$;

revoke all on function public.custom_access_token_hook(jsonb) from public;

do $hook_revokes$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.custom_access_token_hook(jsonb) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.custom_access_token_hook(jsonb) from anon';
  end if;
end
$hook_revokes$;

-- =============================================================================
-- 5. GDPR Art. 8 — minor privacy lock
-- =============================================================================

-- BEFORE INSERT OR UPDATE ON public.profiles.
--
-- Why a trigger and not just the profiles_minor_privacy_locked_check constraint
-- from 0001: the constraint rejects an unsafe row, the trigger explains *why*
-- and, on INSERT, silently repairs it so a signup can never fail because a
-- client sent marketing_opt_in = true.
--
-- profiles.is_minor is a STORED generated column, and generated
-- columns are computed AFTER before-row triggers — new.is_minor is NULL in
-- here. Minority is therefore derived from new.date_of_birth using the very
-- same predicate that private.is_minor_dob() applies, inlined character for
-- character so the trigger and the generated column can never disagree within
-- a statement. It is inlined rather than called because this trigger is
-- SECURITY INVOKER: a helper call would additionally depend on the writing
-- role holding EXECUTE.
--
-- A NULL date_of_birth means "age unknown" and is not treated as a minor here,
-- to stay consistent with is_minor, so none of the locks below apply to such a
-- row. public.assert_consented() closes that gap on the transacting path: it
-- blocks a NULL date_of_birth just as it blocks a stated age under 16, unless
-- consent is already 'granted'.
create or replace function public.enforce_minor_privacy()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $enforce_minor_privacy$
declare
  v_is_minor boolean;
begin
  v_is_minor := coalesce(
    new.date_of_birth > (current_date - interval '16 years')::date,
    false
  );

  if v_is_minor then
    -- On UPDATE, an explicit attempt to *turn on* a locked switch is a hard
    -- error so the client learns the flag was rejected. A value that was
    -- already unsafe (e.g. an adult profile whose birth date is being corrected
    -- downwards) is silently re-locked instead, so legitimate data fixes work.
    if tg_op = 'UPDATE' then
      if new.location_sharing_enabled
         and new.location_sharing_enabled is distinct from old.location_sharing_enabled then
        raise exception 'Location sharing cannot be enabled for a user under 16 (GDPR Art. 8).'
          using errcode = '42501',
                hint    = 'This switch stays off until the account holder turns 16.';
      end if;

      if new.profile_visibility = 'public'
         and new.profile_visibility is distinct from old.profile_visibility then
        raise exception 'Profile visibility cannot be set to public for a user under 16 (GDPR Art. 8).'
          using errcode = '42501',
                hint    = 'Allowed values for a minor are members or private.';
      end if;

      if new.marketing_opt_in
         and new.marketing_opt_in is distinct from old.marketing_opt_in then
        raise exception 'Marketing consent cannot be recorded for a user under 16 (GDPR Art. 8).'
          using errcode = '42501',
                hint    = 'This switch stays off until the account holder turns 16.';
      end if;
    end if;

    -- Force the safe values regardless of how the row got here.
    new.location_sharing_enabled := false;
    new.marketing_opt_in         := false;
    if new.profile_visibility is distinct from 'members' then
      new.profile_visibility := 'private';
    end if;

    -- A minor account is not usable until a guardian has verified consent.
    if new.parental_consent_status = 'not_required'::public.consent_status then
      new.parental_consent_status := 'pending'::public.consent_status;
      new.parental_consent_at     := null;
    end if;

  else
    -- Aged out (or a corrected birth date): drop a consent requirement that is
    -- no longer legally necessary. granted / revoked are kept as evidence.
    -- OLD is only touched inside a TG_OP guard — PL/pgSQL raises
    -- "record old is not assigned yet" if it is referenced on INSERT.
    if tg_op = 'INSERT' then
      if new.parental_consent_status = 'pending'::public.consent_status then
        new.parental_consent_status := 'not_required'::public.consent_status;
      end if;
    elsif new.parental_consent_status = 'pending'::public.consent_status
          and old.parental_consent_status = 'pending'::public.consent_status
          -- ...but ONLY when the row genuinely aged out, i.e. the birth date
          -- did not move. Without this test a single UPDATE that rewrites
          -- date_of_birth to an adult value launders a pending consent into
          -- 'not_required' in the same statement, and every privacy lock above
          -- lifts with it (is_minor is a STORED generated column and is
          -- recomputed on that very UPDATE). date_of_birth is absent from the
          -- end-user UPDATE grant in 0002 for the same reason; this is the
          -- second lock, so the laundering stays closed even if that grant is
          -- ever widened. A real correction re-enters the consent flow.
          and old.date_of_birth is not distinct from new.date_of_birth then
      new.parental_consent_status := 'not_required'::public.consent_status;
    end if;
  end if;

  return new;
end;
$enforce_minor_privacy$;

comment on function public.enforce_minor_privacy() is
  'BEFORE INSERT/UPDATE on profiles: hard-locks location_sharing_enabled, profile_visibility and marketing_opt_in for under-16 accounts and moves consent to pending. Raises 42501 on an explicit attempt to unlock.';

drop trigger if exists trg_profiles_enforce_minor_privacy on public.profiles;
create trigger trg_profiles_enforce_minor_privacy
  before insert or update on public.profiles
  for each row execute function public.enforce_minor_privacy();

-- Supports the "open consent requests for this minor" rate-limit lookup below.
create index if not exists idx_parental_consent_minor_open
  on public.parental_consent_requests (minor_id, expires_at)
  where status = 'pending'::public.consent_status;

-- =============================================================================
-- 6. GDPR Art. 8 — verifiable parental consent
-- =============================================================================

-- Issues a consent token for the calling minor's guardian.
--
-- The raw token is returned exactly once, to the caller, so the API layer can
-- put it in the guardian email. Only digest(token,'sha256') is persisted, so a
-- database leak does not yield usable consent links.
create or replace function public.request_parental_consent(
  p_guardian_email text,
  p_guardian_name  text default null
)
returns table (request_id uuid, raw_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $request_parental_consent$
declare
  v_uid       uuid := (select auth.uid());
  v_dob       date;
  v_deleted   timestamptz;
  v_open      integer;
  v_token     text;
  v_id        uuid;
  v_email     text := lower(btrim(coalesce(p_guardian_email, '')));
  v_name      text := nullif(btrim(coalesce(p_guardian_name, '')), '');
begin
  if v_uid is null then
    raise exception 'request_parental_consent: authentication required'
      using errcode = '42501';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise exception 'A valid guardian email address is required.'
      using errcode = '22023';
  end if;

  select p.date_of_birth, p.deleted_at
    into v_dob, v_deleted
    from public.profiles p
   where p.id = v_uid;

  if not found then
    raise exception 'Profile % does not exist.', v_uid using errcode = '42501';
  end if;
  if v_deleted is not null then
    raise exception 'This account is closed.' using errcode = '42501';
  end if;
  if coalesce(public.age_years(v_dob), 99) >= 16 then
    raise exception 'Parental consent is only required for accounts under 16.'
      using errcode = '42501';
  end if;

  -- Rate limit: at most 3 live requests per minor. Expired ones do not count,
  -- so a stuck guardian can always retry after the 7-day window lapses.
  select count(*)::integer
    into v_open
    from public.parental_consent_requests r
   where r.minor_id = v_uid
     and r.status = 'pending'::public.consent_status
     and r.revoked_at is null
     and r.expires_at > now();

  if v_open >= 3 then
    raise exception 'There are already % open parental consent requests for this account. Ask the guardian to use the most recent email, or wait for it to expire.', v_open
      using errcode = 'P0001',
            hint    = 'Consent links are valid for 7 days.';
  end if;

  -- 32 bytes of CSPRNG entropy, hex-encoded to 64 URL-safe characters.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.parental_consent_requests (minor_id, guardian_email, token_hash, expires_at)
  values (v_uid, v_email, extensions.digest(v_token, 'sha256'), now() + interval '7 days')
  returning id into v_id;

  update public.profiles p
     set guardian_email          = v_email,
         guardian_name           = coalesce(v_name, p.guardian_name),
         parental_consent_status = 'pending'::public.consent_status,
         parental_consent_at     = null
   where p.id = v_uid;

  perform public.log_audit(
    'consent.requested',
    'parental_consent_requests',
    v_id,
    jsonb_build_object(
      'minor_id',              v_uid,
      'guardian_email_domain', split_part(v_email, '@', 2),
      'expires_at',            now() + interval '7 days'
    )
  );

  return query select v_id, v_token;
end;
$request_parental_consent$;

comment on function public.request_parental_consent(text, text) is
  'GDPR Art. 8: issues a 7-day guardian consent token for the calling under-16 user. Stores only the SHA-256 digest and returns the raw token once. Max 3 open requests per minor.';

-- Redeems a consent token. Called from a route handler with the service-role
-- client, because the guardian following the emailed link is not (and must not
-- have to be) a logged-in user of the platform.
--
-- p_guardian_ip is optional; it is stored only as a per-subject-salted SHA-256
-- digest, which is evidence that a verification happened without retaining an
-- identifier. The raw token is never echoed back in the result or in any log.
create or replace function public.verify_parental_consent(
  p_raw_token   text,
  p_guardian_ip text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $verify_parental_consent$
declare
  v_digest  bytea;
  v_req_id  uuid;
  v_minor   uuid;
  v_stored  bytea;
  v_deleted timestamptz;
begin
  if p_raw_token is null or btrim(p_raw_token) = '' then
    return false;
  end if;

  v_digest := extensions.digest(btrim(p_raw_token), 'sha256');

  -- Indexed probe on the unique token_hash. The compared value is already a
  -- 32-byte digest, so the index lookup itself leaks nothing about the token.
  select r.id, r.minor_id, r.token_hash, p.deleted_at
    into v_req_id, v_minor, v_stored, v_deleted
    from public.parental_consent_requests r
    join public.profiles p on p.id = r.minor_id
   where r.token_hash = v_digest
     and r.status = 'pending'::public.consent_status
     and r.revoked_at is null
     and r.expires_at > now()
   limit 1;

  -- Authoritative comparison, deliberately non-short-circuiting.
  -- A consent link for an erased account is treated exactly like a bad token:
  -- one uniform failure, no oracle for the caller.
  if v_req_id is null
     or v_deleted is not null
     or not private.bytea_ct_eq(v_stored, v_digest) then
    return false;   -- no detail: an invalid, expired and already-used token are
                    -- indistinguishable to the caller.
  end if;

  update public.parental_consent_requests r
     set status           = 'granted'::public.consent_status,
         verified_at      = now(),
         guardian_ip_hash = case
                              when nullif(btrim(coalesce(p_guardian_ip, '')), '') is null then null
                              else extensions.digest(btrim(p_guardian_ip) || ':' || v_minor::text, 'sha256')
                            end
   where r.id = v_req_id;

  update public.profiles p
     set parental_consent_status = 'granted'::public.consent_status,
         parental_consent_at     = now()
   where p.id = v_minor;

  -- Any other still-open request for the same minor is now moot.
  update public.parental_consent_requests r
     set status     = 'revoked'::public.consent_status,
         revoked_at = now()
   where r.minor_id = v_minor
     and r.id <> v_req_id
     and r.status = 'pending'::public.consent_status;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    v_minor,
    'consent.granted',
    'parental_consent_requests',
    v_req_id,
    jsonb_build_object('minor_id', v_minor, 'verified_at', now(), 'channel', 'guardian_email_link')
  );

  insert into public.notifications (user_id, type, title, body, data)
  values (
    v_minor,
    'consent.granted',
    'Parental consent confirmed',
    'Your guardian has approved your account. You can now book pitches and join matches.',
    jsonb_build_object('requestId', v_req_id)
  );

  return true;
end;
$verify_parental_consent$;

comment on function public.verify_parental_consent(text, text) is
  'GDPR Art. 8: redeems a guardian consent token, flips profiles.parental_consent_status to granted and audits it. Returns false for any invalid/expired/used token without saying which. service_role only — the guardian is not an authenticated user.';

-- Withdraws consent (Art. 7(3)). Callable by the minor, by an admin, or by the
-- backend on behalf of the guardian (service role, auth.uid() is NULL).
create or replace function public.revoke_parental_consent(p_minor_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $revoke_parental_consent$
declare
  v_uid       uuid := (select auth.uid());
  v_caller_rl public.app_role;
  v_exists    boolean;
begin
  if p_minor_id is null then
    raise exception 'revoke_parental_consent: p_minor_id is required' using errcode = '22004';
  end if;

  if v_uid is not null then
    select p.role into v_caller_rl from public.profiles p where p.id = v_uid;
    if v_uid <> p_minor_id and coalesce(v_caller_rl, 'player'::public.app_role) <> 'admin'::public.app_role then
      raise exception 'Not allowed to revoke consent for another account.' using errcode = '42501';
    end if;
  end if;

  select true into v_exists from public.profiles p where p.id = p_minor_id;
  if not found then
    raise exception 'Profile % does not exist.', p_minor_id using errcode = '42501';
  end if;

  update public.parental_consent_requests r
     set status     = 'revoked'::public.consent_status,
         revoked_at = coalesce(r.revoked_at, now())
   where r.minor_id = p_minor_id
     and r.status in ('pending'::public.consent_status, 'granted'::public.consent_status);

  -- Re-lock the privacy switches on the way out. enforce_minor_privacy() would
  -- do this too for a current minor; setting them here keeps the behaviour
  -- correct for a revocation that lands after the subject turned 16.
  update public.profiles p
     set parental_consent_status  = 'revoked'::public.consent_status,
         parental_consent_at      = null,
         location_sharing_enabled = false,
         profile_visibility       = 'private',
         marketing_opt_in         = false
   where p.id = p_minor_id;

  -- actor_id is resolved through profiles so a JWT for a hard-deleted subject
  -- degrades to NULL instead of violating audit_log_actor_id_fkey.
  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    (select p2.id from public.profiles p2 where p2.id = v_uid),
    'consent.revoked',
    'profiles',
    p_minor_id,
    jsonb_build_object('minor_id', p_minor_id, 'by_self', (v_uid is not null and v_uid = p_minor_id))
  );

  insert into public.notifications (user_id, type, title, body, data)
  values (
    p_minor_id,
    'consent.revoked',
    'Parental consent withdrawn',
    'Booking and match features are paused until a guardian approves your account again.',
    '{}'::jsonb
  );

  return true;
end;
$revoke_parental_consent$;

comment on function public.revoke_parental_consent(uuid) is
  'GDPR Art. 7(3): withdraws guardian consent, cancels open requests and re-locks the privacy switches. Callable by the subject, an admin, or the backend.';

-- -----------------------------------------------------------------------------
-- Transaction guard
-- -----------------------------------------------------------------------------
-- Call this first in every booking / match-joining RPC:
--
--     perform public.assert_consented((select auth.uid()));
--
-- Raises 42501 (PostgREST -> HTTP 403) when the subject is under 16 and consent
-- is not 'granted'. Adults and users with granted consent fall through silently.
create or replace function public.assert_consented(p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $assert_consented$
declare
  v_dob     date;
  v_status  public.consent_status;
  v_deleted timestamptz;
begin
  if p_user is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;

  select p.date_of_birth, p.parental_consent_status, p.deleted_at
    into v_dob, v_status, v_deleted
    from public.profiles p
   where p.id = p_user;

  if not found then
    raise exception 'Profile % does not exist.', p_user using errcode = '42501';
  end if;

  if v_deleted is not null then
    raise exception 'This account is closed and cannot transact.' using errcode = '42501';
  end if;

  -- An absent birth date blocks too. `coalesce(age_years(v_dob), 99)` used to
  -- read "unknown age means adult", which is the wrong default when the only
  -- age gate is in the browser: supabase.auth.signUp() is a direct client call,
  -- so omitting date_of_birth from the metadata entirely produces a profile
  -- with a NULL DOB, is_minor false and consent 'not_required' — a minor's
  -- cheapest route around Art. 8 is to leave the field blank. Nothing else in the
  -- system requires a birth date before transacting, so it is required here.
  if (v_dob is null or public.age_years(v_dob) < 16)
     and v_status is distinct from 'granted'::public.consent_status then
    raise exception 'A guardian must approve this account before it can book or play (GDPR Art. 8). Current status: %.', v_status
      using errcode = '42501',
            hint    = 'Send a consent email with request_parental_consent(), or add your date of birth if it is missing.';
  end if;
end;
$assert_consented$;

comment on function public.assert_consented(uuid) is
  'Guard for booking/match RPCs: raises 42501 when the user is under 16 without granted parental consent, or when the account is soft-deleted.';

-- =============================================================================
-- 7. GDPR Art. 15 / 20 — data portability
-- =============================================================================

-- Returns every row the calling subject owns, as one jsonb document, in a
-- structured and machine-readable format (Art. 20(1)).
--
-- Deliberate omissions: parental_consent_requests.token_hash and
-- guardian_ip_hash, and audit_log.ip_hash. These are security artefacts about
-- the subject rather than personal data supplied by them, and exporting a live
-- token digest would weaken the consent flow.
create or replace function public.export_my_data()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $export_my_data$
declare
  v_uid uuid := (select auth.uid());
  v_doc jsonb;
begin
  if v_uid is null then
    raise exception 'export_my_data: authentication required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'export_format_version', 1,
    'generated_at',          to_jsonb(now()),
    'subject_id',            to_jsonb(v_uid),
    'legal_basis',           'GDPR Art. 15 (right of access) and Art. 20 (data portability).',
    'notes',                 'Consent token digests and IP digests are omitted: they are security artefacts, not data you provided.',

    'profile', (
      select to_jsonb(p) from public.profiles p where p.id = v_uid
    ),

    'player_rating', (
      select to_jsonb(r) from public.player_ratings r where r.player_id = v_uid
    ),

    'teams_owned', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]'::jsonb)
        from public.teams t where t.owner_id = v_uid
    ),

    'team_memberships', (
      select coalesce(jsonb_agg(to_jsonb(tm) order by tm.joined_at), '[]'::jsonb)
        from public.team_members tm where tm.player_id = v_uid
    ),

    'venues_owned', (
      select coalesce(jsonb_agg(to_jsonb(v) order by v.created_at), '[]'::jsonb)
        from public.venues v where v.owner_id = v_uid
    ),

    'bookings', (
      select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at), '[]'::jsonb)
        from public.bookings b where b.booked_by = v_uid
    ),

    'matches', (
      select coalesce(jsonb_agg(to_jsonb(m) order by m.kickoff_at), '[]'::jsonb)
        from public.matches m
       where m.created_by = v_uid
          or exists (
               select 1 from public.match_participants mp
                where mp.match_id = m.id and mp.player_id = v_uid
             )
    ),

    'match_participations', (
      select coalesce(jsonb_agg(to_jsonb(mp) order by mp.joined_at), '[]'::jsonb)
        from public.match_participants mp where mp.player_id = v_uid
    ),

    'player_stats', (
      select coalesce(jsonb_agg(to_jsonb(ps) order by ps.created_at), '[]'::jsonb)
        from public.player_stats ps where ps.player_id = v_uid
    ),

    'score_reports', (
      select coalesce(jsonb_agg(to_jsonb(sr) order by sr.reported_at), '[]'::jsonb)
        from public.score_reports sr where sr.reported_by = v_uid
    ),

    'consensus_approvals', (
      select coalesce(jsonb_agg(to_jsonb(ca) order by ca.approved_at), '[]'::jsonb)
        from public.consensus_approvals ca where ca.approver_id = v_uid
    ),

    'parental_consent_requests', (
      select coalesce(
               jsonb_agg((to_jsonb(pc) - 'token_hash' - 'guardian_ip_hash') order by pc.requested_at),
               '[]'::jsonb
             )
        from public.parental_consent_requests pc where pc.minor_id = v_uid
    ),

    'notifications', (
      select coalesce(jsonb_agg(to_jsonb(n) order by n.created_at), '[]'::jsonb)
        from public.notifications n where n.user_id = v_uid
    ),

    'audit_log', (
      select coalesce(jsonb_agg((to_jsonb(a) - 'ip_hash') order by a.created_at), '[]'::jsonb)
        from public.audit_log a where a.actor_id = v_uid
    )
  )
  into v_doc;

  perform public.log_audit(
    'gdpr.data_exported',
    'profiles',
    v_uid,
    jsonb_build_object('approx_bytes', octet_length(v_doc::text))
  );

  return v_doc;
end;
$export_my_data$;

comment on function public.export_my_data() is
  'GDPR Art. 15/20: returns every row belonging to (select auth.uid()) as one portable jsonb document, minus token/IP digests. Each call is audited.';

-- =============================================================================
-- 8. GDPR Art. 17 — erasure
-- =============================================================================

-- Why bookings are not deleted
-- ----------------------------
-- A booking is an accounting record of a paid transaction. Turkish law requires
-- it to be kept: Vergi Usul Kanunu art. 253 (5 years) and Turk Ticaret Kanunu
-- art. 82 (10 years) both mandate retention of commercial books and the vouchers
-- behind them, and Stripe must be able to reconcile a charge, application fee,
-- refund or chargeback against our records for the same period. GDPR Art. 17(3)(b)
-- exempts processing that is "necessary for compliance with a legal obligation",
-- and Art. 17(3)(e) covers the establishment or defence of legal claims, so the
-- right to erasure does not reach these rows.
--
-- What we do instead is remove the *identifying* layer: the profile is
-- soft-deleted and its direct identifiers are replaced with a deterministic
-- pseudonym derived from the (random) user id, so bookings, payouts and match
-- history stay internally consistent and auditable while no longer being
-- attributable to a named person without the erased profile row. Free-text
-- fields that can carry unexpected PII (booking notes) are cleared outright.
--
-- The auth.users row is NOT deleted here. profiles.id cascades from
-- auth.users, and bookings.booked_by is ON DELETE RESTRICT, so a hard delete
-- would either fail or take the financial records with it — the schema itself
-- enforces the retention. A scheduled job may hard-delete the auth user once the
-- retention period for that subject's last booking has elapsed.
create or replace function public.request_account_erasure()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $request_account_erasure$
declare
  v_uid       uuid := (select auth.uid());
  v_deleted   timestamptz;
  v_pseudonym text;
  v_short     text;
  v_bookings  integer;
begin
  if v_uid is null then
    raise exception 'request_account_erasure: authentication required' using errcode = '42501';
  end if;

  select p.deleted_at into v_deleted from public.profiles p where p.id = v_uid;
  if not found then
    raise exception 'Profile % does not exist.', v_uid using errcode = '42501';
  end if;
  if v_deleted is not null then
    return jsonb_build_object(
      'status',      'already_erased',
      'subject_id',  v_uid,
      'erased_at',   to_jsonb(v_deleted)
    );
  end if;

  -- Deterministic, non-reversible pseudonym. The input is the random v4 user id
  -- (122 bits of entropy) plus a domain separator, so the digest cannot be
  -- brute-forced back to an identity the way a hash of an email or phone could.
  v_pseudonym := encode(extensions.digest(v_uid::text || '|onpitch:erasure:v1', 'sha256'), 'hex');
  v_short     := left(v_pseudonym, 12);

  select count(*)::integer into v_bookings from public.bookings b where b.booked_by = v_uid;

  update public.profiles p
     set email                    = left(v_pseudonym, 32) || '@erased.invalid',
         full_name                = 'Erased user ' || v_short,
         display_name             = 'Erased user ' || v_short,
         avatar_url               = null,
         phone                    = null,
         bio                      = null,
         city                     = null,
         preferred_position       = null,
         guardian_email           = null,
         guardian_name            = null,
         date_of_birth            = null,
         location_sharing_enabled = false,
         profile_visibility       = 'private',
         marketing_opt_in         = false,
         parental_consent_status  = 'not_required'::public.consent_status,
         parental_consent_at      = null,
         last_seen_at             = null,
         deleted_at               = now()
   where p.id = v_uid;

  -- Free text written by the subject: no retention basis, cleared.
  update public.bookings b
     set notes = null
   where b.booked_by = v_uid
     and b.notes is not null;

  -- Consent evidence is kept (Art. 7(1) accountability) but de-identified: the
  -- guardian is a third party whose address we no longer need.
  update public.parental_consent_requests r
     set guardian_email = 'erased-' || v_short || '@erased.invalid',
         status         = case
                            when r.status = 'pending'::public.consent_status
                              then 'revoked'::public.consent_status
                            else r.status
                          end,
         revoked_at     = case
                            when r.status = 'pending'::public.consent_status
                              then coalesce(r.revoked_at, now())
                            else r.revoked_at
                          end
   where r.minor_id = v_uid;

  -- Transient, no legal basis to keep.
  delete from public.notifications n where n.user_id = v_uid;

  -- Best-effort session revocation so the erased account cannot keep using an
  -- access token that is still inside its TTL. Guarded: the auth schema layout
  -- is GoTrue's, not ours.
  begin
    delete from auth.sessions s where s.user_id = v_uid;
  exception
    when others then
      null;
  end;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    v_uid,
    'gdpr.erasure_completed',
    'profiles',
    v_uid,
    jsonb_build_object(
      'pseudonym_prefix',  v_short,
      'retained_bookings', v_bookings,
      'retention_basis',   'GDPR Art. 17(3)(b)/(e); VUK art. 253 (5y); TTK art. 82 (10y)'
    )
  );

  return jsonb_build_object(
    'status',                 'erased',
    'subject_id',             v_uid,
    'erased_at',              to_jsonb(now()),
    'retained_booking_count', v_bookings,
    'retention_note',         'Booking and payment records are kept in pseudonymised form for the statutory accounting retention period (VUK art. 253 / TTK art. 82) under GDPR Art. 17(3)(b).'
  );
end;
$request_account_erasure$;

comment on function public.request_account_erasure() is
  'GDPR Art. 17: soft-deletes the calling profile, pseudonymises its identifiers with a deterministic digest of the user id, clears free text, revokes sessions, and retains financial rows under the statutory accounting obligation.';

-- =============================================================================
-- 9. Audit triggers — role and consent changes
-- =============================================================================

create or replace function public.audit_profile_role_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $audit_profile_role_change$
begin
  perform public.log_audit(
    'profile.role_changed',
    'profiles',
    new.id,
    jsonb_build_object(
      'from',    old.role,
      'to',      new.role,
      'by_self', ((select auth.uid()) = new.id)
    )
  );
  return null;
end;
$audit_profile_role_change$;

create or replace function public.audit_profile_consent_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $audit_profile_consent_change$
begin
  perform public.log_audit(
    'profile.consent_status_changed',
    'profiles',
    new.id,
    jsonb_build_object(
      'from',     old.parental_consent_status,
      'to',       new.parental_consent_status,
      'is_minor', coalesce(new.is_minor, false),
      'by_self',  ((select auth.uid()) = new.id)
    )
  );
  return null;
end;
$audit_profile_consent_change$;

comment on function public.audit_profile_role_change() is
  'AFTER UPDATE OF role ON profiles: records every privilege change in audit_log.';
comment on function public.audit_profile_consent_change() is
  'AFTER UPDATE OF parental_consent_status ON profiles: records every consent transition in audit_log.';

drop trigger if exists trg_profiles_audit_role_change on public.profiles;
create trigger trg_profiles_audit_role_change
  after update of role on public.profiles
  for each row
  when (old.role is distinct from new.role)
  execute function public.audit_profile_role_change();

drop trigger if exists trg_profiles_audit_consent_change on public.profiles;
create trigger trg_profiles_audit_consent_change
  after update of parental_consent_status on public.profiles
  for each row
  when (old.parental_consent_status is distinct from new.parental_consent_status)
  execute function public.audit_profile_consent_change();

-- =============================================================================
-- 10. Grants
-- =============================================================================
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default, so every
-- function is revoked first and then handed out explicitly.
--
-- Trigger functions are intentionally granted to nobody: PostgreSQL checks
-- EXECUTE on a trigger function at CREATE TRIGGER time, not when it fires.

revoke all on function public.age_years(date)                            from public;
revoke all on function public.log_audit(text, text, uuid, jsonb)         from public;
revoke all on function public.handle_new_user()                          from public;
revoke all on function public.enforce_minor_privacy()                    from public;
revoke all on function public.request_parental_consent(text, text)       from public;
revoke all on function public.verify_parental_consent(text, text)        from public;
revoke all on function public.revoke_parental_consent(uuid)              from public;
revoke all on function public.assert_consented(uuid)                     from public;
revoke all on function public.export_my_data()                           from public;
revoke all on function public.request_account_erasure()                  from public;
revoke all on function public.audit_profile_role_change()                from public;
revoke all on function public.audit_profile_consent_change()             from public;

do $grants$
declare
  -- Callable by a logged-in end user through PostgREST /rest/v1/rpc/*.
  v_user_facing text[] := array[
    'public.age_years(date)',
    'public.request_parental_consent(text, text)',
    'public.revoke_parental_consent(uuid)',
    'public.assert_consented(uuid)',
    'public.export_my_data()',
    'public.request_account_erasure()'
  ];
  -- Backend only: the service-role key, i.e. route handlers using
  -- createAdminClient() from @/lib/supabase/admin.
  v_backend_only text[] := array[
    'public.log_audit(text, text, uuid, jsonb)',
    'public.verify_parental_consent(text, text)'
  ];
  v_fn text;
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach v_fn in array v_user_facing loop
      execute format('grant execute on function %s to authenticated', v_fn);
    end loop;
  end if;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach v_fn in array (v_user_facing || v_backend_only) loop
      execute format('grant execute on function %s to service_role', v_fn);
    end loop;
    execute 'grant usage on schema private to service_role';
  end if;
end
$grants$;

-- =============================================================================
-- 11. Post-conditions worth remembering elsewhere in the codebase
-- =============================================================================
-- * The RLS migration MUST exclude soft-deleted profiles (deleted_at is not
--   null) from every readable policy; erasure relies on it.
-- * Booking and match RPCs MUST open with
--       perform public.assert_consented((select auth.uid()));
-- * profiles.is_minor is a write-time snapshot (see 0001). A nightly job should
--   touch profiles where is_minor and public.age_years(date_of_birth) >= 16 so
--   the flag and the pending consent status clear themselves; the trigger above
--   does the rest on that write.
-- * public.custom_access_token_hook must be enabled in config.toml / the
--   dashboard or the user_role claim is absent from the JWT.
-- =============================================================================
