-- =============================================================================
-- OnPitch — 0011_profiles_and_messaging.sql
--
-- Two things people asked for and one thing the law asks for.
--
--   1. PROFILE CUSTOMISATION. An accent colour that follows the person around the app, the
--      pitch shot their profile opens on, a tagline, a favourite number, a dominant foot. None of
--      it is sensitive; all of it is theirs to change (0002 §4.1 grants extended below).
--
--   2. DIRECT MESSAGES. One conversation per pair of people, messages inside it, blocks and
--      reports around it. Every WRITE goes through a SECURITY DEFINER RPC keyed on auth.uid() —
--      no role holds INSERT on any messaging table — so the rules below (who may start a thread,
--      rate limits, blocks) cannot be bypassed by a client that talks to PostgREST directly.
--      Every READ is plain RLS, which is what lets Realtime's Postgres Changes stream a thread to
--      exactly its members and nobody else.
--
--   3. GDPR. Messaging is the first feature here where one person's data sits in another
--      person's account. The choices, each stated where it is made:
--        * consent-shaped by default: a stranger cannot open a thread unless you said
--          `messaging_policy = 'everyone'`; the default is `teammates` (plus anyone you have a
--          booking relationship with);
--        * Art. 8: a minor can only message, and be messaged by, people they already play with
--          or have booked from — whatever either side's policy says;
--        * Art. 17: erasure REDACTS the subject's messages in place (body cleared, marked) rather
--          than deleting the other party's copy of the conversation, and leaves every thread;
--        * Art. 15/20: sent messages and memberships are in the export;
--        * minimisation: the notification for a new message carries no message text, and a
--          retention job removes messages after a year.
--
-- Conventions match 0010: `(select auth.uid())` everywhere a policy or function reads the
-- caller; every FK indexed; RLS enabled AND forced; PostgREST-mapped SQLSTATEs (PT4xx) on the
-- RPCs so a refusal reaches the browser as the right HTTP status.
-- =============================================================================

-- =============================================================================
-- 1. Profile customisation
-- =============================================================================

