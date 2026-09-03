-- =============================================================================
-- OnPitch — 0001_schema.sql
-- Core schema contract: extensions, schemas, enums, tables, constraints,
-- indexes and updated_at triggers.
--
-- Scope notes:
--   * NO RLS POLICIES live here (a later migration owns them), but RLS is
--     ENABLED on every public table so the database fails closed until those
--     policies land.
--   * NO business logic beyond the updated_at touch helper and the immutable
--     minor-age predicate required by the profiles.is_minor generated column.
--   * All money is stored as integers in MINOR units (kurus/cents), suffixed
--     *_minor. Default currency is 'try'.
--   * All timestamps are timestamptz. Booking/blackout windows are tstzrange.
-- =============================================================================

set search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Schemas & extensions
-- -----------------------------------------------------------------------------

create schema if not exists extensions;

-- Internal helper namespace. Nothing here is part of the public API surface and
-- it is deliberately not exposed to anon/authenticated. Function EXECUTE is
-- checked at runtime by OID while schema USAGE is only checked during name
-- resolution, so generated columns referencing private.* keep working for every
-- role even without USAGE on the schema.
create schema if not exists private;

comment on schema private is 'Internal helper functions. Not reachable by anon/authenticated by name.';

create extension if not exists pgcrypto            with schema extensions;  -- gen_random_bytes, digest, hmac
create extension if not exists btree_gist          with schema extensions;  -- uuid equality inside GiST EXCLUDE constraints
create extension if not exists citext              with schema extensions;  -- case-insensitive email columns
create extension if not exists pg_stat_statements  with schema extensions;  -- query telemetry

revoke all on schema private from public;

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    grant usage on schema private to postgres;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema private to service_role;
  end if;
end
$grants$;

-- -----------------------------------------------------------------------------
-- 2. Enums
-- -----------------------------------------------------------------------------

do $enums$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'app_role' and n.nspname = 'public') then
    create type public.app_role as enum ('admin', 'venue_owner', 'player');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'consent_status' and n.nspname = 'public') then
    create type public.consent_status as enum ('not_required', 'pending', 'granted', 'revoked');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'booking_status' and n.nspname = 'public') then
    create type public.booking_status as enum (
      'pending', 'awaiting_payment', 'confirmed', 'cancelled', 'refunded', 'disputed', 'completed'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'payment_status' and n.nspname = 'public') then
    create type public.payment_status as enum (
      'requires_payment', 'processing', 'succeeded', 'failed', 'refunded', 'partially_refunded'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'match_status' and n.nspname = 'public') then
    create type public.match_status as enum (
      'scheduled', 'live', 'awaiting_report', 'requires_consensus', 'disputed', 'finalized', 'cancelled'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'match_format' and n.nspname = 'public') then
    create type public.match_format as enum (
      'five_a_side', 'six_a_side', 'seven_a_side', 'eight_a_side', 'eleven_a_side'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'pitch_surface' and n.nspname = 'public') then
    create type public.pitch_surface as enum ('natural_grass', 'artificial_turf', 'hybrid', 'indoor_court');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'team_member_role' and n.nspname = 'public') then
    create type public.team_member_role as enum ('captain', 'vice_captain', 'member');
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'payout_status' and n.nspname = 'public') then
    create type public.payout_status as enum ('pending', 'in_transit', 'paid', 'failed');
  end if;
end
$enums$;

-- -----------------------------------------------------------------------------
-- 3. Helper functions (touch trigger + immutable minor predicate)
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $set_updated_at$
begin
  new.updated_at := now();
  return new;
end;
$set_updated_at$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with now(). Attached to every table carrying updated_at.';

-- GDPR Art. 8: 16 is the age of digital consent in Turkey and most of the EU.
-- Declared IMMUTABLE so it may back a STORED generated column. It reads
-- current_date, so the stored value is a snapshot taken at the last write of the
-- row; the parental-consent job re-touches profiles whose date_of_birth crosses
-- the threshold. Any index over profiles.is_minor therefore reflects that
-- write-time snapshot, not the subject live age.
create or replace function private.is_minor_dob(p_date_of_birth date)
returns boolean
language sql
immutable
set search_path = ''
as $is_minor_dob$
  select p_date_of_birth is not null
     and p_date_of_birth > (current_date - interval '16 years')::date;
$is_minor_dob$;

comment on function private.is_minor_dob(date) is
  'True when the subject is under 16 (GDPR Art.8 digital-consent age in TR and most of the EU). Declared IMMUTABLE so it can back profiles.is_minor STORED; the value is a write-time snapshot.';

