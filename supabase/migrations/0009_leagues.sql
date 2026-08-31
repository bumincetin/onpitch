-- =============================================================================
-- Halisaha — 0009_leagues.sql
-- City leagues: five divisions, seasons, promotion and relegation.
--
-- WHAT THIS FILE OWNS
--   * public.league_seasons    — one 13-week season per city
--   * public.league_entries    — a team's place and record in a division
--   * public.league_results    — which matches have been counted, keyed by match
--   * public.record_match_in_league — the trigger path from a finalized match
--   * public.league_table      — the standings, ordered the way football orders them
--   * public.my_leagues        — the caller's own teams' positions
--   * public.close_season      — ranks, promotes, relegates, seeds the next season
--   * one cron job that rolls seasons over nightly
--
-- DEPENDS ON: 0001 (teams, matches), 0002 (RLS conventions), 0008 (award_xp).
--
-- ---------------------------------------------------------------------------
-- THE SHAPE OF A LEAGUE
-- ---------------------------------------------------------------------------
-- A league is a CITY. Amateur football is local — nobody drives from Kadıköy to
-- Ankara for a Tuesday night game — so a national table would rank people who
-- can never play each other. Within a city there are five divisions, bronze
-- through diamond, and a team moves between them at the end of a season.
--
-- A match counts toward the league when it is finalized, has two teams, has a
-- score, and BOTH TEAMS ARE FROM THE SAME CITY. That last condition is what
-- keeps the table honest: a friendly against a side from another city is still
-- football, still rated by TrueSkill, still worth XP — it just is not a league
-- fixture, because it is not a fixture either side's rivals can be measured
-- against.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCE
-- ---------------------------------------------------------------------------
-- `league_results` is keyed on `match_id`. Counting a match twice is therefore
-- impossible rather than merely unlikely: the second insert conflicts and the
-- standings update is skipped. Same discipline as `xp_events.dedupe_key` in
-- 0008 and `stripe_events.id` in 0001 — a trigger that can fire twice must be
-- written so that it does not matter.
-- =============================================================================

set search_path = public, extensions;


-- =============================================================================
-- 1. Enums
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'league_division') then
    -- Ordered bronze -> diamond. The ORDER MATTERS: private.division_rank()
    -- depends on it, and inserting a value in the middle later would silently
    -- renumber every division above it. Append only.
    create type public.league_division as enum ('bronze', 'silver', 'gold', 'platinum', 'diamond');
  end if;

  if not exists (select 1 from pg_type where typname = 'season_status') then
    create type public.season_status as enum ('upcoming', 'active', 'closed');
  end if;

  if not exists (select 1 from pg_type where typname = 'league_movement') then
    create type public.league_movement as enum ('promoted', 'held', 'relegated');
  end if;
end
$$;

/** 1 for bronze, 5 for diamond. IMMUTABLE so it can be used in generated columns and indexes. */
create or replace function private.division_rank(p_division public.league_division)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_division
           when 'bronze'   then 1
           when 'silver'   then 2
           when 'gold'     then 3
           when 'platinum' then 4
           when 'diamond'  then 5
         end;
$$;

/** The inverse, clamped. Moving up from diamond or down from bronze stays put. */
create or replace function private.division_at(p_rank integer)
returns public.league_division
language sql
immutable
parallel safe
set search_path = ''
as $$
  select (array['bronze', 'silver', 'gold', 'platinum', 'diamond']::public.league_division[])[
           greatest(1, least(5, coalesce(p_rank, 1)))
         ];
$$;


-- =============================================================================
-- 2. Tables
-- =============================================================================

/**
 * A season is thirteen weeks, aligned to a fixed epoch so every city's seasons
 * start on the same Monday. Alignment is not cosmetic: it is what lets a player
 * who moves city carry a comparable record, and what stops "season 3" meaning
 * two different date ranges in two different tables.
 */
