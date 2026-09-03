-- =============================================================================
-- OnPitch — 0010_hardening.sql
-- Rate limiting that survives a serverless deployment.
--
-- WHAT THIS FILE OWNS
--   * public.rate_limits             — a counter table shared by every instance
--   * public.consume_rate_limit      — the caller-scoped limiter
--   * public.consume_rate_limit_for  — the service-role variant, for IP subjects
--   * public.purge_rate_limits       — keeps the table bounded
--   * one cron job
--
-- DEPENDS ON: 0001 (audit_log), 0002 (RLS conventions).
--
-- NOT here: the nightly re-touch of profiles whose `is_minor` snapshot has gone
-- stale. `public.refresh_aged_out_minors` already exists in 0007 §4a, and its
-- UPDATE names `parental_consent_status` in the SET list on purpose — the audit
-- trigger is `after update OF parental_consent_status`, so a version that only
-- touched `updated_at` would age accounts out silently and unaudited.
-- =============================================================================

set search_path = public, extensions;


-- =============================================================================
-- 1. Rate limiting
-- =============================================================================
-- IN POSTGRES, NOT IN MEMORY. The web app runs on serverless instances that do
-- not share a heap: an in-process counter limits each cold-started lambda
-- separately, which is to say it does not limit anything. One table, one
-- statement, shared by every instance and by the mobile client's own traffic.
--
-- FIXED WINDOWS, not sliding. A fixed window permits up to 2x the limit across a
-- boundary — ten requests at 11:59:59 and ten more at 12:00:00. That is the
-- honest trade for a single UPDATE per check and no per-request row history, and
-- it is acceptable because these limits exist to stop abuse and runaway clients,
-- not to meter anything anybody is billed for. If a limit ever becomes
-- commercial, replace this with a token bucket rather than tightening the number.

create table if not exists public.rate_limits (
  /** What is being limited, e.g. 'checkout', 'score_report'. */
  bucket       text not null check (bucket ~ '^[a-z][a-z0-9_]{1,39}$'),
  /**
   * Who is being limited: 'user:<uuid>' for a signed-in caller, or 'ip:<sha256>'
   * for an anonymous one. An IP is hashed before it gets here — the limiter has
   * no reason to hold an address in the clear, and this table is not the place
   * to start keeping one.
   */
  subject      text not null check (length(subject) between 3 and 128),
  window_start timestamptz not null,
  count        integer not null default 0 check (count >= 0),
  updated_at   timestamptz not null default now(),
  primary key (bucket, subject, window_start)
);

comment on table public.rate_limits is
  'Fixed-window request counters. Written only by consume_rate_limit(); no role holds INSERT or UPDATE.';

-- The purge scans by age, and only by age.
create index if not exists idx_rate_limits_window on public.rate_limits (window_start);


/**
 * Spends one unit of the caller's budget and reports what is left.
 *
 * Reads `auth.uid()` itself rather than taking a subject, so a client cannot
 * spend somebody else's budget or claim to be somebody it is not — the same
 * reason `my_progress()` and `claim_challenge()` take no identity argument.
 *
 * Returns `{ allowed, limit, remaining, resetAt, retryAfterSeconds }`. It does
 * NOT raise on refusal: a 429 is a normal answer with a body, and raising would
 * abort whatever transaction the caller had open.
 */
create or replace function public.consume_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  return private.consume_rate_limit_core('user:' || v_user::text, p_bucket, p_limit, p_window_seconds);
end;
$$;

/**
 * The same limiter keyed on a subject the SERVER computes — a hashed IP for an
 * unauthenticated caller, a Stripe account id for a webhook storm.
 *
 * service_role only, because a subject argument is exactly the thing a client
 * must not be allowed to choose: it could otherwise spend a stranger's budget or
 * mint itself an unlimited one.
 */
