-- =============================================================================
-- OnPitch — 0004_trueskill.sql
-- TrueSkill 2 team rating engine (PL/pgSQL, PostgreSQL 15 compatible).
--
-- WHAT THIS FILE OWNS
--   * public.rating_config          — single-row, tunable model constants
--   * private.std_normal_pdf/cdf/icdf, v_win/w_win, v_draw/w_draw, draw_margin
--   * private.ensure_rating_row     — seed-and-lock helper (deadlock ordering)
--   * public.trueskill2_update      — the rating update itself
--   * public.apply_match_rating     — idempotent, transactional entry point
--   * public.match_quality          — matchmaking balance score in [0,1]
--
-- MODEL SUMMARY
--   Every player carries a Gaussian belief over latent skill s_i ~ N(mu_i, sigma_i^2).
--   A team's performance is the (weighted) sum of independent player performances
--   p_i ~ N(s_i, beta^2). For a two-team match the joint posterior has no closed
--   form, so TrueSkill uses the standard one-step moment-matching (ADF/EP)
--   approximation: project the truncated Gaussian back onto a Gaussian by
--   matching its first two moments. The projection is expressed through the two
--   correction functions v(t, eps) (mean shift) and w(t, eps) (variance shrink).
--   Both arguments are standardised by c = sqrt(total variance): t = dmu/c and
--   eps = draw_margin/c. Section 8 pins the published reference values so a
--   regression in that standardisation fails the migration instead of silently
--   inflating every rating.
--
--   Herbrich, Minka & Graepel, "TrueSkill(TM): A Bayesian Skill Rating System",
--   NIPS 2006. Minka, Zaykov & Cheng, "TrueSkill 2", MSR-TR-2018-8, contributes
--   the partial-play weighting and the outcome-magnitude idea used below.
--
-- NUMERICS
--   Everything is IEEE-754 double precision. Every quotient that could underflow
--   (pdf/cdf deep in the tail) has an explicit asymptotic fallback so the engine
--   can never divide by ~0, never returns NaN, and never emits a rating jump
--   from a floating-point artefact. See private.v_win / private.w_draw.
--
-- MONEY / TIME: not applicable here. No env vars are required by this migration.
-- =============================================================================

set search_path = public, extensions;