create table if not exists public.league_seasons (
  id         uuid primary key default gen_random_uuid(),
  city       text not null check (length(btrim(city)) between 1 and 80),
  name       text not null,
  starts_on  date not null,
  ends_on    date not null,
  status     public.season_status not null default 'active',
  closed_at  timestamptz,
  created_at timestamptz not null default now(),

  constraint league_seasons_window_check check (ends_on > starts_on),
  constraint league_seasons_unique unique (city, starts_on)
);

comment on table public.league_seasons is
  'One 13-week season per city, aligned to a fixed epoch so every city runs the same calendar.';

create index if not exists idx_league_seasons_city_status
  on public.league_seasons (city, status, starts_on desc);
create index if not exists idx_league_seasons_open
  on public.league_seasons (ends_on) where status = 'active';


/**
 * A team's place and record in one division of one season.
 *
 * `points` and `goal_difference` are GENERATED, so a standings row can never
 * disagree with the results behind it — the same reason `player_progress.level`
 * is generated from XP in 0008.
 */
create table if not exists public.league_entries (
  season_id       uuid not null references public.league_seasons (id) on delete cascade,
  team_id         uuid not null references public.teams (id) on delete cascade,
  division        public.league_division not null default 'bronze',

  played          integer not null default 0 check (played >= 0),
  won             integer not null default 0 check (won >= 0),
  drawn           integer not null default 0 check (drawn >= 0),
  lost            integer not null default 0 check (lost >= 0),
  goals_for       integer not null default 0 check (goals_for >= 0),
  goals_against   integer not null default 0 check (goals_against >= 0),

  goal_difference integer generated always as (goals_for - goals_against) stored,
  /** Three for a win, one for a draw. The only scoring amateur football recognises. */
  points          integer generated always as (won * 3 + drawn) stored,

  /** Written by close_season(): where the team finished and what happened to it. */
  final_rank      integer check (final_rank is null or final_rank > 0),
  movement        public.league_movement,

  joined_at       timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (season_id, team_id),
  constraint league_entries_played_adds_up_check check (played = won + drawn + lost)
);

comment on table public.league_entries is
  'One row per team per season. points and goal_difference are generated, so a table row cannot disagree with its results.';

create index if not exists idx_league_entries_team on public.league_entries (team_id);
create index if not exists idx_league_entries_season on public.league_entries (season_id);
-- The standings query, exactly: one division of one season, football's own order.
create index if not exists idx_league_entries_standings
  on public.league_entries (season_id, division, points desc, goal_difference desc, goals_for desc);


/**
 * Which matches have been counted. Keyed on the match, so counting one twice is
 * impossible rather than unlikely.
 */
create table if not exists public.league_results (
  match_id     uuid primary key references public.matches (id) on delete cascade,
  season_id    uuid not null references public.league_seasons (id) on delete cascade,
  home_team_id uuid not null references public.teams (id) on delete cascade,
  away_team_id uuid not null references public.teams (id) on delete cascade,
  home_score   integer not null check (home_score >= 0),
  away_score   integer not null check (away_score >= 0),
  counted_at   timestamptz not null default now()
);

create index if not exists idx_league_results_season on public.league_results (season_id);
create index if not exists idx_league_results_home on public.league_results (home_team_id);
create index if not exists idx_league_results_away on public.league_results (away_team_id);

drop trigger if exists trg_league_entries_set_updated_at on public.league_entries;
create trigger trg_league_entries_set_updated_at
  before update on public.league_entries
  for each row execute function public.set_updated_at();


-- =============================================================================
-- 3. Seasons
-- =============================================================================

/** Monday the seasons are counted from. Everything else is arithmetic on this. */
create or replace function private.season_epoch()
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$ select date '2026-01-05'; $$;

create or replace function private.season_start_for(p_on date)
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- Thirteen weeks. Integer division on the day count, so the boundary is exact
  -- and does not drift with month lengths the way `date_trunc('quarter')` would.
  select private.season_epoch()
       + (floor((p_on - private.season_epoch())::numeric / 91)::integer * 91);