create or replace function public.consume_rate_limit_for(
  p_subject        text,
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.consume_rate_limit_core(p_subject, p_bucket, p_limit, p_window_seconds);
end;
$$;

create or replace function private.consume_rate_limit_core(
  p_subject        text,
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window  integer := greatest(1, least(86400, coalesce(p_window_seconds, 60)));
  v_limit   integer := greatest(1, least(100000, coalesce(p_limit, 60)));
  v_start   timestamptz;
  v_count   integer;
begin
  if p_subject is null or p_bucket is null then
    raise exception 'A rate limit needs a subject and a bucket' using errcode = '22023';
  end if;

  -- Floor the clock to the window. Every instance computes the same boundary from
  -- the database's own clock, so nothing depends on the app servers agreeing.
  v_start := to_timestamp(floor(extract(epoch from now()) / v_window) * v_window);

  -- ON CONFLICT DO UPDATE is the whole concurrency story: the row is locked for
  -- the duration of the statement, so two instances cannot both read 9 and write 10.
  insert into public.rate_limits (bucket, subject, window_start, count)
  values (p_bucket, p_subject, v_start, 1)
  on conflict (bucket, subject, window_start) do update
    set count = public.rate_limits.count + 1,
        updated_at = now()
  returning count into v_count;

  return jsonb_build_object(
    'allowed', v_count <= v_limit,
    'limit', v_limit,
    'remaining', greatest(0, v_limit - v_count),
    'resetAt', v_start + make_interval(secs => v_window),
    'retryAfterSeconds', greatest(
      1,
      ceil(extract(epoch from (v_start + make_interval(secs => v_window)) - now()))::integer
    )
  );
end;
$$;

/** Nightly: drop windows nothing can still be counting against. */
create or replace function public.purge_rate_limits(p_keep_hours integer default 48)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.rate_limits
   where window_start < now() - make_interval(hours => greatest(1, least(720, coalesce(p_keep_hours, 48))));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


-- =============================================================================
-- 2. RLS and grants
-- =============================================================================
-- The counter table is machine state, not user data. No role reads it and no
-- role writes it directly: every path goes through a SECURITY DEFINER function,
-- which is what stops a client resetting its own counter.

alter table public.rate_limits enable row level security;
alter table public.rate_limits force  row level security;
revoke all on table public.rate_limits from anon, authenticated;

-- RLS is enabled with no policy at all, which denies everything by default. That
-- is deliberate and is what the CI gate checks for; a policy here would be a way in.

revoke all on function private.consume_rate_limit_core(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.consume_rate_limit_for(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.purge_rate_limits(integer) from public, anon, authenticated;

grant execute on function public.consume_rate_limit(text, integer, integer) to authenticated;
grant execute on function public.consume_rate_limit_for(text, text, integer, integer) to service_role;
grant execute on function public.purge_rate_limits(integer) to service_role;


-- =============================================================================
-- 3. Cron
-- =============================================================================

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0010: pg_cron not installed; schedule purge_rate_limits() externally.';
    return;
  end if;

  perform cron.unschedule('onpitch-purge-rate-limits')
    where exists (select 1 from cron.job where jobname = 'onpitch-purge-rate-limits');
  perform cron.schedule(
    'onpitch-purge-rate-limits',
    '50 3 * * *',
    $job$select public.purge_rate_limits();$job$
  );

  raise notice '0010: cron job onpitch-purge-rate-limits scheduled.';
exception
  when others then
    raise notice '0010: cron scheduling skipped (%).', sqlerrm;
end
$cron$;


-- =============================================================================
-- 4. Self-test
-- =============================================================================

do $test$
declare
  v_fail text := '';
  v_res  jsonb;
  v_sub  text := 'test:' || gen_random_uuid()::text;
begin
  -- Three requests against a limit of two: the third must be refused, and the
  -- remaining count must never go negative.
  v_res := private.consume_rate_limit_core(v_sub, 'selftest', 2, 60);
  if (v_res ->> 'allowed')::boolean is not true then v_fail := v_fail || ' first-refused'; end if;
  if (v_res ->> 'remaining')::integer <> 1 then v_fail := v_fail || ' first-remaining'; end if;

  v_res := private.consume_rate_limit_core(v_sub, 'selftest', 2, 60);
  if (v_res ->> 'allowed')::boolean is not true then v_fail := v_fail || ' second-refused'; end if;
  if (v_res ->> 'remaining')::integer <> 0 then v_fail := v_fail || ' second-remaining'; end if;

  v_res := private.consume_rate_limit_core(v_sub, 'selftest', 2, 60);
  if (v_res ->> 'allowed')::boolean is not false then v_fail := v_fail || ' third-allowed'; end if;
  if (v_res ->> 'remaining')::integer <> 0 then v_fail := v_fail || ' third-remaining'; end if;
  if (v_res ->> 'retryAfterSeconds')::integer < 1 then v_fail := v_fail || ' retry-after'; end if;

  delete from public.rate_limits where subject = v_sub;

  if v_fail <> '' then
    raise exception '0010 self-test failed:%', v_fail;
  end if;

  raise notice '0010: rate limiter self-test passed.';
end
$test$;