-- -----------------------------------------------------------------------------
-- 1. rating_config — one row, tunable without a code deploy
-- -----------------------------------------------------------------------------
-- The classic TrueSkill defaults, expressed relative to SIGMA0 so the whole
-- model can be rescaled by changing sigma0 alone:
--     MU0    = 25
--     SIGMA0 = 25/3            (a fresh player's 3-sigma floor is exactly 0)
--     BETA   = SIGMA0/2        performance noise: the skill gap that gives the
--                              stronger side ~76% win probability
--     TAU    = SIGMA0/100      per-match additive dynamics; stops sigma from
--                              collapsing to zero and lets real skill drift
--     DRAW_PROBABILITY = 0.10  amateur 7-a-side football draws roughly 1 in 10

create table if not exists public.rating_config (
  singleton            boolean primary key default true check (singleton),

  mu0                  double precision not null default 25.0
                         check (mu0 > 0),
  sigma0               double precision not null default 8.333333333333334
                         check (sigma0 > 0),
  beta                 double precision not null default 4.166666666666667
                         check (beta > 0),
  tau                  double precision not null default 0.08333333333333334
                         check (tau >= 0),
  draw_probability     double precision not null default 0.10
                         check (draw_probability >= 0 and draw_probability < 1),

  -- Outcome-magnitude weighting (TrueSkill 2 §"score margin").
  -- margin_factor = 1 + ln(1 + margin) / margin_log_divisor, capped.
  margin_log_divisor   double precision not null default 8.0
                         check (margin_log_divisor > 0),
  margin_factor_max    double precision not null default 1.35
                         check (margin_factor_max >= 1.0),

  -- Numerical + product guards.
  min_variance_ratio   double precision not null default 0.0001
                         check (min_variance_ratio > 0 and min_variance_ratio <= 1),
  sigma_floor          double precision not null default 0.4
                         check (sigma_floor > 0),
  mu_floor             double precision not null default 1.0,
  mu_ceiling           double precision not null default 60.0,

  updated_at           timestamptz not null default now(),

  constraint rating_config_mu_bounds_check check (mu_ceiling > mu_floor),
  constraint rating_config_sigma_floor_below_sigma0_check check (sigma_floor < sigma0)
);

comment on table public.rating_config is
  'Single-row tunable constants for the TrueSkill 2 engine. Read by trueskill2_update / match_quality on every call, so a change takes effect immediately.';
comment on column public.rating_config.beta is
  'Performance noise (std dev of a single player performance around their skill). Default sigma0/2.';
comment on column public.rating_config.tau is
  'Additive dynamics applied to sigma^2 before every update, so skill can drift and sigma never collapses. Default sigma0/100.';
comment on column public.rating_config.margin_log_divisor is
  'Larger = flatter response to blowouts. margin_factor = 1 + ln(1+|goal diff|)/divisor.';
comment on column public.rating_config.margin_factor_max is
  'Hard cap on the outcome-magnitude multiplier so a 9-0 friendly cannot explode a rating.';
comment on column public.rating_config.min_variance_ratio is
  'Numerical backstop on the per-match variance multiplier. The real churn guard is sigma_floor.';
comment on column public.rating_config.sigma_floor is
  'Sigma is never allowed below this, so an established player still has headroom to move.';

insert into public.rating_config (singleton) values (true)
on conflict (singleton) do nothing;

drop trigger if exists trg_rating_config_set_updated_at on public.rating_config;
create trigger trg_rating_config_set_updated_at
  before update on public.rating_config
  for each row execute function public.set_updated_at();

alter table public.rating_config enable row level security;

-- The constants are not secret (the UI explains "why did my rating move?"),
-- but they are not writable by end users either: no INSERT/UPDATE/DELETE policy
-- exists, so only the table owner and service_role can change them.
drop policy if exists rating_config_select_authenticated on public.rating_config;
create policy rating_config_select_authenticated
  on public.rating_config
  for select
  to authenticated
  using (true);

do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on public.rating_config to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on public.rating_config to service_role;
  end if;
end
$grants$;


-- -----------------------------------------------------------------------------
-- 2. Standard normal primitives
-- -----------------------------------------------------------------------------

create or replace function private.std_normal_pdf(p_x double precision)
returns double precision
language sql
immutable
strict
parallel safe
set search_path = ''
as $std_normal_pdf$
  -- phi(x) = exp(-x^2/2) / sqrt(2*pi).
  --
  -- PostgreSQL's exp() RAISES on float8 underflow (SQLSTATE 22003) rather than
  -- returning 0, and -0.5*x^2 crosses the underflow threshold of about -745 at
  -- |x| ~ 38.6. Every caller here is written to treat a vanishing density as
  -- zero and switch to an asymptote, so the guard returns 0 and lets them.
  -- Without it, w_draw at a standardised skill gap of |t| > 38 aborts the whole
  -- rating transaction instead of rating the match.
  select case
           when p_x * p_x > 1480.0 then 0.0
           else 0.3989422804014327 * exp(-0.5 * p_x * p_x)
         end;
$std_normal_pdf$;

comment on function private.std_normal_pdf(double precision) is
  'Standard normal density phi(x).';


-- Phi(x). PostgreSQL 15 has no erf()/erfc(), so this is Hart's (1968) rational
-- approximation as published by Graeme West, "Better Approximations to
-- Cumulative Normal Functions", Wilmott Magazine 2005. The classic
-- Abramowitz & Stegun 7.1.26 polynomial carries 1.5e-7 absolute error, which
-- swamps Phi(x) in the tail where private.v_win divides by it; Hart keeps
-- ~1e-15 relative error all the way to |x| = 37. That relative accuracy is
-- what private.v_win needs, so it is worth the extra coefficients.
-- The DO block further down swaps in erfc() when running on PostgreSQL 16+.
create or replace function private.std_normal_cdf(p_x double precision)
returns double precision
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $std_normal_cdf$
declare
  v_abs  double precision;
  v_e    double precision;
  v_num  double precision;
  v_den  double precision;
  v_tail double precision;
begin
  -- PostgreSQL treats NaN as equal to itself, so this is the portable test.
  if p_x = 'NaN'::double precision then
    return 'NaN'::double precision;
  end if;

  v_abs := abs(p_x);

  if v_abs > 37.0 then
    v_tail := 0.0;
  else
    v_e := exp(-0.5 * v_abs * v_abs);

    if v_abs < 7.07106781186547 then
      -- Central + near-tail region: ratio of two polynomials in |x|.
      v_num := 3.52624965998911e-02 * v_abs + 0.700383064443688;
      v_num := v_num * v_abs + 6.37396220353165;
      v_num := v_num * v_abs + 33.912866078383;
      v_num := v_num * v_abs + 112.079291497871;
      v_num := v_num * v_abs + 221.213596169931;
      v_num := v_num * v_abs + 220.206867912376;

      v_den := 8.83883476483184e-02 * v_abs + 1.75566716318264;
      v_den := v_den * v_abs + 16.064177579207;
      v_den := v_den * v_abs + 86.7807322029461;
      v_den := v_den * v_abs + 296.564248779674;
      v_den := v_den * v_abs + 637.333633378831;
      v_den := v_den * v_abs + 793.826512519948;
      v_den := v_den * v_abs + 440.413735824752;

      v_tail := v_e * v_num / v_den;
    else
      -- Deep tail: five-term continued fraction for the Mills ratio.
      v_den := v_abs + 0.65;
      v_den := v_abs + 4.0 / v_den;
      v_den := v_abs + 3.0 / v_den;
      v_den := v_abs + 2.0 / v_den;
      v_den := v_abs + 1.0 / v_den;
      v_tail := v_e / (v_den * 2.506628274631);
    end if;
  end if;

  -- v_tail is Phi(-|x|); mirror it for the positive half.
  if p_x > 0.0 then
    return 1.0 - v_tail;
  end if;
  return v_tail;
end;
$std_normal_cdf$;

comment on function private.std_normal_cdf(double precision) is
  'Standard normal CDF Phi(x). Hart/West rational approximation, ~1e-15 relative error including the tails; replaced by 0.5*erfc(-x/sqrt(2)) on PostgreSQL 16+.';


-- PostgreSQL 16 shipped erf()/erfc() in pg_catalog. When they exist, prefer
-- them: they are correctly rounded, faster, and 0.5*erfc(-x/sqrt(2)) is the
-- numerically stable form for the left tail (no cancellation). On PG15 this
-- block is a no-op and the Hart implementation above stands.
do $erfc_upgrade$
begin
  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'erfc'
      and n.nspname = 'pg_catalog'
      and p.pronargs = 1
  ) then
    execute $ddl$
      create or replace function private.std_normal_cdf(p_x double precision)
      returns double precision
      language sql
      immutable
      strict
      parallel safe
      set search_path = ''
      as 'select 0.5 * pg_catalog.erfc(-p_x * 0.7071067811865476)'
    $ddl$;
    raise notice 'std_normal_cdf: using built-in erfc() (PostgreSQL 16+).';
  else
    raise notice 'std_normal_cdf: using the Hart/West approximation (PostgreSQL 15).';
  end if;
end
$erfc_upgrade$;


-- Phi^-1(p). Peter Acklam's rational approximation (relative error < 1.15e-9)
-- followed by a single Halley step against std_normal_cdf, which takes it to
-- full double precision. Needed only for the draw margin, once per match.
create or replace function private.std_normal_icdf(p_p double precision)
returns double precision
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $std_normal_icdf$
declare
  v_q double precision;
  v_r double precision;
  v_x double precision;
  v_e double precision;
  v_u double precision;
begin
  if p_p = 'NaN'::double precision then
    return 'NaN'::double precision;
  end if;
  if p_p <= 0.0 then
    return '-Infinity'::double precision;
  end if;
  if p_p >= 1.0 then
    return 'Infinity'::double precision;
  end if;

  if p_p < 0.02425 then
    -- Lower tail.
    v_q := sqrt(-2.0 * ln(p_p));
    v_x := (((((-7.784894002430293e-03 * v_q - 3.223964580411365e-01) * v_q
                - 2.400758277161838e+00) * v_q - 2.549732539343734e+00) * v_q
                + 4.374664141464968e+00) * v_q + 2.938163982698783e+00)
         / ((((7.784695709041462e-03 * v_q + 3.224671290700398e-01) * v_q
                + 2.445134137142996e+00) * v_q + 3.754408661907416e+00) * v_q + 1.0);
  elsif p_p <= 0.97575 then
    -- Central region.
    v_q := p_p - 0.5;
    v_r := v_q * v_q;
    v_x := (((((-3.969683028665376e+01 * v_r + 2.209460984245205e+02) * v_r
                - 2.759285104469687e+02) * v_r + 1.383577518672690e+02) * v_r
                - 3.066479806614716e+01) * v_r + 2.506628277459239e+00) * v_q
         / (((((-5.447609879822406e+01 * v_r + 1.615858368580409e+02) * v_r
                - 1.556989798598866e+02) * v_r + 6.680131188771972e+01) * v_r
                - 1.328068155288572e+01) * v_r + 1.0);
  else
    -- Upper tail, by symmetry.
    v_q := sqrt(-2.0 * ln(1.0 - p_p));
    v_x := -(((((-7.784894002430293e-03 * v_q - 3.223964580411365e-01) * v_q
                - 2.400758277161838e+00) * v_q - 2.549732539343734e+00) * v_q
                + 4.374664141464968e+00) * v_q + 2.938163982698783e+00)
         / ((((7.784695709041462e-03 * v_q + 3.224671290700398e-01) * v_q
                + 2.445134137142996e+00) * v_q + 3.754408661907416e+00) * v_q + 1.0);
  end if;

  -- Halley refinement: x <- x - u / (1 + x*u/2), u = (Phi(x) - p)*sqrt(2*pi)*e^(x^2/2).
  -- Skipped in the extreme tails where exp(x^2/2) overflows; Acklam alone is
  -- already far more accurate than anything the draw margin needs there.
  if abs(v_x) < 25.0 then
    v_e := private.std_normal_cdf(v_x) - p_p;
    v_u := v_e * 2.5066282746310002 * exp(0.5 * v_x * v_x);
    v_x := v_x - v_u / (1.0 + 0.5 * v_x * v_u);
  end if;

  return v_x;