$$;

/**
 * Opens the current season for a city if it is not open yet, and returns its id.
 *
 * Idempotent on `(city, starts_on)`, so it is safe from cron, from a trigger and
 * from a page load — which is exactly where it is called from.
 */
create or replace function public.ensure_city_season(p_city text, p_on date default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_city  text := btrim(coalesce(p_city, ''));
  v_on    date := coalesce(p_on, (now() at time zone 'utc')::date);
  v_start date;
  v_id    uuid;
  v_index integer;
begin
  if v_city = '' then
    return null;
  end if;

  v_start := private.season_start_for(v_on);
  v_index := 1 + floor((extract(doy from v_start)::integer - 1) / 91)::integer;

  insert into public.league_seasons (city, name, starts_on, ends_on, status)
  values (
    v_city,
    format('%s · %s. Sezon', to_char(v_start, 'YYYY'), v_index),
    v_start,
    v_start + 90,
    'active'
  )
  on conflict (city, starts_on) do nothing;

  select id into v_id
    from public.league_seasons
   where city = v_city and starts_on = v_start;

  return v_id;
end;
$$;


-- =============================================================================
-- 4. Enrolment
-- =============================================================================

/**
 * Puts a team into a season's table, at the division it earned.
 *
 * A team that has never played starts in bronze. A team that has starts where
 * its previous season left it: promoted teams a rung up, relegated teams a rung
 * down, everyone else where they were. The lookup walks BACK from this season
 * rather than assuming the immediately preceding one exists, because a side that
 * sat out a season should return to the division it left rather than to the
 * bottom.
 */
create or replace function private.enroll_team(p_season_id uuid, p_team_id uuid)
returns public.league_division
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start    date;
  v_city     text;
  v_prev     record;
  v_division public.league_division := 'bronze';
begin
  select starts_on, city into v_start, v_city
    from public.league_seasons where id = p_season_id;
  if v_start is null then
    return null;
  end if;

  select e.division, e.movement
    into v_prev
    from public.league_entries e
    join public.league_seasons s on s.id = e.season_id
   where e.team_id = p_team_id
     and s.city = v_city
     and s.starts_on < v_start
   order by s.starts_on desc
   limit 1;

  if found then
    v_division := case v_prev.movement
                    when 'promoted'  then private.division_at(private.division_rank(v_prev.division) + 1)
                    when 'relegated' then private.division_at(private.division_rank(v_prev.division) - 1)
                    else v_prev.division
                  end;
  end if;

  insert into public.league_entries (season_id, team_id, division)
  values (p_season_id, p_team_id, v_division)
  on conflict (season_id, team_id) do nothing;

  select division into v_division
    from public.league_entries
   where season_id = p_season_id and team_id = p_team_id;

  return v_division;
end;
$$;


-- =============================================================================
-- 5. Counting a match
-- =============================================================================

/**
 * Records one finalized match against its city's table.
 *
 * Refuses, quietly and without raising, when the match is not a league fixture:
 * no two teams, no score, not finalized, or the two teams are from different
 * cities. A trigger that raised on those would block the finalization of a
 * perfectly good friendly.
 *
 * Returns the season it counted toward, or null when it counted toward none.
 */
create or replace function public.record_match_in_league(p_match_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_match     public.matches;
  v_home_city text;
  v_away_city text;
  v_season    uuid;
  v_inserted  integer := 0;
begin
  select * into v_match from public.matches where id = p_match_id;

  if not found
     or v_match.status <> 'finalized'
     or v_match.home_team_id is null
     or v_match.away_team_id is null
     or v_match.home_score is null
     or v_match.away_score is null then
    return null;
  end if;

  select btrim(coalesce(city, '')) into v_home_city from public.teams where id = v_match.home_team_id;
  select btrim(coalesce(city, '')) into v_away_city from public.teams where id = v_match.away_team_id;

  -- Both sides must be from the same city, and that city has to be known.
  if v_home_city = '' or v_home_city is distinct from v_away_city then
    return null;
  end if;

  v_season := public.ensure_city_season(v_home_city, (v_match.kickoff_at at time zone 'utc')::date);
  if v_season is null then
    return null;
  end if;

  -- The ledger row IS the lock. If it conflicts, this match has already been
  -- counted and the standings below must not move again.
  insert into public.league_results (
    match_id, season_id, home_team_id, away_team_id, home_score, away_score
  )
  values (
    p_match_id, v_season, v_match.home_team_id, v_match.away_team_id,
    v_match.home_score, v_match.away_score
  )
  on conflict (match_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return v_season;
  end if;

  perform private.enroll_team(v_season, v_match.home_team_id);
  perform private.enroll_team(v_season, v_match.away_team_id);

  update public.league_entries
     set played        = played + 1,
         won           = won   + case when v_match.home_score > v_match.away_score then 1 else 0 end,
         drawn         = drawn + case when v_match.home_score = v_match.away_score then 1 else 0 end,
         lost          = lost  + case when v_match.home_score < v_match.away_score then 1 else 0 end,
         goals_for     = goals_for     + v_match.home_score,
         goals_against = goals_against + v_match.away_score
   where season_id = v_season and team_id = v_match.home_team_id;

  update public.league_entries
     set played        = played + 1,
         won           = won   + case when v_match.away_score > v_match.home_score then 1 else 0 end,
         drawn         = drawn + case when v_match.away_score = v_match.home_score then 1 else 0 end,
         lost          = lost  + case when v_match.away_score < v_match.home_score then 1 else 0 end,
         goals_for     = goals_for     + v_match.away_score,
         goals_against = goals_against + v_match.home_score
   where season_id = v_season and team_id = v_match.away_team_id;

  return v_season;
end;
$$;

/**
 * Fires on the same status transition that drives the progression system in
 * 0008. Separate trigger rather than a second call inside that one, so a fault
 * in either subsystem cannot take the other down with it.
 */
create or replace function private.on_match_finalized_league()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'finalized' and coalesce(old.status, 'scheduled') <> 'finalized' then
    perform public.record_match_in_league(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_match_league on public.matches;
create trigger trg_match_league
  after update of status on public.matches
  for each row execute function private.on_match_finalized_league();


-- =============================================================================
-- 6. Closing a season
-- =============================================================================

/**
 * Ranks every division, promotes, relegates, and opens the next season.
 *
 * The movement rules, and why they are what they are:
 *
 *   * Top two go up, bottom two go down. Two rather than one because amateur
 *     divisions are small and a single slot makes a season turn on one fixture.
 *   * A division needs SIX teams before anybody moves. Below that the table is
 *     not a competition, it is a handful of friendlies, and relegating somebody
 *     out of a four-team division would be arbitrary.
 *   * A team that played no fixtures is ranked last but is NOT relegated. The
 *     league should cost nothing to sit out; punishing absence would push exactly
 *     the casual sides this product is for out of the bottom division entirely.
 *   * Diamond cannot promote and bronze cannot relegate. `division_at()` clamps,
 *     but the rules say so explicitly so the intent survives a refactor.
 *
 * Idempotent: a season already `closed` returns 0 without touching anything.
 */
create or replace function public.close_season(p_season_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_season  public.league_seasons;
  v_div     public.league_division;
  v_size    integer;
  v_row     record;
  v_moved   integer := 0;
  v_next    uuid;
begin
  select * into v_season from public.league_seasons where id = p_season_id for update;
  if not found or v_season.status = 'closed' then
    return 0;
  end if;

  foreach v_div in array enum_range(null::public.league_division)
  loop
    select count(*) into v_size
      from public.league_entries
     where season_id = p_season_id and division = v_div;

    if v_size = 0 then
      continue;
    end if;

    for v_row in
      select e.team_id,
             row_number() over (
               order by e.points desc, e.goal_difference desc, e.goals_for desc, e.team_id
             )::integer as rank
        from public.league_entries e
       where e.season_id = p_season_id
         and e.division = v_div
    loop
      update public.league_entries e
         set final_rank = v_row.rank,
             movement   = case
                            -- Too small to be a competition: nobody moves.
                            when v_size < 6 then 'held'::public.league_movement
                            when v_row.rank <= 2 and v_div <> 'diamond'
                              then 'promoted'::public.league_movement
                            -- Sitting a season out costs nothing.
                            when v_row.rank > v_size - 2 and v_div <> 'bronze' and e.played > 0
                              then 'relegated'::public.league_movement
                            else 'held'::public.league_movement
                          end
       where e.season_id = p_season_id
         and e.team_id = v_row.team_id;

      v_moved := v_moved + 1;
    end loop;
  end loop;

  update public.league_seasons
     set status = 'closed', closed_at = now()
   where id = p_season_id;

  -- Tell the squads, and pay the promotions. A season that ended in silence is a
  -- season nobody noticed they were in.
  insert into public.notifications (user_id, type, title, body, data)
  select tm.player_id,
         'league.season_closed',
         case e.movement
           when 'promoted'  then 'Ligden çıktınız'
           when 'relegated' then 'Lig düşüşü'
           else 'Sezon kapandı'
         end,
         format('%s · %s ligi %s. sırada bitti.',
                t.name,
                initcap(e.division::text),
                e.final_rank),
         jsonb_build_object(
           'seasonId', p_season_id,
           'teamId', e.team_id,
           'division', e.division,
           'rank', e.final_rank,
           'movement', e.movement
         )
    from public.league_entries e
    join public.teams t on t.id = e.team_id
    join public.team_members tm on tm.team_id = e.team_id
   where e.season_id = p_season_id;

  for v_row in
    select e.team_id, e.final_rank, e.movement, tm.player_id
      from public.league_entries e
      join public.team_members tm on tm.team_id = e.team_id
     where e.season_id = p_season_id
       and (e.movement = 'promoted' or e.final_rank = 1)
  loop
    perform public.award_xp(
      v_row.player_id,
      'achievement',
      case when v_row.final_rank = 1 then 500 else 300 end,
      'league:' || p_season_id::text || ':' || v_row.team_id::text,
      null,
      null,
      jsonb_build_object('seasonId', p_season_id, 'rank', v_row.final_rank)
    );
  end loop;

  -- Open the next one and carry everybody into it, so a returning player finds a
  -- table with their team already in it rather than an empty page.
  v_next := public.ensure_city_season(v_season.city, v_season.ends_on + 1);
  if v_next is not null then
    for v_row in select team_id from public.league_entries where season_id = p_season_id
    loop
      perform private.enroll_team(v_next, v_row.team_id);
    end loop;
  end if;

  return v_moved;
end;
$$;

/** Nightly: closes every season whose window has passed. */
create or replace function public.roll_over_seasons()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    record;
  v_closed integer := 0;
begin
  for v_row in
    select id from public.league_seasons
     where status = 'active'
       and ends_on < (now() at time zone 'utc')::date
     order by ends_on
  loop
    perform public.close_season(v_row.id);
    v_closed := v_closed + 1;
  end loop;

  return v_closed;
end;
$$;


-- =============================================================================
-- 7. Read APIs
-- =============================================================================

/**
 * One division's table, in football's order: points, then goal difference, then
 * goals scored.
 *
 * SECURITY DEFINER because it joins `teams` for a name and crest. It republishes
 * only what a public team page already shows, and only for teams that ARE public
 * — `teams_select_public_or_member` is the rule being mirrored here, since the
 * definer context has stepped around it.
 */
create or replace function public.league_table(
  p_city     text,
  p_division public.league_division default 'bronze',
  p_season_id uuid default null
)
returns table (
  -- `position` is a reserved word in Postgres (it is the SQL string function), so the column
  -- that means "where you are in the table" is spelled `place`.
  place           integer,
  team_id         uuid,
  team_name       text,
  team_slug       text,
  crest_url       text,
  played          integer,
  won             integer,
  drawn           integer,
  lost            integer,
  goals_for       integer,
  goals_against   integer,
  goal_difference integer,
  points          integer
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Internal names deliberately differ from the OUT parameter names: in a SQL
  -- function the OUT names are in scope inside the body, and a CTE column called
  -- `points` beside an OUT parameter called `points` is an ambiguous reference
  -- that fails at call time rather than at create time.
  with season as (
    select s.id
      from public.league_seasons s
     where (p_season_id is not null and s.id = p_season_id)
        or (p_season_id is null
            and s.city = btrim(p_city)
            and s.status = 'active'
            and s.starts_on <= (now() at time zone 'utc')::date
            and s.ends_on   >= (now() at time zone 'utc')::date)
     order by s.starts_on desc
     limit 1
  ),
  rows as (
    select e.team_id                              as e_team,
           t.name                                 as e_name,
           t.slug                                 as e_slug,
           t.crest_url                            as e_crest,
           e.played                               as e_played,
           e.won                                  as e_won,
           e.drawn                                as e_drawn,
           e.lost                                 as e_lost,
           e.goals_for                            as e_gf,
           e.goals_against                        as e_ga,
           e.goal_difference                      as e_gd,
           e.points                               as e_points,
           row_number() over (
             order by e.points desc, e.goal_difference desc, e.goals_for desc, t.name
           )::integer                             as e_pos
      from public.league_entries e
      join season sn on sn.id = e.season_id
      join public.teams t on t.id = e.team_id
     where e.division = p_division
       and t.is_public
  )
  select r.e_pos, r.e_team, r.e_name, r.e_slug, r.e_crest,
         r.e_played, r.e_won, r.e_drawn, r.e_lost,
         r.e_gf, r.e_ga, r.e_gd, r.e_points
    from rows r
   order by r.e_pos;
$$;

/**
 * Where the caller's own teams stand, across every city they play in.
 *
 * Reads `auth.uid()` itself, so it cannot be pointed at somebody else's squad,
 * and it deliberately ignores `teams.is_public`: your own team's position is
 * yours to see whether or not the team is listed publicly.
 */
create or replace function public.my_leagues()
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

  -- Open the season for every city the caller's teams belong to, so a squad that
  -- has not played yet still appears in a table rather than nowhere.
  perform public.ensure_city_season(t.city)
     from public.teams t
     join public.team_members tm on tm.team_id = t.id
    where tm.player_id = v_user
      and t.city is not null;

  return coalesce((
    select jsonb_agg(entry order by entry->>'teamName')
      from (
        select jsonb_build_object(
                 'teamId', t.id,
                 'teamName', t.name,
                 'teamSlug', t.slug,
                 'city', s.city,
                 'seasonId', s.id,
                 'seasonName', s.name,
                 'endsOn', s.ends_on,
                 'division', e.division,
                 'position', (
                   select count(*) + 1
                     from public.league_entries o
                    where o.season_id = e.season_id
                      and o.division = e.division
                      and (o.points, o.goal_difference, o.goals_for)
                          > (e.points, e.goal_difference, e.goals_for)
                 ),
                 'teamsInDivision', (
                   select count(*) from public.league_entries o
                    where o.season_id = e.season_id and o.division = e.division
                 ),
                 'played', e.played,
                 'won', e.won,
                 'drawn', e.drawn,
                 'lost', e.lost,
                 'goalsFor', e.goals_for,
                 'goalsAgainst', e.goals_against,
                 'goalDifference', e.goal_difference,
                 'points', e.points
               ) as entry
          from public.league_entries e
          join public.league_seasons s on s.id = e.season_id
          join public.teams t on t.id = e.team_id
          join public.team_members tm on tm.team_id = t.id
         where tm.player_id = v_user
           and s.status = 'active'
           -- The CURRENT window, not merely any season still marked active. A back-dated season
           -- created by a backfill stays 'active' until the nightly rollover reaches it, and
           -- until then a player would see the same team once per open season.
           and s.starts_on <= (now() at time zone 'utc')::date
           and s.ends_on   >= (now() at time zone 'utc')::date
      ) rows
  ), '[]'::jsonb);
end;
$$;

/** Every city that has a table worth looking at, with how many teams are in it. */
create or replace function public.league_cities()
returns table (city text, season_id uuid, season_name text, ends_on date, teams integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.city,
         s.id,
         s.name,
         s.ends_on,
         count(e.team_id)::integer
    from public.league_seasons s
    left join public.league_entries e on e.season_id = s.id
   where s.status = 'active'
     -- One row per city: the season that is running today. See my_leagues() for why merely
     -- being 'active' is not enough.
     and s.starts_on <= (now() at time zone 'utc')::date
     and s.ends_on   >= (now() at time zone 'utc')::date
   group by s.city, s.id, s.name, s.ends_on
  having count(e.team_id) > 0
   order by count(e.team_id) desc, s.city;
$$;


-- =============================================================================
-- 8. Backfill
-- =============================================================================

/**
 * Counts finalized matches that predate this migration.
 *
 * Ordered by kick-off so the standings accumulate in the order the football was
 * actually played, and batched so it can be run repeatedly until it returns 0.
 * service_role only.
 */
create or replace function public.backfill_leagues(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  record;
  v_done integer := 0;
begin
  for v_row in
    select m.id
      from public.matches m
     where m.status = 'finalized'
       and m.home_team_id is not null
       and m.away_team_id is not null
       and not exists (select 1 from public.league_results r where r.match_id = m.id)
     order by m.kickoff_at
     limit greatest(1, least(2000, coalesce(p_limit, 500)))
  loop
    perform public.record_match_in_league(v_row.id);
    v_done := v_done + 1;
  end loop;

  -- A historical import opens seasons whose windows have already closed. Roll them over here
  -- rather than waiting for the nightly job, so promotions land in the same pass as the results
  -- that earned them.
  perform public.roll_over_seasons();

  return v_done;
end;
$$;


-- =============================================================================
-- 9. RLS
-- =============================================================================
-- Read-only to every client. Every write goes through a SECURITY DEFINER
-- function, so no role needs INSERT or UPDATE — which is what stops a captain
-- editing their own points total.

alter table public.league_seasons enable row level security;
alter table public.league_seasons force  row level security;
alter table public.league_entries enable row level security;
alter table public.league_entries force  row level security;
alter table public.league_results enable row level security;
alter table public.league_results force  row level security;

revoke all on table public.league_seasons from anon, authenticated;
revoke all on table public.league_entries from anon, authenticated;
revoke all on table public.league_results from anon, authenticated;

grant select on table public.league_seasons to anon, authenticated;
grant select on table public.league_entries to anon, authenticated;
grant select on table public.league_results to authenticated;

-- 9.1 Seasons are public. A league table is the product's best recruiting page.
drop policy if exists league_seasons_select_all_anon on public.league_seasons;
create policy league_seasons_select_all_anon
  on public.league_seasons for select to anon using (true);

drop policy if exists league_seasons_select_all on public.league_seasons;
create policy league_seasons_select_all
  on public.league_seasons for select to authenticated using (true);

-- 9.2 Entries follow the team's own visibility, plus your own team either way.
drop policy if exists league_entries_select_public_anon on public.league_entries;
create policy league_entries_select_public_anon
  on public.league_entries
  for select
  to anon
  using (exists (select 1 from public.teams t where t.id = team_id and t.is_public));

drop policy if exists league_entries_select_visible on public.league_entries;
create policy league_entries_select_visible
  on public.league_entries
  for select
  to authenticated
  using (
    exists (select 1 from public.teams t where t.id = team_id and t.is_public)
    or private.is_team_member(team_id)
    or private.is_admin()
  );

-- 9.3 Results are for people who were in the league.
drop policy if exists league_results_select_visible on public.league_results;
create policy league_results_select_visible
  on public.league_results
  for select
  to authenticated
  using (
    exists (
      select 1 from public.teams t
       where t.id in (home_team_id, away_team_id) and t.is_public
    )
    or private.is_team_member(home_team_id)
    or private.is_team_member(away_team_id)
    or private.is_admin()
  );


-- =============================================================================
-- 10. Function grants
-- =============================================================================

revoke all on function public.record_match_in_league(uuid) from public, anon, authenticated;
revoke all on function public.close_season(uuid) from public, anon, authenticated;
revoke all on function public.roll_over_seasons() from public, anon, authenticated;
revoke all on function public.backfill_leagues(integer) from public, anon, authenticated;
revoke all on function public.ensure_city_season(text, date) from public, anon, authenticated;

grant execute on function public.league_table(text, public.league_division, uuid) to anon, authenticated;
grant execute on function public.league_cities() to anon, authenticated;
grant execute on function public.my_leagues() to authenticated;

grant execute on function public.record_match_in_league(uuid) to service_role;
grant execute on function public.close_season(uuid) to service_role;
grant execute on function public.roll_over_seasons() to service_role;
grant execute on function public.backfill_leagues(integer) to service_role;
grant execute on function public.ensure_city_season(text, date) to service_role;


-- =============================================================================
-- 11. Cron
-- =============================================================================

do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice '0009: pg_cron not installed; schedule roll_over_seasons() externally.';
    return;
  end if;

  perform cron.unschedule('halisaha-league-rollover')
    where exists (select 1 from cron.job where jobname = 'halisaha-league-rollover');
  perform cron.schedule(
    'halisaha-league-rollover',
    '40 3 * * *',
    $job$select public.roll_over_seasons();$job$
  );

  raise notice '0009: cron job halisaha-league-rollover scheduled.';
exception
  when others then
    raise notice '0009: cron scheduling skipped (%).', sqlerrm;
end
$cron$;


-- =============================================================================
-- 12. Self-test
-- =============================================================================
-- The division ladder and the season calendar are both pure arithmetic that the
-- clients duplicate (packages/shared/src/leagues.ts). Pin them here so a change
-- on either side fails the migration rather than drifting.

do $test$
declare
  v_fail text := '';
begin
  if private.division_rank('bronze')   <> 1 then v_fail := v_fail || ' rank(bronze)';   end if;
  if private.division_rank('diamond')  <> 5 then v_fail := v_fail || ' rank(diamond)';  end if;
  if private.division_at(0)  <> 'bronze'  then v_fail := v_fail || ' at(0)';  end if;
  if private.division_at(6)  <> 'diamond' then v_fail := v_fail || ' at(6)';  end if;
  if private.division_at(3)  <> 'gold'    then v_fail := v_fail || ' at(3)';  end if;

  -- Round trip across the whole ladder.
  for i in 1..5 loop
    if private.division_rank(private.division_at(i)) <> i then
      v_fail := v_fail || ' roundtrip(' || i || ')';
    end if;
  end loop;

  -- Season windows are 91 days and never overlap.
  if private.season_start_for(private.season_epoch()) <> private.season_epoch() then
    v_fail := v_fail || ' season(epoch)';
  end if;
  if private.season_start_for(private.season_epoch() + 90) <> private.season_epoch() then
    v_fail := v_fail || ' season(+90)';
  end if;
  if private.season_start_for(private.season_epoch() + 91) <> private.season_epoch() + 91 then
    v_fail := v_fail || ' season(+91)';
  end if;
  -- And they run backwards from the epoch correctly, for a match kicked off before it.
  if private.season_start_for(private.season_epoch() - 1) <> private.season_epoch() - 91 then
    v_fail := v_fail || ' season(-1)';
  end if;

  if v_fail <> '' then
    raise exception '0009 self-test failed:%', v_fail;
  end if;

  raise notice '0009: division ladder and season calendar self-test passed.';
end
$test$;