-- -----------------------------------------------------------------------------
-- 4. profiles — 1:1 with auth.users
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id                        uuid primary key references auth.users (id) on delete cascade,
  email                     citext,
  full_name                 text,
  display_name              text,
  avatar_url                text,
  role                      public.app_role not null default 'player',
  date_of_birth             date,
  is_minor                  boolean generated always as (private.is_minor_dob(date_of_birth)) stored,

  -- Guardian / parental consent (GDPR Art. 8)
  parental_consent_status   public.consent_status not null default 'not_required',
  parental_consent_at       timestamptz,
  guardian_email            citext,
  guardian_name             text,

  -- Privacy switches (private-by-default, hard-locked for minors)
  location_sharing_enabled  boolean not null default false,
  profile_visibility        text not null default 'private',
  marketing_opt_in          boolean not null default false,

  -- Contact / football profile
  phone                     text,
  city                      text,
  preferred_position        text,
  bio                       text,

  -- Payments
  stripe_account_id         text unique,
  stripe_customer_id        text unique,

  -- Lifecycle
  onboarding_completed_at   timestamptz,
  last_seen_at              timestamptz,
  deleted_at                timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint profiles_visibility_check
    check (profile_visibility in ('public', 'members', 'private')),
  constraint profiles_dob_sane_check
    check (date_of_birth is null or date_of_birth > date '1900-01-01'),
  constraint profiles_minor_privacy_locked_check
    check (
      is_minor is not true
      or (
        location_sharing_enabled = false
        and profile_visibility <> 'public'
        and marketing_opt_in = false
      )
    )
);

comment on table  public.profiles is 'Application profile, 1:1 with auth.users. Soft-deleted via deleted_at for GDPR erasure workflows.';
comment on column public.profiles.role is 'Authorization role. Drives RBAC in @/lib/rbac and every RLS policy.';
comment on column public.profiles.is_minor is 'GENERATED STORED. True when date_of_birth is under 16 as of the last write to the row (GDPR Art.8 threshold).';
comment on column public.profiles.parental_consent_status is 'not_required for adults; pending/granted/revoked gate whether a minor may book, join matches, or be listed.';
comment on column public.profiles.profile_visibility is 'One of public | members | private. Minors are hard-blocked from public by profiles_minor_privacy_locked_check.';
comment on column public.profiles.location_sharing_enabled is 'Opt-in geolocation sharing. Forced false for minors by check constraint.';
comment on column public.profiles.marketing_opt_in is 'Explicit marketing consent. Forced false for minors by check constraint.';
comment on column public.profiles.stripe_account_id is 'Stripe Connect Express acct_* id, set for venue owners. Unique.';
comment on column public.profiles.stripe_customer_id is 'Stripe cus_* id used as the paying customer on destination charges. Unique.';
comment on column public.profiles.deleted_at is 'Soft delete marker. Non-null rows must be excluded from every public listing.';
comment on column public.profiles.preferred_position is 'Free text, e.g. goalkeeper | defender | midfielder | forward. Intentionally unconstrained.';

create index if not exists idx_profiles_role           on public.profiles (role);
create index if not exists idx_profiles_city           on public.profiles (city);
create index if not exists idx_profiles_is_minor       on public.profiles (is_minor) where is_minor;
create index if not exists idx_profiles_consent_status on public.profiles (parental_consent_status);
create index if not exists idx_profiles_deleted_at     on public.profiles (deleted_at) where deleted_at is not null;
create index if not exists idx_profiles_visibility     on public.profiles (profile_visibility);
create unique index if not exists uq_profiles_email_active
  on public.profiles (email) where email is not null and deleted_at is null;

-- -----------------------------------------------------------------------------
-- 5. teams & team_members
-- -----------------------------------------------------------------------------

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 80),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  city        text,
  crest_url   text,
  description text,
  is_public   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table  public.teams is 'A roster of players. owner_id is the founding captain and the only member allowed to delete the team.';
comment on column public.teams.slug is 'URL-safe unique handle, lowercase kebab-case.';
comment on column public.teams.is_public is 'Public teams are discoverable and joinable by request; private teams are invite-only.';

create index if not exists idx_teams_owner_id  on public.teams (owner_id);
create index if not exists idx_teams_city      on public.teams (city);
create index if not exists idx_teams_is_public on public.teams (is_public) where is_public;

create table if not exists public.team_members (
  team_id       uuid not null references public.teams (id) on delete cascade,
  player_id     uuid not null references public.profiles (id) on delete cascade,
  role          public.team_member_role not null default 'member',
  jersey_number smallint check (jersey_number between 1 and 99),
  joined_at     timestamptz not null default now(),
  left_at       timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (team_id, player_id),
  constraint team_members_left_after_joined_check check (left_at is null or left_at >= joined_at)
);

comment on table  public.team_members is 'Membership edge between teams and profiles. left_at non-null means the player has left; rows are retained for historical match attribution.';
comment on column public.team_members.jersey_number is 'Optional squad number, unique per team among active (left_at is null) members.';

create index if not exists idx_team_members_player_id on public.team_members (player_id);
create index if not exists idx_team_members_team_id   on public.team_members (team_id);
create index if not exists idx_team_members_active    on public.team_members (team_id) where left_at is null;
create unique index if not exists uq_team_members_jersey
  on public.team_members (team_id, jersey_number)
  where left_at is null and jersey_number is not null;

-- -----------------------------------------------------------------------------
-- 6. venues & pitches
-- -----------------------------------------------------------------------------