end;
$std_normal_icdf$;

comment on function private.std_normal_icdf(double precision) is
  'Standard normal inverse CDF Phi^-1(p). Acklam rational approximation plus one Halley step; accurate to ~1e-15 relative.';


-- -----------------------------------------------------------------------------
-- 3. Truncated-Gaussian moment corrections
-- -----------------------------------------------------------------------------
-- t   = (mu_winner - mu_loser) / c, the standardised performance gap
-- eps = draw margin, in the same standardised units
--
-- v(t, eps) is the mean shift of the truncated Gaussian, w(t, eps) is the
-- fraction of variance the observation removes. Both are dimensionless and
-- w always lies in (0, 1).

create or replace function private.v_win(p_t double precision, p_eps double precision)
returns double precision
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $v_win$
declare
  v_x   double precision;
  v_cdf double precision;
begin
  v_x   := p_t - p_eps;
  v_cdf := private.std_normal_cdf(v_x);

  -- Tail guard. Once Phi(x) underflows we would be dividing ~0 by ~0. The
  -- Mills-ratio asymptote phi(x)/Phi(x) -> -x - 1/x (x -> -inf) is exact to
  -- ~1e-6 relative by x = -37 and keeps the second-order term, so
  -- that w_win below still converges to its true limit of 1 instead of 0.
  if v_cdf < 1e-300 then
    return -v_x - 1.0 / v_x;
  end if;

  return private.std_normal_pdf(v_x) / v_cdf;
end;
$v_win$;

comment on function private.v_win(double precision, double precision) is
  'TrueSkill V function for a decisive result: phi(t-eps)/Phi(t-eps), with the Mills-ratio asymptote as an underflow-safe fallback.';


create or replace function private.w_win(p_t double precision, p_eps double precision)
returns double precision
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $w_win$
declare
  v_x double precision;
  v_v double precision;
  v_w double precision;
begin
  v_x := p_t - p_eps;
  v_v := private.v_win(p_t, p_eps);
  v_w := v_v * (v_v + v_x);

  -- Mathematically w in (0,1): it is the fraction of variance explained.
  -- Anything outside is rounding noise; a NaN can only come from Inf-Inf and
  -- is failed safe to "learn nothing from this match" rather than "collapse".
  if v_w = 'NaN'::double precision then
    return 0.0;
  end if;
  return least(1.0::double precision, greatest(0.0::double precision, v_w));
end;
$w_win$;

comment on function private.w_win(double precision, double precision) is
  'TrueSkill W function for a decisive result: v*(v + t - eps), clamped to [0,1].';


create or replace function private.v_draw(p_t double precision, p_eps double precision)
returns double precision
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $v_draw$
declare
  v_abs  double precision;
  v_a    double precision;
  v_b    double precision;
  v_den  double precision;
  v_sign double precision;
begin
  -- A draw is a two-sided truncation to the band [-eps, eps]; the correction is
  -- computed on |t| and then signed, because a draw pulls the *favourite* down
  -- and the underdog up regardless of which side is nominally first.
  v_abs  := abs(p_t);
  v_a    := p_eps - v_abs;
  v_b    := -p_eps - v_abs;
  v_sign := case when p_t < 0.0 then -1.0 else 1.0 end;

  v_den := private.std_normal_cdf(v_a) - private.std_normal_cdf(v_b);

  -- Both bounds deep in the left tail (an enormous favourite drew): the mass in
  -- the band underflows. The truncated mean collapses onto the nearer bound a.
  if v_den < 1e-300 then
    return v_sign * v_a;
  end if;

  return v_sign * ((private.std_normal_pdf(v_b) - private.std_normal_pdf(v_a)) / v_den);
end;
$v_draw$;

comment on function private.v_draw(double precision, double precision) is
  'TrueSkill V function for a draw: signed two-sided truncated-Gaussian mean shift, with an underflow fallback onto the nearer truncation bound.';


create or replace function private.w_draw(p_t double precision, p_eps double precision)
returns double precision
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $w_draw$
declare
  v_abs double precision;
  v_a   double precision;
  v_b   double precision;
  v_den double precision;
  v_v   double precision;
  v_w   double precision;
begin
  v_abs := abs(p_t);
  v_a   := p_eps - v_abs;
  v_b   := -p_eps - v_abs;

  v_den := private.std_normal_cdf(v_a) - private.std_normal_cdf(v_b);

  -- Same underflow case as v_draw. As |t| -> inf the two-sided w tends to 1:
  -- an "impossible" draw is maximally informative, so it removes as much
  -- variance as the model allows.
  if v_den < 1e-300 then
    return 1.0;
  end if;

  -- v_draw is called on |t| so the sign cancels out of v^2 correctly.
  v_v := private.v_draw(v_abs, p_eps);
  v_w := v_v * v_v
       + (v_a * private.std_normal_pdf(v_a) - v_b * private.std_normal_pdf(v_b)) / v_den;

  if v_w = 'NaN'::double precision then
    return 1.0;
  end if;
  return least(1.0::double precision, greatest(0.0::double precision, v_w));
end;
$w_draw$;

comment on function private.w_draw(double precision, double precision) is
  'TrueSkill W function for a draw: v^2 + (a*phi(a) - b*phi(b))/(Phi(a) - Phi(b)), clamped to [0,1].';