alter table public.profiles
  add column if not exists accent_color     text    not null default 'gold',
  add column if not exists banner_shot      text    not null default 'stands',
  add column if not exists tagline          text,
  add column if not exists jersey_number    integer,
  add column if not exists dominant_foot    text,
  add column if not exists messaging_policy text    not null default 'teammates';

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_accent_color_check') then
    alter table public.profiles add constraint profiles_accent_color_check
      check (accent_color in ('gold', 'teal', 'vermilion', 'azure', 'violet', 'lime', 'coral', 'ice'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_banner_shot_check') then
    alter table public.profiles add constraint profiles_banner_shot_check
      check (banner_shot in ('stands', 'centre', 'goalmouth', 'touchline', 'aerial', 'tunnel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_tagline_length_check') then
    alter table public.profiles add constraint profiles_tagline_length_check
      check (tagline is null or char_length(tagline) <= 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_jersey_number_check') then
    alter table public.profiles add constraint profiles_jersey_number_check
      check (jersey_number is null or jersey_number between 0 and 99);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_dominant_foot_check') then
    alter table public.profiles add constraint profiles_dominant_foot_check
      check (dominant_foot is null or dominant_foot in ('left', 'right', 'both'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_messaging_policy_check') then
    alter table public.profiles add constraint profiles_messaging_policy_check
      check (messaging_policy in ('everyone', 'teammates', 'nobody'));
  end if;
  -- Art. 8, belt: a minor's row can never say "anyone may write to me". The braces are the
  -- trigger below (which rewrites the value) and can_message() (which ignores it for minors).
  if not exists (select 1 from pg_constraint where conname = 'profiles_minor_messaging_locked_check') then
    alter table public.profiles add constraint profiles_minor_messaging_locked_check
      check (is_minor is not true or messaging_policy <> 'everyone');
  end if;
end
$constraints$;

comment on column public.profiles.accent_color     is 'The person''s chosen accent. One of the named palette entries; the app maps it to an HSL token that tints their shell, avatar ring and message bubbles.';
comment on column public.profiles.banner_shot      is 'Which composed pitch shot their profile page opens on. Mirrors BANNER_SHOTS in components/three/scene.ts.';
comment on column public.profiles.tagline          is 'One line under the name. 80 chars.';
comment on column public.profiles.jersey_number    is 'Favourite shirt number, 0-99. Distinct from team_members.jersey_number, which is per squad.';
comment on column public.profiles.dominant_foot    is 'left | right | both. Free to leave null.';
comment on column public.profiles.messaging_policy is 'Who may START a conversation: everyone | teammates (default; also anyone with a booking relationship) | nobody. Minors are pinned away from everyone.';

-- Mirrors enforce_minor_privacy (0003 §6): a BEFORE trigger cannot read the generated
-- is_minor, so the same date predicate is applied to NEW.date_of_birth.
create or replace function public.enforce_minor_messaging()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $enforce_minor_messaging$
begin
  if coalesce(new.date_of_birth > (current_date - interval '16 years')::date, false)
     and new.messaging_policy = 'everyone' then
    if tg_op = 'UPDATE' and new.messaging_policy is distinct from old.messaging_policy then
      raise exception 'Messaging cannot be opened to everyone for a user under 16 (GDPR Art. 8).'
        using errcode = '42501',
              hint    = 'Allowed values for a minor are teammates or nobody.';
    end if;
    new.messaging_policy := 'teammates';
  end if;
  return new;
end;
$enforce_minor_messaging$;

drop trigger if exists trg_profiles_enforce_minor_messaging on public.profiles;
create trigger trg_profiles_enforce_minor_messaging
  before insert or update of date_of_birth, messaging_policy on public.profiles
  for each row execute function public.enforce_minor_messaging();

-- Grants: the new columns join the directory surface (0002 §4.1). messaging_policy is
-- readable so a profile page can decide whether to show the button; the real check is
-- can_message(), which the button's target calls again.
grant select (accent_color, banner_shot, tagline, jersey_number, dominant_foot, messaging_policy)
  on table public.profiles to authenticated;
grant insert (accent_color, banner_shot, tagline, jersey_number, dominant_foot, messaging_policy)
  on table public.profiles to authenticated;
grant update (accent_color, banner_shot, tagline, jersey_number, dominant_foot, messaging_policy)
  on table public.profiles to authenticated;


-- =============================================================================
-- 2. Messaging tables
-- =============================================================================

create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self_check check (blocker_id <> blocked_id)
);
comment on table public.user_blocks is 'A block stops messages in BOTH directions and hides the pair from each other''s thread-start paths. Written only by block_user()/unblock_user().';
create index if not exists idx_user_blocks_blocked_id on public.user_blocks (blocked_id);

create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'direct' check (kind in ('direct')),
  -- least(a,b)::text || ':' || greatest(a,b)::text for a direct thread: one per pair, ever.
  direct_key      text unique,
  booking_id      uuid references public.bookings (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null,
  last_message_id uuid,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table  public.conversations is 'A thread between people. Only direct (two-party) threads exist today; kind is a CHECK so a group thread is a schema change, not a data surprise.';
comment on column public.conversations.direct_key is 'Canonical pair key so open_conversation() is idempotent for a pair.';
create index if not exists idx_conversations_booking_id      on public.conversations (booking_id);
create index if not exists idx_conversations_created_by      on public.conversations (created_by);
create index if not exists idx_conversations_last_message_at on public.conversations (last_message_at desc nulls last);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  muted_at        timestamptz,
  left_at         timestamptz,
  primary key (conversation_id, user_id)
);
comment on table  public.conversation_members is 'Who is in a thread. left_at hides the thread from that person until the other side writes again (or they reopen it). muted_at suppresses the notification, never the message.';
create index if not exists idx_conversation_members_user_id on public.conversation_members (user_id, left_at);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references public.profiles (id) on delete cascade,
  body            text not null,
  -- Client-minted idempotency key so a retried send never duplicates.
  client_id       text,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  -- Unsent by the sender. Body is cleared at the same time; the row stays so the thread keeps
  -- its shape ("message removed") and a filed report keeps its evidence.
  deleted_at      timestamptz,
  -- Cleared by request_account_erasure(). Distinct from deleted_at so the UI can say why.
  redacted_at     timestamptz,
  constraint messages_body_length_check check (char_length(body) <= 2000),
  constraint messages_client_id_length_check check (client_id is null or char_length(client_id) <= 64)
);
comment on table public.messages is 'One message. Inserted only by send_message(). Readable by the members of its conversation and by nobody else — including admins, who see reported excerpts only.';
create index if not exists idx_messages_conversation_created on public.messages (conversation_id, created_at desc);
create index if not exists idx_messages_sender_id            on public.messages (sender_id);
create unique index if not exists uq_messages_client_id
  on public.messages (conversation_id, sender_id, client_id) where client_id is not null;

alter table public.conversations
  drop constraint if exists conversations_last_message_id_fkey;
alter table public.conversations
  add constraint conversations_last_message_id_fkey
  foreign key (last_message_id) references public.messages (id) on delete set null;
create index if not exists idx_conversations_last_message_id on public.conversations (last_message_id);

create table if not exists public.message_reports (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.messages (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason      text not null check (reason in ('harassment', 'spam', 'inappropriate', 'other')),
  details     text check (details is null or char_length(details) <= 1000),
  -- The body at the time of the report. Kept even if the sender unsends or is erased: this is
  -- the evidence a moderator acts on (Art. 17(3)(e)), and it is the ONLY place an admin can
  -- read message text.
  excerpt     text not null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null
);
comment on table public.message_reports is 'Abuse reports. The excerpt is the moderation record; admins read reports, never threads.';
create index if not exists idx_message_reports_message_id  on public.message_reports (message_id);
create index if not exists idx_message_reports_reporter_id on public.message_reports (reporter_id);
create index if not exists idx_message_reports_resolved_by on public.message_reports (resolved_by);
create index if not exists idx_message_reports_open        on public.message_reports (created_at desc) where resolved_at is null;


-- =============================================================================
-- 3. Predicates
-- =============================================================================

-- The caller is an active member of the thread. Used by every messaging policy.
create or replace function private.is_conversation_member(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.conversation_members cm
     where cm.conversation_id = p_conversation_id
       and cm.user_id = (select auth.uid())
       and cm.left_at is null
  );
$$;
comment on function private.is_conversation_member(uuid) is 'True when the caller is a member of the conversation and has not left it.';

create or replace function private.is_blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_blocks b
     where (b.blocker_id = p_a and b.blocked_id = p_b)
        or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;

-- A booking is a relationship: the person who paid and the owner of the pitch they paid for.
create or replace function private.has_booking_relationship(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.bookings bk
      join public.pitches pi on pi.id = bk.pitch_id
      join public.venues  v  on v.id  = pi.venue_id
     where (bk.booked_by = (select auth.uid()) and v.owner_id = p_other)
        or (bk.booked_by = p_other and v.owner_id = (select auth.uid()))
  );
$$;

-- -----------------------------------------------------------------------------
-- can_message — may the caller START a thread with p_recipient?
--
--   * never yourself, never an erased account, never across a block (either way)
--   * recipient says nobody      -> no
--   * either party is a minor    -> only an established relationship (teammates or a booking),
--                                   whatever the policy says (Art. 8)
--   * recipient says everyone    -> yes
--   * recipient says teammates   -> teammates or a booking relationship
--
-- STABLE and SECURITY DEFINER: it reads columns the caller cannot select (is_minor,
-- deleted_at, the other side's blocks) and answers only true/false.
-- -----------------------------------------------------------------------------
create or replace function public.can_message(p_recipient uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $can_message$
declare
  v_me          uuid := (select auth.uid());
  v_me_minor    boolean;
  v_me_deleted  timestamptz;
  v_them        record;
  v_related     boolean;
begin
  if v_me is null or p_recipient is null or v_me = p_recipient then
    return false;
  end if;

  select p.is_minor, p.deleted_at into v_me_minor, v_me_deleted
    from public.profiles p where p.id = v_me;
  if not found or v_me_deleted is not null then
    return false;
  end if;

  select p.is_minor, p.deleted_at, p.messaging_policy into v_them
    from public.profiles p where p.id = p_recipient;
  if not found or v_them.deleted_at is not null then
    return false;
  end if;

  if (select private.is_blocked_between(v_me, p_recipient)) then
    return false;
  end if;

  if v_them.messaging_policy = 'nobody' then
    return false;
  end if;

  v_related := (select private.shares_team_with(p_recipient))
            or (select private.has_booking_relationship(p_recipient));

  if coalesce(v_me_minor, false) or coalesce(v_them.is_minor, false) then
    return v_related;
  end if;

  if v_them.messaging_policy = 'everyone' then
    return true;
  end if;

  return v_related;
end;
$can_message$;
comment on function public.can_message(uuid) is 'Whether the caller may open a conversation with the given profile. Blocks, erasure, the recipient''s messaging_policy and the Art. 8 minor rule, in that order.';


-- =============================================================================
-- 4. RPCs — the only write path
-- =============================================================================

-- open_conversation: find or create the one direct thread for this pair. Idempotent.
create or replace function public.open_conversation(p_recipient uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $open_conversation$
declare
  v_me   uuid := (select auth.uid());
  v_key  text;
  v_id   uuid;
  v_rl   jsonb;
begin
  if v_me is null then
    raise exception 'Sign in to send messages.' using errcode = 'PT401';
  end if;
  if p_recipient is null or p_recipient = v_me then
    raise exception 'You cannot message yourself.' using errcode = 'PT422';
  end if;

  v_key := least(v_me, p_recipient)::text || ':' || greatest(v_me, p_recipient)::text;

  select c.id into v_id from public.conversations c where c.direct_key = v_key;

  if v_id is null then
    if not public.can_message(p_recipient) then
      raise exception 'This person is not accepting messages from you.' using errcode = 'PT403';
    end if;

    -- Starting threads is the spammy gesture; sending inside one is limited separately.
    v_rl := public.consume_rate_limit('message_start', 20, 3600);
    if not coalesce((v_rl ->> 'allowed')::boolean, true) then
      raise exception 'Too many new conversations. Try again later.' using errcode = 'PT429';
    end if;

    insert into public.conversations (kind, direct_key, created_by)
    values ('direct', v_key, v_me)
    returning id into v_id;

    insert into public.conversation_members (conversation_id, user_id)
    values (v_id, v_me), (v_id, p_recipient);
  else
    if (select private.is_blocked_between(v_me, p_recipient)) then
      raise exception 'This person is not accepting messages from you.' using errcode = 'PT403';
    end if;
    -- Reopening a thread you left is allowed; the other side is untouched until you write.
    update public.conversation_members
       set left_at = null
     where conversation_id = v_id and user_id = v_me and left_at is not null;
  end if;

  return v_id;
end;
$open_conversation$;

-- send_message: append to a thread the caller is in.
create or replace function public.send_message(
  p_conversation uuid,
  p_body         text,
  p_client_id    text default null
)
returns public.messages
language plpgsql
volatile
security definer
set search_path = ''
as $send_message$
declare
  v_me     uuid := (select auth.uid());
  v_body   text := btrim(coalesce(p_body, ''));
  v_other  record;
  v_rl     jsonb;
  v_msg    public.messages;
  v_sender text;
begin
  if v_me is null then
    raise exception 'Sign in to send messages.' using errcode = 'PT401';
  end if;
  if char_length(v_body) < 1 or char_length(v_body) > 2000 then
    raise exception 'A message is between 1 and 2000 characters.' using errcode = 'PT422';
  end if;
  if not (select private.is_conversation_member(p_conversation)) then
    raise exception 'You are not in this conversation.' using errcode = 'PT403';
  end if;

  -- Idempotent retry: the same client id inside the same thread returns the first row.
  if p_client_id is not null then
    select m.* into v_msg
      from public.messages m
     where m.conversation_id = p_conversation
       and m.sender_id = v_me
       and m.client_id = p_client_id;
    if found then
      return v_msg;
    end if;
  end if;

  select cm.user_id, cm.left_at, p.messaging_policy, p.deleted_at
    into v_other
    from public.conversation_members cm
    join public.profiles p on p.id = cm.user_id
   where cm.conversation_id = p_conversation
     and cm.user_id <> v_me
   limit 1;

  if v_other.user_id is not null then
    if v_other.deleted_at is not null then
      raise exception 'This account no longer exists.' using errcode = 'PT410';
    end if;
    if (select private.is_blocked_between(v_me, v_other.user_id)) then
      raise exception 'You cannot message this person.' using errcode = 'PT403';
    end if;
    -- "Nobody" means nobody, including people already in your list.
    if v_other.messaging_policy = 'nobody' then
      raise exception 'This person is not accepting messages.' using errcode = 'PT403';
    end if;
  end if;

  v_rl := public.consume_rate_limit('message_send', 60, 60);
  if not coalesce((v_rl ->> 'allowed')::boolean, true) then
    raise exception 'Too many messages. Wait a moment.' using errcode = 'PT429';
  end if;

  insert into public.messages (conversation_id, sender_id, body, client_id)
  values (p_conversation, v_me, v_body, p_client_id)
  returning * into v_msg;

  update public.conversations c
     set last_message_id = v_msg.id,
         last_message_at = v_msg.created_at,
         updated_at      = now()
   where c.id = p_conversation;

  -- A thread the other side had left comes back when you write to them.
  if v_other.user_id is not null and v_other.left_at is not null then
    update public.conversation_members
       set left_at = null
     where conversation_id = p_conversation and user_id = v_other.user_id;
  end if;

  -- One unread "new message" notification per thread per person, and it carries NO message
  -- text: the notification table is exported, retained and searched differently from the
  -- thread, and the body has no business living twice.
  select coalesce(p.display_name, p.full_name, 'Bir oyuncu') into v_sender
    from public.profiles p where p.id = v_me;

  insert into public.notifications (user_id, type, title, body, data)
  select cm.user_id,
         'message.received',
         v_sender,
         'Sana yeni bir mesaj gönderdi.',
         jsonb_build_object('conversationId', p_conversation::text, 'senderId', v_me::text)
    from public.conversation_members cm
   where cm.conversation_id = p_conversation
     and cm.user_id <> v_me
     and cm.muted_at is null
     and not exists (
       select 1 from public.notifications n
        where n.user_id = cm.user_id
          and n.type = 'message.received'
          and n.read_at is null
          and n.data ->> 'conversationId' = p_conversation::text
     );

  return v_msg;
end;
$send_message$;

create or replace function public.mark_conversation_read(p_conversation uuid)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $mark_conversation_read$
declare
  v_me  uuid := (select auth.uid());
  v_now timestamptz := now();
begin
  if v_me is null then
    raise exception 'Sign in first.' using errcode = 'PT401';
  end if;

  update public.conversation_members
     set last_read_at = v_now
   where conversation_id = p_conversation and user_id = v_me;
  if not found then
    raise exception 'You are not in this conversation.' using errcode = 'PT403';
  end if;

  update public.notifications n
     set read_at = v_now
   where n.user_id = v_me
     and n.type = 'message.received'
     and n.read_at is null
     and n.data ->> 'conversationId' = p_conversation::text;

  return v_now;
end;
$mark_conversation_read$;

create or replace function public.set_conversation_muted(p_conversation uuid, p_muted boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $set_conversation_muted$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'Sign in first.' using errcode = 'PT401';
  end if;
  update public.conversation_members
     set muted_at = case when p_muted then coalesce(muted_at, now()) else null end
   where conversation_id = p_conversation and user_id = v_me;
  if not found then
    raise exception 'You are not in this conversation.' using errcode = 'PT403';
  end if;
  return p_muted;
end;
$set_conversation_muted$;

create or replace function public.leave_conversation(p_conversation uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $leave_conversation$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'Sign in first.' using errcode = 'PT401';
  end if;
  perform public.mark_conversation_read(p_conversation);
  update public.conversation_members
     set left_at = now()
   where conversation_id = p_conversation and user_id = v_me;
  return found;
end;
$leave_conversation$;

-- delete_message: the sender unsends. The row stays as a tombstone.
create or replace function public.delete_message(p_message uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $delete_message$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'Sign in first.' using errcode = 'PT401';
  end if;
  update public.messages m
     set body = '', deleted_at = now()
   where m.id = p_message
     and m.sender_id = v_me
     and m.deleted_at is null;
  return found;
end;
$delete_message$;

create or replace function public.block_user(p_user uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $block_user$
declare
  v_me uuid := (select auth.uid());
  v_rl jsonb;
begin
  if v_me is null then
    raise exception 'Sign in first.' using errcode = 'PT401';
  end if;
  if p_user is null or p_user = v_me then
    raise exception 'You cannot block yourself.' using errcode = 'PT422';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user) then
    raise exception 'No such person.' using errcode = 'PT404';
  end if;
  v_rl := public.consume_rate_limit('block_user', 30, 3600);
  if not coalesce((v_rl ->> 'allowed')::boolean, true) then
    raise exception 'Too many changes. Try again later.' using errcode = 'PT429';
  end if;

  insert into public.user_blocks (blocker_id, blocked_id)
  values (v_me, p_user)
  on conflict do nothing;

  perform public.log_audit('messaging.user_blocked', 'profiles', p_user, '{}'::jsonb);
  return true;
end;
$block_user$;

create or replace function public.unblock_user(p_user uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $unblock_user$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null then
    raise exception 'Sign in first.' using errcode = 'PT401';
  end if;
  delete from public.user_blocks b where b.blocker_id = v_me and b.blocked_id = p_user;
  return found;
end;
$unblock_user$;

-- report_message: any member of the thread may report a message in it. Admins are told;
-- they act on the excerpt and never open the thread.
create or replace function public.report_message(
  p_message uuid,
  p_reason  text,
  p_details text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $report_message$
declare
  v_me  uuid := (select auth.uid());
  v_msg public.messages;
  v_id  uuid;
  v_rl  jsonb;
begin
  if v_me is null then
    raise exception 'Sign in first.' using errcode = 'PT401';
  end if;
  if p_reason is null or p_reason not in ('harassment', 'spam', 'inappropriate', 'other') then
    raise exception 'Choose a reason.' using errcode = 'PT422';
  end if;

  select m.* into v_msg from public.messages m where m.id = p_message;
  if not found then
    raise exception 'No such message.' using errcode = 'PT404';
  end if;
  if not (select private.is_conversation_member(v_msg.conversation_id)) then
    raise exception 'You are not in this conversation.' using errcode = 'PT403';
  end if;
  if v_msg.sender_id = v_me then
    raise exception 'You cannot report your own message.' using errcode = 'PT422';
  end if;

  v_rl := public.consume_rate_limit('report_message', 10, 3600);
  if not coalesce((v_rl ->> 'allowed')::boolean, true) then
    raise exception 'Too many reports. Try again later.' using errcode = 'PT429';
  end if;

  insert into public.message_reports (message_id, reporter_id, reason, details, excerpt)
  values (
    p_message, v_me, p_reason,
    nullif(left(btrim(coalesce(p_details, '')), 1000), ''),
    left(v_msg.body, 500)
  )
  returning id into v_id;

  perform private.notify_admins(
    'message.reported',
    'Bir mesaj bildirildi',
    'Sebep: ' || p_reason || '. Yönetim panelinden incele.',
    jsonb_build_object('reportId', v_id::text, 'messageId', p_message::text)
  );

  return v_id;
end;
$report_message$;


-- =============================================================================
-- 5. Read RPCs — the shapes the screens need in one round trip
-- =============================================================================

-- The inbox. Newest thread first; each with its counterpart, its last message (blank when
-- unsent or redacted) and how many messages are unread for the caller.
create or replace function public.my_conversations()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $my_conversations$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',            x.id,
        'bookingId',     x.booking_id,
        'lastMessageAt', x.last_message_at,
        'mutedAt',       x.muted_at,
        'lastReadAt',    x.last_read_at,
        'unreadCount',   x.unread_count,
        'counterpart',   x.counterpart,
        'lastMessage',   x.last_message
      )
      order by x.last_message_at desc nulls last, x.id
    ),
    '[]'::jsonb
  )
  from (
    select
      c.id,
      c.booking_id,
      c.last_message_at,
      cm.muted_at,
      cm.last_read_at,
      (
        select count(*)
          from public.messages m
         where m.conversation_id = c.id
           and m.sender_id <> cm.user_id
           and m.deleted_at is null
           and m.created_at > coalesce(cm.last_read_at, 'epoch'::timestamptz)
      ) as unread_count,
      (
        select jsonb_build_object(
                 'id',          p.id,
                 'displayName', coalesce(p.display_name, p.full_name),
                 'avatarUrl',   p.avatar_url,
                 'accentColor', p.accent_color,
                 'role',        p.role,
                 'erased',      p.deleted_at is not null
               )
          from public.conversation_members o
          join public.profiles p on p.id = o.user_id
         where o.conversation_id = c.id
           and o.user_id <> cm.user_id
         limit 1
      ) as counterpart,
      (
        select jsonb_build_object(
                 'id',        m.id,
                 'senderId',  m.sender_id,
                 'body',      case when m.deleted_at is not null or m.redacted_at is not null
                                   then '' else left(m.body, 140) end,
                 'removed',   m.deleted_at is not null or m.redacted_at is not null,
                 'createdAt', m.created_at
               )
          from public.messages m
         where m.id = c.last_message_id
      ) as last_message
    from public.conversations c
    join public.conversation_members cm
      on cm.conversation_id = c.id
     and cm.user_id = (select auth.uid())
     and cm.left_at is null
  ) x;
$my_conversations$;

-- Threads with something unread. This is the badge in the header.
create or replace function public.unread_conversation_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $unread_conversation_count$
  select count(*)::integer
    from public.conversation_members cm
   where cm.user_id = (select auth.uid())
     and cm.left_at is null
     and exists (
       select 1 from public.messages m
        where m.conversation_id = cm.conversation_id
          and m.sender_id <> cm.user_id
          and m.deleted_at is null
          and m.created_at > coalesce(cm.last_read_at, 'epoch'::timestamptz)
     );
$unread_conversation_count$;

-- The people the caller has blocked, with enough of a profile to recognise them.
create or replace function public.my_blocks()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $my_blocks$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',          p.id,
        'displayName', coalesce(p.display_name, p.full_name),
        'avatarUrl',   p.avatar_url,
        'accentColor', p.accent_color,
        'blockedAt',   b.created_at
      )
      order by b.created_at desc
    ),
    '[]'::jsonb
  )
  from public.user_blocks b
  join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = (select auth.uid());
$my_blocks$;


-- =============================================================================
-- 6. RLS and grants
-- =============================================================================

alter table public.user_blocks          enable row level security;
alter table public.user_blocks          force  row level security;
alter table public.conversations        enable row level security;
alter table public.conversations        force  row level security;
alter table public.conversation_members enable row level security;
alter table public.conversation_members force  row level security;
alter table public.messages             enable row level security;
alter table public.messages             force  row level security;
alter table public.message_reports      enable row level security;
alter table public.message_reports      force  row level security;

-- Supabase's default privileges hand ALL on every new public table to anon and authenticated.
-- Strip that first; then reads only. No INSERT/UPDATE/DELETE grant on any of these: the RPCs
-- above are the writers, and the self-test at the bottom fails the migration if that changes.
revoke all on table public.user_blocks          from public, anon, authenticated;
revoke all on table public.conversations        from public, anon, authenticated;
revoke all on table public.conversation_members from public, anon, authenticated;
revoke all on table public.messages             from public, anon, authenticated;
revoke all on table public.message_reports      from public, anon, authenticated;

grant select on table public.user_blocks          to authenticated;
grant select on table public.conversations        to authenticated;
grant select on table public.conversation_members to authenticated;
grant select on table public.messages             to authenticated;
grant select on table public.message_reports      to authenticated;
grant update (resolved_at, resolved_by) on table public.message_reports to authenticated;

drop policy if exists user_blocks_select_own on public.user_blocks;
create policy user_blocks_select_own
  on public.user_blocks
  for select
  to authenticated
  using (blocker_id = (select auth.uid()));

drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member
  on public.conversations
  for select
  to authenticated
  using ((select private.is_conversation_member(id)));

drop policy if exists conversation_members_select_member on public.conversation_members;
create policy conversation_members_select_member
  on public.conversation_members
  for select
  to authenticated
  using ((select private.is_conversation_member(conversation_id)));

-- No admin branch on purpose. Moderation reads the report's excerpt, not the thread.
drop policy if exists messages_select_member on public.messages;
create policy messages_select_member
  on public.messages
  for select
  to authenticated
  using ((select private.is_conversation_member(conversation_id)));

drop policy if exists message_reports_select_reporter_or_admin on public.message_reports;
create policy message_reports_select_reporter_or_admin
  on public.message_reports
  for select
  to authenticated
  using (reporter_id = (select auth.uid()) or (select private.is_admin()));

drop policy if exists message_reports_update_admin on public.message_reports;
create policy message_reports_update_admin
  on public.message_reports
  for update
  to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

revoke all on function private.is_conversation_member(uuid)    from public;
revoke all on function private.is_blocked_between(uuid, uuid)  from public;
revoke all on function private.has_booking_relationship(uuid)  from public;
grant execute on function private.is_conversation_member(uuid)   to authenticated;
grant execute on function private.is_blocked_between(uuid, uuid) to authenticated;
grant execute on function private.has_booking_relationship(uuid) to authenticated;

revoke all on function public.can_message(uuid)                        from public, anon;
revoke all on function public.open_conversation(uuid)                  from public, anon;
revoke all on function public.send_message(uuid, text, text)           from public, anon;
revoke all on function public.mark_conversation_read(uuid)             from public, anon;
revoke all on function public.set_conversation_muted(uuid, boolean)    from public, anon;
revoke all on function public.leave_conversation(uuid)                 from public, anon;
revoke all on function public.delete_message(uuid)                     from public, anon;
revoke all on function public.block_user(uuid)                         from public, anon;
revoke all on function public.unblock_user(uuid)                       from public, anon;
revoke all on function public.report_message(uuid, text, text)         from public, anon;
revoke all on function public.my_conversations()                       from public, anon;
revoke all on function public.unread_conversation_count()              from public, anon;
revoke all on function public.my_blocks()                              from public, anon;

grant execute on function public.can_message(uuid)                     to authenticated;
grant execute on function public.open_conversation(uuid)               to authenticated;
grant execute on function public.send_message(uuid, text, text)        to authenticated;
grant execute on function public.mark_conversation_read(uuid)          to authenticated;
grant execute on function public.set_conversation_muted(uuid, boolean) to authenticated;
grant execute on function public.leave_conversation(uuid)              to authenticated;
grant execute on function public.delete_message(uuid)                  to authenticated;
grant execute on function public.block_user(uuid)                      to authenticated;
grant execute on function public.unblock_user(uuid)                    to authenticated;
grant execute on function public.report_message(uuid, text, text)      to authenticated;
grant execute on function public.my_conversations()                    to authenticated;
grant execute on function public.unread_conversation_count()           to authenticated;
grant execute on function public.my_blocks()                           to authenticated;


-- =============================================================================
-- 7. Realtime — messages and conversations join the publication
-- =============================================================================
-- Same guarded shape as 0006 §1. `messages` streams a thread to its members (RLS decides per
-- subscriber); `conversations` streams the last_message_at bump that reorders the inbox;
-- `conversation_members` streams a read mark made on another device so the badge here clears.

do $publication$
declare
  v_table      text;
  v_tables     text[] := array['messages', 'conversations', 'conversation_members'];
  v_all_tables boolean;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'create publication supabase_realtime with (publish = ''insert,update,delete'')';
  end if;

  select p.puballtables into v_all_tables from pg_publication p where p.pubname = 'supabase_realtime';

  if not v_all_tables then
    foreach v_table in array v_tables loop
      if not exists (
        select 1 from pg_publication_tables pt
         where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public' and pt.tablename = v_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
        raise notice '0011: added public.% to supabase_realtime', v_table;
      end if;
    end loop;
  end if;
exception
  when others then
    raise notice '0011: publication step skipped (%).', sqlerrm;
end
$publication$;


-- =============================================================================
-- 8. GDPR — export, erasure, retention
-- =============================================================================

-- Art. 15/20. Replaces the 0003 function body verbatim and adds the messaging keys. Received
-- messages are NOT exported: they are the other party's words, present in their own export.
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
    'export_format_version', 2,
    'generated_at',          to_jsonb(now()),
    'subject_id',            to_jsonb(v_uid),
    'legal_basis',           'GDPR Art. 15 (right of access) and Art. 20 (data portability).',
    'notes',                 'Consent token digests and IP digests are omitted: they are security artefacts, not data you provided. Messages you received are not included; they belong to their authors and appear in their exports.',

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
    'conversations', (
      select coalesce(jsonb_agg(to_jsonb(cm) order by cm.joined_at), '[]'::jsonb)
        from public.conversation_members cm where cm.user_id = v_uid
    ),
    'messages_sent', (
      select coalesce(jsonb_agg((to_jsonb(m) - 'client_id') order by m.created_at), '[]'::jsonb)
        from public.messages m where m.sender_id = v_uid
    ),
    'blocks', (
      select coalesce(jsonb_agg(to_jsonb(b) order by b.created_at), '[]'::jsonb)
        from public.user_blocks b where b.blocker_id = v_uid
    ),
    'message_reports_filed', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at), '[]'::jsonb)
        from public.message_reports r where r.reporter_id = v_uid
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

-- Art. 17. The 0003 body, plus: sent messages are redacted in place (the other party keeps a
-- thread that says "message removed" — deleting their copy would be erasing THEIR record of a
-- conversation they had), every membership is left, every block in either direction is
-- dropped, and the customisation columns go back to defaults so the pseudonymised row has no
-- stylistic fingerprint. Report excerpts are retained (Art. 17(3)(e)).
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
  v_messages  integer;
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
         accent_color             = 'gold',
         banner_shot              = 'stands',
         tagline                  = null,
         jersey_number            = null,
         dominant_foot            = null,
         messaging_policy         = 'nobody',
         deleted_at               = now()
   where p.id = v_uid;

  update public.bookings b
     set notes = null
   where b.booked_by = v_uid
     and b.notes is not null;

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

  delete from public.notifications n where n.user_id = v_uid;

  -- Messaging.
  update public.messages m
     set body = '', redacted_at = now()
   where m.sender_id = v_uid
     and m.redacted_at is null;
  get diagnostics v_messages = row_count;

  update public.conversation_members cm
     set left_at = coalesce(cm.left_at, now())
   where cm.user_id = v_uid;

  delete from public.user_blocks b where b.blocker_id = v_uid or b.blocked_id = v_uid;

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
      'pseudonym_prefix',   v_short,
      'retained_bookings',  v_bookings,
      'redacted_messages',  v_messages,
      'retention_basis',    'GDPR Art. 17(3)(b)/(e); VUK art. 253 (5y); TTK art. 82 (10y)'
    )
  );

  return jsonb_build_object(
    'status',                 'erased',
    'subject_id',             v_uid,
    'erased_at',              to_jsonb(now()),
    'retained_booking_count', v_bookings,
    'redacted_message_count', v_messages,
    'retention_note',         'Booking and payment records are kept in pseudonymised form for the statutory accounting retention period (VUK art. 253 / TTK art. 82) under GDPR Art. 17(3)(b). Messages you sent are cleared in place; the people you wrote to keep a thread that shows a removed message.'
  );
end;
$request_account_erasure$;

-- Retention (Art. 5(1)(e)). Messages are not a record of anything the platform needs; a year
-- is generous for "what did we agree about Saturday". Tombstones go sooner.
create or replace function public.purge_old_messages(p_keep_days integer default 365)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $purge_old_messages$
declare
  v_count integer;
  v_tomb  integer;
begin
  delete from public.messages m
   where m.created_at < now() - make_interval(days => greatest(p_keep_days, 30));
  get diagnostics v_count = row_count;

  delete from public.messages m
   where m.deleted_at is not null
     and m.deleted_at < now() - interval '30 days'
     and not exists (select 1 from public.message_reports r where r.message_id = m.id and r.resolved_at is null);
  get diagnostics v_tomb = row_count;

  -- A thread with no messages left and nobody in it is just a row.
  delete from public.conversations c
   where not exists (select 1 from public.messages m where m.conversation_id = c.id)
     and not exists (select 1 from public.conversation_members cm where cm.conversation_id = c.id and cm.left_at is null);

  return v_count + v_tomb;
end;
$purge_old_messages$;

revoke all on function public.purge_old_messages(integer) from public, anon, authenticated;
grant execute on function public.purge_old_messages(integer) to service_role;

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0011: pg_cron not installed; schedule purge_old_messages() externally.';
    return;
  end if;

  perform cron.unschedule('onpitch-purge-messages')
    where exists (select 1 from cron.job where jobname = 'onpitch-purge-messages');
  perform cron.schedule(
    'onpitch-purge-messages',
    '10 4 * * *',
    $job$select public.purge_old_messages();$job$
  );

  raise notice '0011: cron job onpitch-purge-messages scheduled.';
exception
  when others then
    raise notice '0011: cron scheduling skipped (%).', sqlerrm;
end
$cron$;


-- =============================================================================
-- 9. Self-test — the two rules that must never regress
-- =============================================================================

do $selftest$
declare
  v_ok boolean;
begin
  -- No role may INSERT into a messaging table directly.
  select not exists (
    select 1 from information_schema.role_table_grants g
     where g.table_schema = 'public'
       and g.table_name in ('messages', 'conversations', 'conversation_members', 'user_blocks', 'message_reports')
       and g.grantee in ('authenticated', 'anon')
       and g.privilege_type in ('INSERT', 'DELETE')
  ) into v_ok;
  if not v_ok then
    raise exception '0011 self-test: a client role holds INSERT/DELETE on a messaging table';
  end if;

  -- The Art. 8 constraint exists.
  if not exists (select 1 from pg_constraint where conname = 'profiles_minor_messaging_locked_check') then
    raise exception '0011 self-test: profiles_minor_messaging_locked_check missing';
  end if;

  raise notice '0011 self-test passed.';
end
$selftest$;