create table if not exists public.venues (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references public.profiles (id) on delete restrict,
  name                    text not null check (char_length(btrim(name)) between 2 and 120),
  slug                    text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description             text,
  address_line1           text,
  address_line2           text,
  city                    text,
  district                text,
  postal_code             text,
  country                 text not null default 'TR' check (country ~ '^[A-Z]{2}$'),
  latitude                numeric(9, 6) check (latitude between -90 and 90),
  longitude               numeric(9, 6) check (longitude between -180 and 180),
  amenities               text[] not null default '{}'::text[],
  photos                  text[] not null default '{}'::text[],
  phone                   text,
  contact_email           citext,
  timezone                text not null default 'Europe/Istanbul',
  is_active               boolean not null default false,
  stripe_account_id       text,
  charges_enabled         boolean not null default false,
  payouts_enabled         boolean not null default false,
  onboarding_completed_at timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table  public.venues is 'A physical facility owned by a venue_owner profile. Only is_active venues are publicly listable.';
comment on column public.venues.is_active is 'False until the owner finishes Stripe Connect onboarding and publishes the venue.';
comment on column public.venues.stripe_account_id is 'Connected acct_* that receives the destination charge for bookings at this venue.';
comment on column public.venues.charges_enabled is 'Mirror of Stripe account.charges_enabled, refreshed by the account.updated webhook.';
comment on column public.venues.payouts_enabled is 'Mirror of Stripe account.payouts_enabled, refreshed by the account.updated webhook.';
comment on column public.venues.timezone is 'IANA zone used to render slot grids; storage stays timestamptz (UTC).';
comment on column public.venues.amenities is 'Free-form facility tags, e.g. {parking,showers,cafe,lighting}.';
comment on column public.venues.photos is 'Ordered list of Supabase Storage public URLs; index 0 is the cover photo.';

create index if not exists idx_venues_owner_id          on public.venues (owner_id);
create index if not exists idx_venues_city              on public.venues (city);
create index if not exists idx_venues_is_active         on public.venues (is_active) where is_active;
create index if not exists idx_venues_stripe_account_id on public.venues (stripe_account_id);
create index if not exists idx_venues_geo               on public.venues (latitude, longitude);

create table if not exists public.pitches (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references public.venues (id) on delete cascade,
  name              text not null check (char_length(btrim(name)) between 1 and 80),
  format            public.match_format not null default 'seven_a_side',
  surface           public.pitch_surface not null default 'artificial_turf',
  is_indoor         boolean not null default false,
  capacity          integer check (capacity > 0 and capacity <= 60),
  hourly_rate_minor integer not null check (hourly_rate_minor > 0),
  currency          text not null default 'try' check (currency ~ '^[a-z]{3}$'),
  opening_time      time not null default '08:00',
  closing_time      time not null default '23:00',
  slot_minutes      integer not null default 60 check (slot_minutes between 15 and 240),
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pitches_venue_name_unique unique (venue_id, name)
);

comment on table  public.pitches is 'A bookable playing surface inside a venue. Pricing and slot granularity live here.';
comment on column public.pitches.hourly_rate_minor is 'Price per hour in minor units (kurus). Booking subtotal_minor = hourly_rate_minor * hours.';
comment on column public.pitches.slot_minutes is 'Granularity of the booking grid in minutes (15..240).';
comment on column public.pitches.opening_time is 'Local wall-clock opening time, interpreted in the parent venue timezone.';
comment on column public.pitches.closing_time is 'Local wall-clock closing time; may sort before opening_time for venues open past midnight.';

create index if not exists idx_pitches_venue_id     on public.pitches (venue_id);
create index if not exists idx_pitches_is_active    on public.pitches (is_active) where is_active;
create index if not exists idx_pitches_format       on public.pitches (format);
create index if not exists idx_pitches_venue_active on public.pitches (venue_id, is_active);

-- -----------------------------------------------------------------------------
-- 7. pitch_availability_blocks — owner-authored blackout / maintenance windows
-- -----------------------------------------------------------------------------

create table if not exists public.pitch_availability_blocks (
  id          uuid primary key default gen_random_uuid(),
  pitch_id    uuid not null references public.pitches (id) on delete cascade,
  block_range tstzrange not null,
  reason      text,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint pitch_blocks_range_bounded_check
    check (not isempty(block_range) and lower(block_range) is not null and upper(block_range) is not null),
  constraint pitch_blocks_no_overlap
    exclude using gist (pitch_id with =, block_range with &&)
);

comment on table  public.pitch_availability_blocks is 'Venue-owner authored blackout windows (maintenance, private hire, closures). Two blocks on the same pitch can never overlap.';
comment on column public.pitch_availability_blocks.block_range is 'Half-open tstzrange [start, end). Must be bounded and non-empty.';

create index if not exists idx_pitch_blocks_pitch_id   on public.pitch_availability_blocks (pitch_id);
create index if not exists idx_pitch_blocks_created_by on public.pitch_availability_blocks (created_by);
create index if not exists idx_pitch_blocks_range      on public.pitch_availability_blocks using gist (block_range);

-- -----------------------------------------------------------------------------
-- 8. bookings — the money table
-- -----------------------------------------------------------------------------

create table if not exists public.bookings (
  id                        uuid primary key default gen_random_uuid(),
  pitch_id                  uuid not null references public.pitches (id) on delete restrict,
  booked_by                 uuid not null references public.profiles (id) on delete restrict,
  team_id                   uuid references public.teams (id) on delete set null,
  time_range                tstzrange not null,
  status                    public.booking_status not null default 'pending',
  payment_status            public.payment_status not null default 'requires_payment',

  -- Money, integer minor units
  subtotal_minor            integer not null check (subtotal_minor >= 0),
  platform_fee_minor        integer not null default 0 check (platform_fee_minor >= 0),
  total_minor               integer not null check (total_minor >= 0),
  currency                  text not null default 'try' check (currency ~ '^[a-z]{3}$'),

  -- Stripe Connect (destination charge) references
  stripe_payment_intent_id  text unique,
  stripe_checkout_session_id text unique,
  stripe_charge_id          text,
  stripe_transfer_id        text,
  connected_account_id      text,
  application_fee_id        text,

  notes                     text,
  cancelled_at              timestamptz,
  cancellation_reason       text,
  refunded_amount_minor     integer not null default 0 check (refunded_amount_minor >= 0),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint bookings_range_bounded_check
    check (not isempty(time_range) and lower(time_range) is not null and upper(time_range) is not null),
  constraint bookings_fee_within_total_check
    check (platform_fee_minor <= total_minor),
  constraint bookings_refund_within_total_check
    check (refunded_amount_minor <= total_minor),

  -- Rejects an overlapping reservation on the same pitch for as long as the
  -- existing one still holds the slot (pending, awaiting_payment, confirmed,
  -- completed). Blackout windows are a separate table and are not covered here.
  constraint bookings_no_double_booking
    exclude using gist (pitch_id with =, time_range with &&)
    where (status in (
      'pending'::public.booking_status,
      'awaiting_payment'::public.booking_status,
      'confirmed'::public.booking_status,
      'completed'::public.booking_status
    ))
);

comment on table  public.bookings is 'A paid reservation of a pitch for a time window. Overlapping reservations on one pitch are rejected in the database by the bookings_no_double_booking GiST exclusion constraint. That constraint does not consider pitch_availability_blocks, so a slot grid has to check blackout windows separately.';
comment on column public.bookings.time_range is 'Half-open tstzrange [start, end) of the reservation. Overlaps are rejected for pending/awaiting_payment/confirmed/completed rows.';
comment on column public.bookings.subtotal_minor is 'Pitch price for the window in minor units, before platform fee.';
comment on column public.bookings.platform_fee_minor is 'Stripe application_fee_amount in minor units, computed by calculatePlatformFee() from PLATFORM_FEE_BPS.';
comment on column public.bookings.total_minor is 'Amount actually charged to the customer, in minor units. Always >= platform_fee_minor.';
comment on column public.bookings.stripe_payment_intent_id is 'pi_* of the destination charge. Unique; used for webhook reconciliation.';
comment on column public.bookings.stripe_checkout_session_id is 'cs_* of the Checkout Session that created the PaymentIntent. Unique.';
comment on column public.bookings.connected_account_id is 'acct_* of the venue receiving the transfer (transfer_data.destination).';
comment on column public.bookings.application_fee_id is 'fee_* of the collected application fee, populated by the charge webhook.';
comment on column public.bookings.refunded_amount_minor is 'Cumulative refunded amount in minor units; drives partially_refunded vs refunded payment_status.';

create index if not exists idx_bookings_pitch_id       on public.bookings (pitch_id);
create index if not exists idx_bookings_booked_by      on public.bookings (booked_by);
create index if not exists idx_bookings_team_id        on public.bookings (team_id);
create index if not exists idx_bookings_status         on public.bookings (status);
create index if not exists idx_bookings_payment_status on public.bookings (payment_status);
create index if not exists idx_bookings_created_at     on public.bookings (created_at desc);
create index if not exists idx_bookings_time_range     on public.bookings using gist (time_range);
create index if not exists idx_bookings_pitch_range    on public.bookings using gist (pitch_id, time_range);
create index if not exists idx_bookings_active_status
  on public.bookings (status)
  where status in (
    'pending'::public.booking_status,
    'awaiting_payment'::public.booking_status,
    'confirmed'::public.booking_status
  );
create index if not exists idx_bookings_connected_account_id on public.bookings (connected_account_id);

-- -----------------------------------------------------------------------------
-- 9. matches
-- -----------------------------------------------------------------------------

create table if not exists public.matches (
  id                        uuid primary key default gen_random_uuid(),
  booking_id                uuid unique references public.bookings (id) on delete set null,
  pitch_id                  uuid references public.pitches (id) on delete set null,
  venue_id                  uuid references public.venues (id) on delete set null,
  format                    public.match_format not null default 'seven_a_side',
  status                    public.match_status not null default 'scheduled',
  kickoff_at                timestamptz not null,
  duration_minutes          integer not null default 60 check (duration_minutes between 10 and 240),

  home_team_id              uuid references public.teams (id) on delete set null,
  away_team_id              uuid references public.teams (id) on delete set null,
  home_score                integer check (home_score >= 0),
  away_score                integer check (away_score >= 0),
  score_confirmed_at        timestamptz,
  is_ranked                 boolean not null default true,

  -- Matchmaking quality (TrueSkill-style)
  predicted_draw_probability numeric(6, 5) check (predicted_draw_probability between 0 and 1),
  match_quality             numeric(6, 5) check (match_quality between 0 and 1),

  -- Result integrity
  requires_consensus        boolean not null default false,
  anomaly_score             numeric(8, 6),
  anomaly_checked_at        timestamptz,
  consensus_deadline        timestamptz,

  rating_applied_at         timestamptz,
  created_by                uuid references public.profiles (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint matches_distinct_teams_check check (home_team_id <> away_team_id)
);

comment on table  public.matches is 'A played or scheduled fixture. Optionally anchored to a booking; ranked matches feed player_ratings.';
comment on column public.matches.booking_id is 'Owning booking, unique 1:1. Null for pickup matches recorded without a paid slot.';
comment on column public.matches.is_ranked is 'When false the match is recorded but never updates player_ratings.';
comment on column public.matches.predicted_draw_probability is 'Pre-match draw likelihood in [0,1] from the rating model.';
comment on column public.matches.match_quality is 'Matchmaking balance score in [0,1]; 1 means perfectly even sides.';
comment on column public.matches.requires_consensus is 'Set when reported scores conflict or the anomaly detector flags the result; blocks finalization until consensus_approvals pass.';
comment on column public.matches.anomaly_score is 'Latest isolation-forest / rule-engine score. Higher means more anomalous.';
comment on column public.matches.consensus_deadline is 'After this instant an unresolved consensus round is auto-escalated to disputed.';
comment on column public.matches.rating_applied_at is 'Non-null once the TrueSkill update has been written to player_ratings; guards against double-applying.';

create index if not exists idx_matches_booking_id        on public.matches (booking_id);
create index if not exists idx_matches_pitch_id          on public.matches (pitch_id);
create index if not exists idx_matches_venue_id          on public.matches (venue_id);
create index if not exists idx_matches_home_team_id      on public.matches (home_team_id);
create index if not exists idx_matches_away_team_id      on public.matches (away_team_id);
create index if not exists idx_matches_created_by        on public.matches (created_by);
create index if not exists idx_matches_status_kickoff_at on public.matches (status, kickoff_at);
create index if not exists idx_matches_kickoff_at        on public.matches (kickoff_at desc);
create index if not exists idx_matches_requires_consensus
  on public.matches (consensus_deadline) where requires_consensus;
create index if not exists idx_matches_pending_rating
  on public.matches (kickoff_at) where rating_applied_at is null and is_ranked;

-- -----------------------------------------------------------------------------
-- 10. match_participants
-- -----------------------------------------------------------------------------

create table if not exists public.match_participants (
  id           uuid primary key default gen_random_uuid(),
  match_id     uuid not null references public.matches (id) on delete cascade,
  player_id    uuid not null references public.profiles (id) on delete cascade,
  team_side    text not null check (team_side in ('home', 'away')),
  is_confirmed boolean not null default false,
  joined_at    timestamptz not null default now(),
  constraint match_participants_unique unique (match_id, player_id)
);

comment on table  public.match_participants is 'Line-up: which players took which side in a match. Only confirmed participants may file score reports or consensus approvals.';
comment on column public.match_participants.team_side is 'home | away.';
comment on column public.match_participants.is_confirmed is 'True once the player accepts the invitation / checks in at kickoff.';

create index if not exists idx_match_participants_match_id  on public.match_participants (match_id);
create index if not exists idx_match_participants_player_id on public.match_participants (player_id);
create index if not exists idx_match_participants_side      on public.match_participants (match_id, team_side);

-- -----------------------------------------------------------------------------
-- 11. player_ratings — current TrueSkill-style skill, one row per player
-- -----------------------------------------------------------------------------

create table if not exists public.player_ratings (
  player_id            uuid primary key references public.profiles (id) on delete cascade,
  mu                   double precision not null default 25.0,
  sigma                double precision not null default 8.333333333333334 check (sigma > 0),
  conservative_rating  double precision generated always as (mu - 3 * sigma) stored,
  matches_played       integer not null default 0 check (matches_played >= 0),
  wins                 integer not null default 0 check (wins >= 0),
  draws                integer not null default 0 check (draws >= 0),
  losses               integer not null default 0 check (losses >= 0),
  last_match_at        timestamptz,
  last_decay_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table  public.player_ratings is 'Current skill estimate per player. mu/sigma are the TrueSkill Gaussian parameters; one row is created on first ranked match.';
comment on column public.player_ratings.mu is 'Mean skill. Default 25.0.';
comment on column public.player_ratings.sigma is 'Skill uncertainty (standard deviation). Default 25/3 = 8.333333333333334.';
comment on column public.player_ratings.conservative_rating is 'GENERATED STORED mu - 3*sigma. The number shown on leaderboards.';
comment on column public.player_ratings.last_decay_at is 'Last time the inactivity decay cron widened sigma for this player.';

create index if not exists idx_player_ratings_conservative on public.player_ratings (conservative_rating desc);
create index if not exists idx_player_ratings_last_match_at on public.player_ratings (last_match_at);
create index if not exists idx_player_ratings_last_decay_at on public.player_ratings (last_decay_at);

-- -----------------------------------------------------------------------------
-- 12. player_stats — one row per (player, match) performance record
-- -----------------------------------------------------------------------------

create table if not exists public.player_stats (
  id             uuid primary key default gen_random_uuid(),
  match_id       uuid not null references public.matches (id) on delete cascade,
  player_id      uuid not null references public.profiles (id) on delete cascade,
  team_id        uuid references public.teams (id) on delete set null,
  team_side      text check (team_side in ('home', 'away')),
  goals          integer not null default 0 check (goals >= 0),
  assists        integer not null default 0 check (assists >= 0),
  saves          integer not null default 0 check (saves >= 0),
  yellow_cards   integer not null default 0 check (yellow_cards between 0 and 2),
  red_cards      integer not null default 0 check (red_cards between 0 and 1),
  minutes_played integer not null default 0 check (minutes_played between 0 and 240),
  mu_before      double precision,
  sigma_before   double precision,
  mu_after       double precision,
  sigma_after    double precision,
  rating_delta   double precision generated always as (mu_after - mu_before) stored,
  created_at     timestamptz not null default now(),
  constraint player_stats_unique unique (match_id, player_id)
);

comment on table  public.player_stats is 'Immutable per-match performance record, including the rating snapshot before and after the TrueSkill update.';
comment on column public.player_stats.mu_before is 'player_ratings.mu immediately before this match was applied.';
comment on column public.player_stats.mu_after is 'player_ratings.mu immediately after this match was applied.';
comment on column public.player_stats.rating_delta is 'GENERATED STORED mu_after - mu_before. Null until the rating update runs.';

create index if not exists idx_player_stats_match_id  on public.player_stats (match_id);
create index if not exists idx_player_stats_player_id on public.player_stats (player_id);
create index if not exists idx_player_stats_team_id   on public.player_stats (team_id);
create index if not exists idx_player_stats_player_created on public.player_stats (player_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 13. score_reports — self-reported results
-- -----------------------------------------------------------------------------

create table if not exists public.score_reports (
  id                 uuid primary key default gen_random_uuid(),
  match_id           uuid not null references public.matches (id) on delete cascade,
  reported_by        uuid not null references public.profiles (id) on delete cascade,
  team_side          text check (team_side in ('home', 'away')),
  home_score         integer not null check (home_score >= 0),
  away_score         integer not null check (away_score >= 0),
  reported_at        timestamptz not null default now(),
  client_reported_at timestamptz,
  payload_hash       bytea,
  ip_hash            bytea,
  constraint score_reports_unique unique (match_id, reported_by)
);

comment on table  public.score_reports is 'Per-reporter claimed result. Agreement across sides finalizes the match; disagreement raises matches.requires_consensus.';
comment on column public.score_reports.client_reported_at is 'Timestamp asserted by the client; compared against reported_at by the anomaly rules to spot backdating.';
comment on column public.score_reports.payload_hash is 'SHA-256 of the canonical JSON report body. Detects tampering between client and server.';
comment on column public.score_reports.ip_hash is 'Salted SHA-256 of the reporter IP. Never store raw IPs (GDPR data minimisation).';

create index if not exists idx_score_reports_match_id    on public.score_reports (match_id);
create index if not exists idx_score_reports_reported_by on public.score_reports (reported_by);
create index if not exists idx_score_reports_reported_at on public.score_reports (reported_at desc);

-- -----------------------------------------------------------------------------
-- 14. match_anomaly_flags
-- -----------------------------------------------------------------------------

create table if not exists public.match_anomaly_flags (
  id                   uuid primary key default gen_random_uuid(),
  match_id             uuid not null references public.matches (id) on delete cascade,
  source               text not null check (source in ('rule_engine', 'isolation_forest', 'manual')),
  anomaly_score        numeric(8, 6),
  is_anomalous         boolean not null default false,
  reasons              jsonb not null default '[]'::jsonb,
  model_version        text,
  leaf_depth           integer check (leaf_depth >= 0),
  average_path_length  numeric(10, 6),
  created_at           timestamptz not null default now()
);

comment on table  public.match_anomaly_flags is 'Append-only audit of every integrity check run against a match result.';
comment on column public.match_anomaly_flags.source is 'rule_engine | isolation_forest | manual.';
comment on column public.match_anomaly_flags.reasons is 'JSON array of machine-readable reason codes, e.g. ["impossible_scoreline","reporter_not_participant"].';
comment on column public.match_anomaly_flags.leaf_depth is 'Isolation forest: depth at which the sample was isolated.';
comment on column public.match_anomaly_flags.average_path_length is 'Isolation forest: c(n) normalisation term used to derive anomaly_score.';

create index if not exists idx_match_anomaly_flags_match_id on public.match_anomaly_flags (match_id);
create index if not exists idx_match_anomaly_flags_anomalous
  on public.match_anomaly_flags (created_at desc) where is_anomalous;

-- -----------------------------------------------------------------------------
-- 15. consensus_approvals — signed peer consensus on a disputed result
-- -----------------------------------------------------------------------------

create table if not exists public.consensus_approvals (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null references public.matches (id) on delete cascade,
  approver_id       uuid not null references public.profiles (id) on delete cascade,
  decision          text not null check (decision in ('approve', 'reject')),
  canonical_payload jsonb not null,
  payload_digest    bytea not null,
  nonce             bytea not null,
  signature         text,
  signature_alg     text not null default 'hmac-sha256',
  approved_at       timestamptz not null default now(),
  constraint consensus_approvals_unique unique (match_id, approver_id)
);

comment on table  public.consensus_approvals is 'One signed vote per participant on a contested match result. Signature binds the canonical payload plus a server-issued nonce.';
comment on column public.consensus_approvals.canonical_payload is 'Deterministically serialised result the approver actually saw (sorted keys, no whitespace).';
comment on column public.consensus_approvals.payload_digest is 'SHA-256 of the canonical payload bytes.';
comment on column public.consensus_approvals.nonce is 'Server-issued single-use random bytes, replay protection for the signature.';
comment on column public.consensus_approvals.signature is 'Base64 HMAC over payload_digest || nonce keyed by the server consensus secret.';

create index if not exists idx_consensus_approvals_match_id    on public.consensus_approvals (match_id);
create index if not exists idx_consensus_approvals_approver_id on public.consensus_approvals (approver_id);
create index if not exists idx_consensus_approvals_decision    on public.consensus_approvals (match_id, decision);

-- -----------------------------------------------------------------------------
-- 16. venue_payouts
-- -----------------------------------------------------------------------------

create table if not exists public.venue_payouts (
  id                   uuid primary key default gen_random_uuid(),
  venue_id             uuid not null references public.venues (id) on delete cascade,
  stripe_payout_id     text not null unique,
  connected_account_id text,
  amount_minor         integer not null check (amount_minor >= 0),
  currency             text not null default 'try' check (currency ~ '^[a-z]{3}$'),
  status               public.payout_status not null default 'pending',
  arrival_date         date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table  public.venue_payouts is 'Mirror of Stripe payouts on a connected account, populated by payout.* webhooks. Read-only to venue owners.';
comment on column public.venue_payouts.stripe_payout_id is 'po_* identifier. Unique, doubles as the webhook idempotency key for this table.';
comment on column public.venue_payouts.arrival_date is 'Expected settlement date reported by Stripe.';

create index if not exists idx_venue_payouts_venue_id           on public.venue_payouts (venue_id);
create index if not exists idx_venue_payouts_status             on public.venue_payouts (status);
create index if not exists idx_venue_payouts_connected_account  on public.venue_payouts (connected_account_id);
create index if not exists idx_venue_payouts_arrival_date       on public.venue_payouts (arrival_date desc);

-- -----------------------------------------------------------------------------
-- 17. stripe_events — webhook idempotency ledger
-- -----------------------------------------------------------------------------

create table if not exists public.stripe_events (
  id               text primary key,
  type             text not null,
  api_version      text,
  payload          jsonb not null,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  processing_error text,
  attempts         integer not null default 0 check (attempts >= 0)
);

comment on table  public.stripe_events is 'Idempotency ledger for Stripe webhooks. Insert the event id first; a unique violation means the event was already handled.';
comment on column public.stripe_events.id is 'Stripe evt_* identifier, used verbatim as the primary key.';
comment on column public.stripe_events.processed_at is 'Non-null once the handler committed successfully.';
comment on column public.stripe_events.processing_error is 'Last handler error message, for replay triage.';

create index if not exists idx_stripe_events_type        on public.stripe_events (type);
create index if not exists idx_stripe_events_received_at on public.stripe_events (received_at desc);
create index if not exists idx_stripe_events_unprocessed on public.stripe_events (received_at) where processed_at is null;

-- -----------------------------------------------------------------------------
-- 18. parental_consent_requests (GDPR Art. 8)
-- -----------------------------------------------------------------------------

create table if not exists public.parental_consent_requests (
  id               uuid primary key default gen_random_uuid(),
  minor_id         uuid not null references public.profiles (id) on delete cascade,
  guardian_email   citext not null,
  token_hash       bytea not null unique,
  status           public.consent_status not null default 'pending',
  requested_at     timestamptz not null default now(),
  expires_at       timestamptz not null,
  verified_at      timestamptz,
  guardian_ip_hash bytea,
  revoked_at       timestamptz,
  constraint parental_consent_expiry_check check (expires_at > requested_at)
);

comment on table  public.parental_consent_requests is 'Verifiable guardian consent flow for under-16 accounts (GDPR Art. 8). Rows are retained as consent evidence.';
comment on column public.parental_consent_requests.token_hash is 'SHA-256 of the emailed consent token. The plaintext token is never persisted.';
comment on column public.parental_consent_requests.guardian_ip_hash is 'Salted SHA-256 of the IP that granted consent. Evidence of verification without storing a raw IP.';
comment on column public.parental_consent_requests.revoked_at is 'Set when the guardian withdraws consent; the minor account is restricted immediately.';

create index if not exists idx_parental_consent_minor_id on public.parental_consent_requests (minor_id);
create index if not exists idx_parental_consent_status   on public.parental_consent_requests (status);
create index if not exists idx_parental_consent_expires  on public.parental_consent_requests (expires_at)
  where status = 'pending'::public.consent_status;
create index if not exists idx_parental_consent_guardian_email on public.parental_consent_requests (guardian_email);

-- -----------------------------------------------------------------------------
-- 19. audit_log (GDPR accountability)
-- -----------------------------------------------------------------------------

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text,
  entity_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  ip_hash     bytea,
  created_at  timestamptz not null default now()
);

comment on table  public.audit_log is 'Append-only accountability trail (GDPR Art. 5(2)). Admin-readable only; never expose to end users.';
comment on column public.audit_log.action is 'Dotted verb, e.g. booking.cancelled, profile.consent_granted, venue.published.';
comment on column public.audit_log.entity_type is 'Table name of the affected row, e.g. bookings.';
comment on column public.audit_log.metadata is 'Structured, already-minimised context. Never store raw PII here.';

create index if not exists idx_audit_log_actor_id   on public.audit_log (actor_id);
create index if not exists idx_audit_log_entity     on public.audit_log (entity_type, entity_id);
create index if not exists idx_audit_log_action     on public.audit_log (action);
create index if not exists idx_audit_log_created_at on public.audit_log (created_at desc);

-- -----------------------------------------------------------------------------
-- 20. notifications
-- -----------------------------------------------------------------------------

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  data       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

comment on table  public.notifications is 'Per-user in-app notification feed. Streamed to the client over Supabase Realtime.';
comment on column public.notifications.type is 'Dotted event key, e.g. booking.confirmed, match.consensus_required, payout.paid.';
comment on column public.notifications.data is 'Payload for deep-linking, e.g. {"bookingId":"..."}.';

create index if not exists idx_notifications_user_id    on public.notifications (user_id);
create index if not exists idx_notifications_user_unread on public.notifications (user_id, created_at desc) where read_at is null;
create index if not exists idx_notifications_created_at on public.notifications (created_at desc);

-- -----------------------------------------------------------------------------
-- 21. updated_at triggers
-- -----------------------------------------------------------------------------

drop trigger if exists trg_profiles_set_updated_at on public.profiles;
create trigger trg_profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_teams_set_updated_at on public.teams;
create trigger trg_teams_set_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

drop trigger if exists trg_team_members_set_updated_at on public.team_members;
create trigger trg_team_members_set_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

drop trigger if exists trg_venues_set_updated_at on public.venues;
create trigger trg_venues_set_updated_at
  before update on public.venues
  for each row execute function public.set_updated_at();

drop trigger if exists trg_pitches_set_updated_at on public.pitches;
create trigger trg_pitches_set_updated_at
  before update on public.pitches
  for each row execute function public.set_updated_at();

drop trigger if exists trg_bookings_set_updated_at on public.bookings;
create trigger trg_bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

drop trigger if exists trg_matches_set_updated_at on public.matches;
create trigger trg_matches_set_updated_at
  before update on public.matches
  for each row execute function public.set_updated_at();

drop trigger if exists trg_player_ratings_set_updated_at on public.player_ratings;
create trigger trg_player_ratings_set_updated_at
  before update on public.player_ratings
  for each row execute function public.set_updated_at();

drop trigger if exists trg_venue_payouts_set_updated_at on public.venue_payouts;
create trigger trg_venue_payouts_set_updated_at
  before update on public.venue_payouts
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 22. Fail closed: enable RLS everywhere. Policies land in the RLS migration.
-- -----------------------------------------------------------------------------

alter table public.profiles                  enable row level security;
alter table public.teams                     enable row level security;
alter table public.team_members              enable row level security;
alter table public.venues                    enable row level security;
alter table public.pitches                   enable row level security;
alter table public.pitch_availability_blocks enable row level security;
alter table public.bookings                  enable row level security;
alter table public.matches                   enable row level security;
alter table public.match_participants        enable row level security;
alter table public.player_ratings            enable row level security;
alter table public.player_stats              enable row level security;
alter table public.score_reports             enable row level security;
alter table public.match_anomaly_flags       enable row level security;
alter table public.consensus_approvals       enable row level security;
alter table public.venue_payouts             enable row level security;
alter table public.stripe_events             enable row level security;
alter table public.parental_consent_requests enable row level security;
alter table public.audit_log                 enable row level security;
alter table public.notifications             enable row level security;