create or replace function private.draw_margin(
  p_draw_probability double precision,
  p_beta             double precision,
  p_total_players    double precision
)
returns double precision
language sql
immutable
strict
parallel safe
set search_path = ''
as $draw_margin$
  -- eps = Phi^-1((p+1)/2) * sqrt(n) * beta.
  -- Derivation: a draw is |performance gap| < eps. With n independent player
  -- performances each of variance beta^2, the gap has std dev sqrt(n)*beta, so
  -- the half-width that captures probability p is the (p+1)/2 quantile scaled
  -- by that std dev. p is clamped away from 0 and 1 so the quantile is finite.
  -- p_total_players is the effective player count sum(w_i^2), which equals the
  -- headcount when every partial-play weight is 1.
  --
  -- The result is in raw skill units. v_win / v_draw take a standardised
  -- margin, so the caller must divide this by c before passing it in. See
  -- trueskill2_update section 5.5.
  select private.std_normal_icdf(
           (least(greatest(p_draw_probability, 1e-9), 1.0 - 1e-9) + 1.0) / 2.0
         )
       * sqrt(greatest(p_total_players, 1e-9))
       * p_beta;
$draw_margin$;

comment on function private.draw_margin(double precision, double precision, double precision) is
  'Half-width of the draw band in raw skill units: icdf((p+1)/2) * sqrt(total_players) * beta. Divide by c before passing it to v_win/v_draw, which expect a standardised margin.';


-- -----------------------------------------------------------------------------
-- 4. Seed-and-lock helper
-- -----------------------------------------------------------------------------
-- Upserting with a no-op DO UPDATE is the only way to both (a) create the row if
-- it is missing and (b) come away holding a row lock on it even when a
-- concurrent transaction created it first. A plain "INSERT ... DO NOTHING"
-- followed by SELECT would not see the other transaction's uncommitted row.

create or replace function private.ensure_rating_row(
  p_player_id uuid,
  p_mu0       double precision,
  p_sigma0    double precision
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $ensure_rating_row$
begin
  insert into public.player_ratings as pr (player_id, mu, sigma)
  values (p_player_id, p_mu0, p_sigma0)
  on conflict (player_id) do update set mu = pr.mu;
end;
$ensure_rating_row$;

comment on function private.ensure_rating_row(uuid, double precision, double precision) is
  'Creates the player_ratings row if absent and leaves the caller holding a row lock on it. Callers must invoke it in ascending player_id order to avoid deadlocks.';

revoke all on function private.ensure_rating_row(uuid, double precision, double precision) from public;


-- -----------------------------------------------------------------------------
-- 5. public.trueskill2_update — the rating update
-- -----------------------------------------------------------------------------

create or replace function public.trueskill2_update(
  p_team_a       uuid[],
  p_team_b       uuid[],
  p_outcome      text,
  p_score_margin integer default 0,
  p_weights      jsonb   default null
)
returns table (
  player_id    uuid,
  mu_before    double precision,
  sigma_before double precision,
  mu_after     double precision,
  sigma_after  double precision
)
language plpgsql
volatile
security definer
set search_path = ''
as $trueskill2_update$
declare
  cfg              public.rating_config%rowtype;

  v_a              uuid[];
  v_b              uuid[];
  v_n_a            integer;
  v_n_b            integer;
  v_n              integer;
  v_pid            uuid;

  -- Roster snapshot, all arrays parallel and 1-based: team A first, then B.
  v_ids            uuid[];
  v_side           integer[];             -- +1 = team A, -1 = team B
  v_mu0            double precision[];    -- mu before the update
  v_sig0           double precision[];    -- sigma before the update
  v_s2             double precision[];    -- tau-inflated variance used by the update
  v_wgt            double precision[];    -- partial-play weight in [0,1]

  v_mu_new         double precision[];
  v_sigma_new      double precision[];
  v_win_inc        integer[];
  v_draw_inc       integer[];
  v_loss_inc       integer[];

  v_beta2          double precision;
  v_tau2           double precision;

  v_mu_a           double precision := 0.0;
  v_mu_b           double precision := 0.0;
  v_s2_a           double precision := 0.0;
  v_s2_b           double precision := 0.0;
  v_wsum_a         double precision := 0.0;
  v_wsum_b         double precision := 0.0;
  v_beta_terms     double precision := 0.0;   -- sum(w_i^2) = effective headcount

  v_c2             double precision;
  v_c              double precision;
  v_t              double precision;
  v_eps            double precision;
  v_v              double precision;
  v_w              double precision;

  v_is_draw        boolean;
  v_dir            integer;               -- +1 when team A ranks first, -1 otherwise
  v_margin         integer;
  v_margin_factor  double precision;

  v_ratio          double precision;
  v_sig2_new       double precision;
  i                integer;
begin
  -- ---------------------------------------------------------------------------
  -- 5.1 Validate and normalise the inputs
  -- ---------------------------------------------------------------------------
  if p_outcome is null or p_outcome not in ('a_wins', 'b_wins', 'draw') then
    raise exception 'trueskill2_update: p_outcome must be a_wins | b_wins | draw, got %', p_outcome
      using errcode = '22023';
  end if;

  select array_agg(distinct e.pid) into v_a from unnest(coalesce(p_team_a, '{}'::uuid[])) as e(pid) where e.pid is not null;
  select array_agg(distinct e.pid) into v_b from unnest(coalesce(p_team_b, '{}'::uuid[])) as e(pid) where e.pid is not null;

  v_n_a := coalesce(cardinality(v_a), 0);
  v_n_b := coalesce(cardinality(v_b), 0);

  if v_n_a = 0 or v_n_b = 0 then
    raise exception 'trueskill2_update: both teams need at least one player (a=%, b=%)', v_n_a, v_n_b
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from unnest(v_a) as x(pid)
      join unnest(v_b) as y(pid) on x.pid = y.pid
  ) then
    raise exception 'trueskill2_update: a player cannot appear on both teams'
      using errcode = '22023';
  end if;

  v_n := v_n_a + v_n_b;

  select * into strict cfg from public.rating_config where singleton;

  v_beta2 := cfg.beta * cfg.beta;
  v_tau2  := cfg.tau * cfg.tau;

  -- ---------------------------------------------------------------------------
  -- 5.2 Seed + lock every rating row, in ascending uuid order.
  --     Deterministic lock ordering is what makes two concurrent matches that
  --     share a player deadlock-free.
  -- ---------------------------------------------------------------------------
  for v_pid in select u.pid from unnest(v_a || v_b) as u(pid) order by u.pid loop
    perform private.ensure_rating_row(v_pid, cfg.mu0, cfg.sigma0);
  end loop;

  -- ---------------------------------------------------------------------------
  -- 5.3 Snapshot the roster into parallel arrays (team A first, then team B)
  -- ---------------------------------------------------------------------------
  select array_agg(r.pid       order by r.ord),
         array_agg(r.side      order by r.ord),
         array_agg(pr.mu       order by r.ord),
         array_agg(pr.sigma    order by r.ord),
         -- TAU: additive dynamics. sigma^2 grows a little before every match so
         -- that a long-inactive but previously certain player can still move.
         array_agg(pr.sigma * pr.sigma + v_tau2 order by r.ord),
         array_agg(
           case
             when p_weights is not null
              and jsonb_typeof(p_weights -> r.pid::text) = 'number'
             then least(1.0::double precision,
                        greatest(0.0::double precision,
                                 (p_weights ->> r.pid::text)::double precision))
             else 1.0::double precision
           end order by r.ord)
    into v_ids, v_side, v_mu0, v_sig0, v_s2, v_wgt
  from (
    select a.pid, 1 as side, a.ord::integer as ord
      from unnest(v_a) with ordinality as a(pid, ord)
    union all
    select b.pid, -1 as side, (b.ord + v_n_a)::integer as ord
      from unnest(v_b) with ordinality as b(pid, ord)
  ) r
  join public.player_ratings pr on pr.player_id = r.pid;

  if coalesce(cardinality(v_ids), 0) <> v_n then
    raise exception 'trueskill2_update: expected % rating rows, found %', v_n, coalesce(cardinality(v_ids), 0)
      using errcode = 'P0002';
  end if;

  -- ---------------------------------------------------------------------------
  -- 5.4 Team aggregates
  --   TrueSkill 2 partial play: a player who played a fraction w of the match
  --   contributes w * s_i to the team performance, so the team mean is
  --   sum(w_i * mu_i) and the team variance is sum(w_i^2 * sigma_i^2). The
  --   per-player performance noise scales the same way, which is why the beta
  --   term below is sum(w_i^2) * beta^2 and reduces exactly to n * beta^2 when
  --   every weight is 1.
  -- ---------------------------------------------------------------------------
  for i in 1 .. v_n loop
    if v_side[i] = 1 then
      v_mu_a   := v_mu_a   + v_wgt[i] * v_mu0[i];
      v_s2_a   := v_s2_a   + v_wgt[i] * v_wgt[i] * v_s2[i];
      v_wsum_a := v_wsum_a + v_wgt[i];
    else
      v_mu_b   := v_mu_b   + v_wgt[i] * v_mu0[i];
      v_s2_b   := v_s2_b   + v_wgt[i] * v_wgt[i] * v_s2[i];
      v_wsum_b := v_wsum_b + v_wgt[i];
    end if;
    v_beta_terms := v_beta_terms + v_wgt[i] * v_wgt[i];
  end loop;

  if v_wsum_a <= 0.0 or v_wsum_b <= 0.0 then
    raise exception 'trueskill2_update: every partial-play weight on a team is zero'
      using errcode = '22023';
  end if;

  v_c2 := v_s2_a + v_s2_b + v_beta_terms * v_beta2;
  if not (v_c2 > 0.0) then
    raise exception 'trueskill2_update: degenerate total variance (c^2 = %)', v_c2
      using errcode = '22023';
  end if;
  v_c := sqrt(v_c2);

  -- ---------------------------------------------------------------------------
  -- 5.5 Standardised gap, draw margin, and the (v, w) corrections
  -- ---------------------------------------------------------------------------
  v_is_draw := (p_outcome = 'draw');
  -- Order the teams so the winner is first. A draw keeps team A first; v_draw
  -- carries its own sign, so the direction still comes out right.
  v_dir := case when p_outcome = 'b_wins' then -1 else 1 end;

  if v_dir = 1 then
    v_t := (v_mu_a - v_mu_b) / v_c;
  else
    v_t := (v_mu_b - v_mu_a) / v_c;
  end if;

  -- draw_margin returns eps in raw skill units, but t is already standardised
  -- by c, so eps must be divided by c to live in the same space. (The reference
  -- implementation does the same thing by multiplying the margin by sqrt(pi) of
  -- the natural-parameter message, which is exactly 1/c.) Getting this wrong
  -- fails silently: the draw band ends up ~c times too wide, every decisive
  -- result over-rewards by ~58%, and the model no longer reproduces the
  -- published TrueSkill values. Section 8 pins those values.
  v_eps := private.draw_margin(cfg.draw_probability, cfg.beta, v_beta_terms) / v_c;

  if v_is_draw then
    v_v := private.v_draw(v_t, v_eps);
    v_w := private.w_draw(v_t, v_eps);
    -- A draw has no magnitude by definition.
    v_margin_factor := 1.0;
  else
    v_v := private.v_win(v_t, v_eps);
    v_w := private.w_win(v_t, v_eps);

    -- Outcome magnitude (TrueSkill 2). Plain TrueSkill throws away the score:
    -- 1-0 and 8-0 move ratings identically, which feels wrong to players and
    -- wastes real signal. We scale the mean update by
    --     margin_factor = 1 + ln(1 + |goal diff|) / margin_log_divisor
    -- capped at margin_factor_max. Rationale:
    --   * logarithmic, so the marginal value of the 8th goal is tiny;
    --   * multiplicative on the mean only. The variance update is left exactly
    --     as the moment-matching projection produced it, because the margin is
    --     a heuristic about the mean and inflating the variance shrink with it
    --     would make the model falsely confident;
    --   * hard-capped, so a 9-0 friendly against a short-handed side cannot
    --     move a rating by more than 35% over the same 1-0 result;
    --   * the raw margin is clamped to 30 first, so a data-entry slip of 999
    --     is a bounded error rather than an unbounded one.
    -- The cost of this term is that the update is no longer the exact Bayesian
    -- posterior. It is a deliberate, bounded product decision.
    v_margin := least(greatest(coalesce(p_score_margin, 0), 0), 30);
    v_margin_factor := least(
      cfg.margin_factor_max,
      1.0 + ln(1.0 + v_margin::double precision) / cfg.margin_log_divisor
    );
  end if;

  -- ---------------------------------------------------------------------------
  -- 5.6 Per-player posterior
  -- ---------------------------------------------------------------------------
  v_mu_new    := array_fill(0.0::double precision, array[v_n]);
  v_sigma_new := array_fill(0.0::double precision, array[v_n]);
  v_win_inc   := array_fill(0, array[v_n]);
  v_draw_inc  := array_fill(0, array[v_n]);
  v_loss_inc  := array_fill(0, array[v_n]);

  for i in 1 .. v_n loop
    -- Mean: shift by the player's share of the team's uncertainty. A player
    -- the model is unsure about (large sigma^2) absorbs more of the surprise.
    -- (v_side[i] * v_dir) is +1 for the winning side and -1 for the losing one.
    v_mu_new[i] := v_mu0[i]
                 + (v_side[i] * v_dir)::double precision
                 * v_wgt[i]
                 * (v_s2[i] / v_c)
                 * v_v
                 * v_margin_factor;

    -- Variance: multiplicative shrink. The bracket is in (0,1) analytically
    -- because s2_i <= c^2 and w in (0,1); min_variance_ratio is a pure
    -- floating-point backstop, not a tuning knob.
    v_ratio := greatest(
      1.0 - v_wgt[i] * (v_s2[i] / v_c2) * v_w,
      cfg.min_variance_ratio
    );
    v_sig2_new := v_s2[i] * v_ratio;

    -- Product clamps. sigma_floor keeps every player able to move again;
    -- sigma0 is the ceiling because nobody should ever be less known than a
    -- brand-new account. mu bounds keep the leaderboard number human-readable
    -- and stop a pathological input from producing an absurd rating.
    v_sigma_new[i] := least(cfg.sigma0, greatest(cfg.sigma_floor, sqrt(v_sig2_new)));
    v_mu_new[i]    := least(cfg.mu_ceiling, greatest(cfg.mu_floor, v_mu_new[i]));

    if v_is_draw then
      v_draw_inc[i] := 1;
    elsif v_side[i] * v_dir > 0 then
      v_win_inc[i] := 1;
    else
      v_loss_inc[i] := 1;
    end if;
  end loop;

  -- ---------------------------------------------------------------------------
  -- 5.7 Persist. Single set-based UPDATE over the locked rows.
  -- ---------------------------------------------------------------------------
  update public.player_ratings pr
     set mu             = u.mu_new,
         sigma          = u.sigma_new,
         matches_played = pr.matches_played + 1,
         wins           = pr.wins   + u.win_inc,
         draws          = pr.draws  + u.draw_inc,
         losses         = pr.losses + u.loss_inc,
         last_match_at  = now()
    from (
      select *
        from unnest(v_ids, v_mu_new, v_sigma_new, v_win_inc, v_draw_inc, v_loss_inc)
          as t(pid, mu_new, sigma_new, win_inc, draw_inc, loss_inc)
    ) u
   where pr.player_id = u.pid;

  return query
  select t.pid, t.mb, t.sb, t.ma, t.sa
    from unnest(v_ids, v_mu0, v_sig0, v_mu_new, v_sigma_new) as t(pid, mb, sb, ma, sa);
end;
$trueskill2_update$;

comment on function public.trueskill2_update(uuid[], uuid[], text, integer, jsonb) is
$c$TrueSkill 2 two-team rating update.

  p_team_a / p_team_b  player ids (home / away). Deduplicated; must not overlap.
  p_outcome            a_wins | b_wins | draw
  p_score_margin       |goal difference|, drives a capped outcome-magnitude
                       multiplier on the mean update only. 0 for a draw.
  p_weights            optional {"<player uuid>": 0..1} partial-play weights.

Returns one row per player with mu/sigma before and after. Writes player_ratings
(mu, sigma, matches_played, wins/draws/losses, last_match_at) in the same
transaction, taking row locks in ascending player_id order so concurrent matches
sharing a player cannot deadlock. SECURITY DEFINER; service_role only.$c$;

do $grants$
begin
  revoke all on function public.trueskill2_update(uuid[], uuid[], text, integer, jsonb) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.trueskill2_update(uuid[], uuid[], text, integer, jsonb) to service_role;
  end if;
end
$grants$;


-- -----------------------------------------------------------------------------
-- 6. public.apply_match_rating — idempotent transactional entry point
-- -----------------------------------------------------------------------------

create or replace function public.apply_match_rating(p_match_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $apply_match_rating$
declare
  m           public.matches%rowtype;
  v_home      uuid[];
  v_away      uuid[];
  v_outcome   text;
  v_margin    integer;
  v_weights   jsonb;
  v_rows      integer := 0;
begin
  -- Serialise concurrent callers on the match row. The second caller blocks
  -- here, then observes rating_applied_at and returns 0.
  select * into m from public.matches where id = p_match_id for update;

  if not found then
    raise exception 'apply_match_rating: match % not found', p_match_id
      using errcode = 'P0002';
  end if;

  -- Idempotency: already applied is a no-op, never an error.
  if m.rating_applied_at is not null then
    return 0;
  end if;

  if not m.is_ranked then
    raise exception 'apply_match_rating: match % is not ranked', p_match_id
      using errcode = '22023';
  end if;

  if m.requires_consensus then
    raise exception 'apply_match_rating: match % still requires consensus', p_match_id
      using errcode = '22023';
  end if;

  if m.home_score is null or m.away_score is null then
    raise exception 'apply_match_rating: match % has no recorded score', p_match_id
      using errcode = '22023';
  end if;

  -- Finalizable = already finalized, or awaiting_report with a confirmed score.
  if not (
       m.status = 'finalized'
    or (m.status = 'awaiting_report' and m.score_confirmed_at is not null)
  ) then
    raise exception 'apply_match_rating: match % is in status % and is not finalizable', p_match_id, m.status
      using errcode = '22023';
  end if;

  -- Rosters. Every listed participant is rated: by the time a match is
  -- finalizable the line-up is settled, and a no-show should be removed from
  -- match_participants rather than left in with is_confirmed = false.
  select array_agg(mp.player_id order by mp.player_id) filter (where mp.team_side = 'home'),
         array_agg(mp.player_id order by mp.player_id) filter (where mp.team_side = 'away')
    into v_home, v_away
    from public.match_participants mp
   where mp.match_id = p_match_id;

  if coalesce(cardinality(v_home), 0) = 0 or coalesce(cardinality(v_away), 0) = 0 then
    raise exception 'apply_match_rating: match % needs participants on both sides (home=%, away=%)',
      p_match_id, coalesce(cardinality(v_home), 0), coalesce(cardinality(v_away), 0)
      using errcode = '22023';
  end if;

  if m.home_score > m.away_score then
    v_outcome := 'a_wins';
  elsif m.away_score > m.home_score then
    v_outcome := 'b_wins';
  else
    v_outcome := 'draw';
  end if;
  v_margin := abs(m.home_score - m.away_score);

  -- Partial play (the weights argument of trueskill2_update, section 5) is not
  -- used here, and passing NULL is deliberate.
  --
  -- The weights would have to come from player_stats.minutes_played, but the
  -- player_stats rows for this match are created by the INSERT immediately
  -- below -- this function is their only producer in the entire repository --
  -- and they are created with minutes_played at its default of 0. A read
  -- placed here finds no rows; a read moved after the INSERT finds rows that
  -- the `minutes_played > 0` filter excludes. Either way the aggregate is '{}'
  -- and trueskill2_update takes its unweighted branch, so the query was pure
  -- overhead that read as a working feature.
  --
  -- Nothing else writes minutes_played either: there is no stats-entry route,
  -- form or RPC anywhere in the product. Wiring this up needs the producer
  -- first -- line-up minutes captured at score-report time, or an explicit
  -- stats RPC -- and only then does reinstating the read mean anything. The
  -- weighting maths itself is intact and tested in trueskill2_update.
  v_weights := null;

  -- Run the update and fold the before/after snapshot into player_stats.
  -- MATERIALIZED guarantees the volatile function is evaluated exactly once.
  with rated as materialized (
    select *
      from public.trueskill2_update(v_home, v_away, v_outcome, v_margin, v_weights)
  )
  insert into public.player_stats as ps
    (match_id, player_id, team_id, team_side, mu_before, sigma_before, mu_after, sigma_after)
  select p_match_id,
         r.player_id,
         case when mp.team_side = 'home' then m.home_team_id else m.away_team_id end,
         mp.team_side,
         r.mu_before,
         r.sigma_before,
         r.mu_after,
         r.sigma_after
    from rated r
    join public.match_participants mp
      on mp.match_id = p_match_id and mp.player_id = r.player_id
  on conflict (match_id, player_id) do update
    set mu_before    = excluded.mu_before,
        sigma_before = excluded.sigma_before,
        mu_after     = excluded.mu_after,
        sigma_after  = excluded.sigma_after,
        team_id      = coalesce(ps.team_id, excluded.team_id),
        team_side    = coalesce(ps.team_side, excluded.team_side);

  get diagnostics v_rows = row_count;

  update public.matches mm
     set rating_applied_at  = now(),
         status             = 'finalized',
         score_confirmed_at = coalesce(mm.score_confirmed_at, now())
   where mm.id = p_match_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    null,
    'match.rating_applied',
    'matches',
    p_match_id,
    jsonb_build_object(
      'players', v_rows,
      'outcome', v_outcome,
      'score_margin', v_margin,
      'home_score', m.home_score,
      'away_score', m.away_score
    )
  );

  return v_rows;
end;
$apply_match_rating$;

comment on function public.apply_match_rating(uuid) is
$c$Applies the TrueSkill 2 update for one match and returns the number of players rated.

Idempotent: a second call returns 0 without touching anything. Takes FOR UPDATE
on the match row so concurrent callers serialise. Raises 22023 when the match is
unranked, still in consensus, scoreless, or not in a finalizable status.
Side effects: writes player_ratings (via trueskill2_update), upserts the
mu/sigma before+after snapshot into player_stats, stamps
matches.rating_applied_at (promoting awaiting_report -> finalized), and appends
one audit_log row. SECURITY DEFINER; service_role only.$c$;

do $grants$
begin
  revoke all on function public.apply_match_rating(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.apply_match_rating(uuid) to service_role;
  end if;
end
$grants$;


-- -----------------------------------------------------------------------------
-- 7. public.match_quality — matchmaking balance score
-- -----------------------------------------------------------------------------

create or replace function public.match_quality(p_team_a uuid[], p_team_b uuid[])
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $match_quality$
declare
  cfg      public.rating_config%rowtype;
  v_a      uuid[];
  v_b      uuid[];
  v_n      integer;
  v_mu_a   double precision;
  v_mu_b   double precision;
  v_s2_a   double precision;
  v_s2_b   double precision;
  v_beta2  double precision;
  v_c2     double precision;
  v_q      double precision;
begin
  select array_agg(distinct e.pid) into v_a from unnest(coalesce(p_team_a, '{}'::uuid[])) as e(pid) where e.pid is not null;
  select array_agg(distinct e.pid) into v_b from unnest(coalesce(p_team_b, '{}'::uuid[])) as e(pid) where e.pid is not null;

  -- Matchmaking ranks many candidate fixtures at once; a degenerate candidate
  -- scores 0 rather than raising and aborting the whole ranking query.
  if coalesce(cardinality(v_a), 0) = 0 or coalesce(cardinality(v_b), 0) = 0 then
    return 0::numeric;
  end if;

  select * into strict cfg from public.rating_config where singleton;
  v_beta2 := cfg.beta * cfg.beta;
  v_n     := cardinality(v_a) + cardinality(v_b);

  -- Players with no rating row yet are treated as brand-new (mu0, sigma0)
  -- rather than skipped, so an unrated ringer correctly drags quality down.
  select coalesce(sum(coalesce(pr.mu, cfg.mu0)), 0.0),
         coalesce(sum(coalesce(pr.sigma, cfg.sigma0) * coalesce(pr.sigma, cfg.sigma0)), 0.0)
    into v_mu_a, v_s2_a
    from unnest(v_a) as t(pid)
    left join public.player_ratings pr on pr.player_id = t.pid;

  select coalesce(sum(coalesce(pr.mu, cfg.mu0)), 0.0),
         coalesce(sum(coalesce(pr.sigma, cfg.sigma0) * coalesce(pr.sigma, cfg.sigma0)), 0.0)
    into v_mu_b, v_s2_b
    from unnest(v_b) as t(pid)
    left join public.player_ratings pr on pr.player_id = t.pid;

  v_c2 := v_n::double precision * v_beta2 + v_s2_a + v_s2_b;
  if not (v_c2 > 0.0) then
    return 0::numeric;
  end if;

  -- Standard TrueSkill match quality: the probability of a draw for this
  -- pairing, normalised so a perfectly balanced fixture scores 1.
  --   q = sqrt( n*beta^2 / c^2 ) * exp( -(mu_a - mu_b)^2 / (2*c^2) )
  -- The first factor penalises uncertainty (two unknown teams could be
  -- anything); the second penalises a skill gap.
  v_q := sqrt((v_n::double precision * v_beta2) / v_c2)
       * exp(-((v_mu_a - v_mu_b) * (v_mu_a - v_mu_b)) / (2.0 * v_c2));

  if v_q = 'NaN'::double precision then
    return 0::numeric;
  end if;

  -- Rounded to 5 dp so it drops straight into matches.match_quality numeric(6,5).
  return round(least(1.0::double precision, greatest(0.0::double precision, v_q))::numeric, 5);
end;
$match_quality$;

comment on function public.match_quality(uuid[], uuid[]) is
$c$TrueSkill match quality in [0,1], rounded to 5 dp for matches.match_quality.

  q = sqrt(n*beta^2 / c^2) * exp(-(mu_a - mu_b)^2 / (2*c^2)),
  c^2 = n*beta^2 + sum(sigma_a^2) + sum(sigma_b^2)

1 means a perfectly even, well-understood fixture. Unrated players count as
(mu0, sigma0). Returns 0 for an empty side instead of raising, so it is safe in
a ranking query over many candidate fixtures. SECURITY DEFINER because
matchmaking must read opponents' ratings; it only ever exposes this single
aggregate, never an individual rating.$c$;

do $grants$
begin
  revoke all on function public.match_quality(uuid[], uuid[]) from public;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.match_quality(uuid[], uuid[]) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.match_quality(uuid[], uuid[]) to service_role;
  end if;
end
$grants$;


-- -----------------------------------------------------------------------------
-- 8. Sanity checks — fail the migration loudly rather than shipping bad math
-- -----------------------------------------------------------------------------
do $selftest$
declare
  v      double precision;
  v_s2   double precision;
  v_c2   double precision;
  v_c    double precision;
  v_eps  double precision;
  v_v    double precision;
  v_w    double precision;
  v_mu   double precision;
  v_sig  double precision;
begin
  -- Phi(0) = 0.5
  v := private.std_normal_cdf(0.0);
  if abs(v - 0.5) > 1e-12 then
    raise exception 'std_normal_cdf(0) = %, expected 0.5', v;
  end if;

  -- Phi(1.959963984540054) = 0.975
  v := private.std_normal_cdf(1.959963984540054);
  if abs(v - 0.975) > 1e-9 then
    raise exception 'std_normal_cdf(1.95996...) = %, expected 0.975', v;
  end if;

  -- Deep tail must keep relative accuracy, which is why Hart is used instead of
  -- Abramowitz & Stegun 7.1.26 (7.5e-8 absolute error would make Phi(-6) wrong
  -- by a factor of ~76 and break v_win outright).
  -- Phi(-6) = 9.865876450376946e-10, inside the polynomial branch.
  v := private.std_normal_cdf(-6.0);
  -- Measured relative error of the transcribed Hart polynomial here is 5.4e-10;
  -- the gate is set at 1e-7 so it fails on a broken tail, not on a 2x margin.
  if abs(v / 9.865876450376946e-10 - 1.0) > 1e-7 then
    raise exception 'std_normal_cdf(-6) = %, expected ~9.8658764e-10', v;
  end if;

  -- Phi(-8) = 6.220960574271786e-16, exercising the continued-fraction branch
  -- (|x| >= 7.0710678). That branch trades a little accuracy for range, so the
  -- tolerance here is loose on purpose; it still fails hard on a broken tail.
  v := private.std_normal_cdf(-8.0);
  if abs(v / 6.220960574271786e-16 - 1.0) > 1e-4 then
    raise exception 'std_normal_cdf(-8) = %, expected ~6.22096e-16', v;
  end if;

  -- Phi^-1(0.975) = 1.959963984540054
  v := private.std_normal_icdf(0.975);
  if abs(v - 1.959963984540054) > 1e-9 then
    raise exception 'std_normal_icdf(0.975) = %, expected 1.95996398454', v;
  end if;

  -- Round trip through the far tail.
  v := private.std_normal_icdf(private.std_normal_cdf(-3.5));
  if abs(v + 3.5) > 1e-7 then
    raise exception 'icdf(cdf(-3.5)) = %, expected -3.5', v;
  end if;

  -- W is a variance fraction: it must stay inside [0,1] everywhere, including
  -- the underflow branches that the asymptotic fallbacks cover.
  for v in select unnest(array[-40.0, -12.0, -3.0, 0.0, 3.0, 12.0, 40.0]) loop
    if private.w_win(v, 0.74) < 0.0 or private.w_win(v, 0.74) > 1.0 then
      raise exception 'w_win(%, 0.74) out of [0,1]: %', v, private.w_win(v, 0.74);
    end if;
    if private.w_draw(v, 0.74) < 0.0 or private.w_draw(v, 0.74) > 1.0 then
      raise exception 'w_draw(%, 0.74) out of [0,1]: %', v, private.w_draw(v, 0.74);
    end if;
    if private.v_win(v, 0.74) = 'NaN'::double precision
       or private.v_draw(v, 0.74) = 'NaN'::double precision then
      raise exception 'v function returned NaN at t = %', v;
    end if;
  end loop;

  -- A draw between identical teams must not move anyone: v_draw(0, eps) = 0.
  if abs(private.v_draw(0.0, 0.74)) > 1e-12 then
    raise exception 'v_draw(0, eps) = %, expected 0', private.v_draw(0.0, 0.74);
  end if;

  -- draw_margin with p = 0.10, beta = 25/6, n = 2 -> icdf(0.55)*sqrt(2)*beta
  v := private.draw_margin(0.10, 4.166666666666667, 2.0);
  if abs(v - 0.7405) > 1e-3 then
    raise exception 'draw_margin(0.10, 25/6, 2) = %, expected ~0.7405', v;
  end if;

  -- ---------------------------------------------------------------------------
  -- End-to-end regression against the published TrueSkill reference values.
  -- A default 1v1 (mu=25, sigma=25/3, beta=25/6, tau=25/300, p_draw=0.10):
  --     decisive -> winner (29.396, 7.171), loser (20.604, 7.171)
  --     drawn    -> both   (25.000, 6.458)
  -- Reproducing these exercises the entire chain in one shot: tau inflation,
  -- c, the eps/c standardisation, v, w and the variance shrink. It is the test
  -- that catches the standardisation bug that a plain "is it finite" check
  -- would sail straight past.
  -- ---------------------------------------------------------------------------
  v_s2  := 8.333333333333334 * 8.333333333333334
         + 0.08333333333333334 * 0.08333333333333334;             -- 69.45138889
  v_c2  := 2.0 * v_s2 + 2.0 * 4.166666666666667 * 4.166666666666667;
  v_c   := sqrt(v_c2);                                            -- 13.17668395
  v_eps := private.draw_margin(0.10, 4.166666666666667, 2.0) / v_c;

  if abs(v_eps - 0.05619521497878026) > 1e-9 then
    raise exception 'standardised draw margin = %, expected 0.056195215', v_eps;
  end if;

  -- Decisive result, evenly matched (t = 0).
  v_v  := private.v_win(0.0, v_eps);
  v_w  := private.w_win(0.0, v_eps);
  v_mu  := 25.0 + (v_s2 / v_c) * v_v;
  v_sig := sqrt(v_s2 * (1.0 - (v_s2 / v_c2) * v_w));

  if abs(v_mu - 29.395831692991514) > 1e-6 then
    raise exception 'default 1v1 winner mu = %, expected 29.3958317 (TrueSkill reference 29.396)', v_mu;
  end if;
  if abs(v_sig - 7.171475807009221) > 1e-6 then
    raise exception 'default 1v1 winner sigma = %, expected 7.1714758 (TrueSkill reference 7.171)', v_sig;
  end if;

  -- Drawn result: mu must not move at all, sigma must tighten to 6.458.
  v_v  := private.v_draw(0.0, v_eps);
  v_w  := private.w_draw(0.0, v_eps);
  v_sig := sqrt(v_s2 * (1.0 - (v_s2 / v_c2) * v_w));

  if abs(v_v) > 1e-12 then
    raise exception 'default 1v1 draw moved mu by %, expected 0', v_v;
  end if;
  if abs(v_sig - 6.457515683245048) > 1e-6 then
    raise exception 'default 1v1 draw sigma = %, expected 6.4575157 (TrueSkill reference 6.458)', v_sig;
  end if;

  raise notice '0004_trueskill: numeric self-tests passed (default 1v1 reproduces the TrueSkill reference 29.396/7.171 and 25.000/6.458).';
end
$selftest$;
