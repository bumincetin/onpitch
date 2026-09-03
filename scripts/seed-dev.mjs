#!/usr/bin/env node
/**
 * Seeds the local Supabase stack with accounts and demo data so the app can be clicked through.
 *
 *   node scripts/seed-dev.mjs
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment, or falls back to the
 * values `supabase status` prints for a default local stack.
 *
 * Development only. It uses the service-role key, which bypasses RLS, and it creates accounts
 * with a shared, published password. Never point it at a database anyone else can reach.
 */
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!KEY) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required. Run: npx supabase status')
  process.exit(1)
}

const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const PASSWORD = 'onpitch-dev-2026'
const day = 86_400_000
const now = Date.now()
const at = (offsetDays, hour) => {
  const d = new Date(now + offsetDays * day)
  d.setHours(hour, 0, 0, 0)
  return d
}
const iso = (d) => d.toISOString()
const range = (start, end) => `[${iso(start)},${iso(end)})`

function ok(label, error) {
  if (error) {
    console.log(`  ✗ ${label}: ${error.message ?? error}`)
    return false
  }
  console.log(`  ✓ ${label}`)
  return true
}

/** Age in whole years, used to build a date of birth that lands either side of the Art. 8 line. */
const dobForAge = (years) => {
  const d = new Date(now - years * 365.25 * day)
  return d.toISOString().slice(0, 10)
}

const PEOPLE = [
  { key: 'admin', email: 'admin@onpitch.dev', name: 'Deniz Yılmaz', role: 'admin', age: 34, city: 'İstanbul' },
  { key: 'owner', email: 'owner@onpitch.dev', name: 'Kemal Arslan', role: 'venue_owner', age: 41, city: 'İstanbul' },
  { key: 'owner2', email: 'owner2@onpitch.dev', name: 'Selin Kaya', role: 'venue_owner', age: 38, city: 'Ankara' },
  { key: 'ayse', email: 'ayse@onpitch.dev', name: 'Ayşe Demir', role: 'player', age: 27, city: 'İstanbul', position: 'midfielder' },
  { key: 'mehmet', email: 'mehmet@onpitch.dev', name: 'Mehmet Öz', role: 'player', age: 31, city: 'İstanbul', position: 'forward' },
  { key: 'burak', email: 'burak@onpitch.dev', name: 'Burak Şahin', role: 'player', age: 24, city: 'İstanbul', position: 'goalkeeper' },
  { key: 'elif', email: 'elif@onpitch.dev', name: 'Elif Çelik', role: 'player', age: 29, city: 'İstanbul', position: 'defender' },
  { key: 'can', email: 'can@onpitch.dev', name: 'Can Aydın', role: 'player', age: 22, city: 'İstanbul', position: 'midfielder' },
  { key: 'zeynep', email: 'zeynep@onpitch.dev', name: 'Zeynep Koç', role: 'player', age: 26, city: 'İstanbul', position: 'forward' },
  // Under 16: exercises the Art. 8 age gate, the locked privacy defaults and the consent banner.
  { key: 'minor', email: 'genc@onpitch.dev', name: 'Kaan Tunç', role: 'player', age: 14, city: 'İstanbul', position: 'midfielder' },
]

const ids = {}

console.log(`\nSeeding ${URL}\n`)

console.log('accounts')
for (const p of PEOPLE) {
  const { data, error } = await db.auth.admin.createUser({
    email: p.email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: {
      full_name: p.name,
      display_name: p.name.split(' ')[0],
      date_of_birth: dobForAge(p.age),
      role: p.role === 'admin' ? 'player' : p.role, // admin is never self-assignable
    },
  })
  if (error && !/already registered/i.test(error.message)) {
    ok(p.email, error)
    continue
  }
  if (error) {
    const { data: list } = await db.auth.admin.listUsers({ perPage: 200 })
    const found = list?.users?.find((u) => u.email === p.email)
    if (found) ids[p.key] = found.id
    console.log(`  · ${p.email} already existed`)
    continue
  }
  ids[p.key] = data.user.id
  console.log(`  ✓ ${p.email}  (${p.role})`)
}

// The signup trigger clamps role to player. Elevate the two that need more, with the service key.
console.log('\nroles and profile detail')
for (const p of PEOPLE) {
  if (!ids[p.key]) continue
  const patch = { city: p.city, full_name: p.name, display_name: p.name.split(' ')[0] }
  if (p.position) patch.preferred_position = p.position
  if (p.role !== 'player') patch.role = p.role
  const { error } = await db.from('profiles').update(patch).eq('id', ids[p.key])
  if (error) ok(p.email, error)
}
console.log(`  ✓ ${PEOPLE.filter((p) => p.role !== 'player').length} elevated, ${PEOPLE.length} profiles filled`)

// leaderboard_page() only publishes profiles whose visibility is 'public', and the column
// defaults to 'private'. Without this the ranking is empty in a dev build and the feature looks
// broken rather than opt-in. The minor is deliberately excluded: Postgres refuses a public
// visibility for an under-16 account (profiles_minor_privacy_locked_check), so asking for one
// would be asking for an error.
{
  const adults = PEOPLE.filter((p) => p.key !== 'minor' && ids[p.key]).map((p) => ids[p.key])
  const { error } = await db.from('profiles').update({ profile_visibility: 'public' }).in('id', adults)
  if (error) ok('profile visibility', error)
  else console.log(`  ✓ ${adults.length} profiles made public (leaderboard opt-in)`)
}

// Grant the minor's consent so the account is browsable in both states across the demo data.
if (ids.minor) {
  await db
    .from('profiles')
    .update({ guardian_name: 'Ayla Tunç', guardian_email: 'veli@onpitch.dev', parental_consent_status: 'pending' })
    .eq('id', ids.minor)
  console.log('  ✓ minor account left at parental_consent_status = pending')
}

console.log('\nvenues and pitches')
const venues = [
  {
    key: 'v1',
    owner: 'owner',
    name: 'Kadıköy Spor Kompleksi',
    slug: 'kadikoy-spor-kompleksi',
    city: 'İstanbul',
    district: 'Kadıköy',
    address_line1: 'Fikirtepe Mah. Sahil Yolu No 12',
    lat: 40.9903,
    lng: 29.0301,
    amenities: ['duş', 'otopark', 'kafeterya', 'aydınlatma', 'soyunma odası'],
  },
  {
    key: 'v2',
    owner: 'owner',
    name: 'Bostancı Halı Saha',
    slug: 'bostanci-hali-saha',
    city: 'İstanbul',
    district: 'Bostancı',
    address_line1: 'Bağdat Cad. No 340',
    lat: 40.9601,
    lng: 29.0949,
    amenities: ['duş', 'otopark', 'aydınlatma'],
  },
  {
    key: 'v3',
    owner: 'owner2',
    name: 'Çankaya Arena',
    slug: 'cankaya-arena',
    city: 'Ankara',
    district: 'Çankaya',
    address_line1: 'Kızılırmak Mah. 1450. Sok. No 3',
    lat: 39.9083,
    lng: 32.8597,
    amenities: ['duş', 'kafeterya', 'kapalı saha'],
  },
]

for (const v of venues) {
  const { data, error } = await db
    .from('venues')
    .upsert(
      {
        owner_id: ids[v.owner],
        name: v.name,
        slug: v.slug,
        description: `${v.district} bölgesinde ${v.name}. Hafta içi ve hafta sonu rezervasyona açık.`,
        address_line1: v.address_line1,
        city: v.city,
        district: v.district,
        country: 'TR',
        latitude: v.lat,
        longitude: v.lng,
        amenities: v.amenities,
        phone: '+90 216 000 00 00',
        timezone: 'Europe/Istanbul',
        is_active: true,
        charges_enabled: true,
        payouts_enabled: true,
        stripe_account_id: `acct_dev_${v.key}`,
        onboarding_completed_at: iso(new Date(now - 30 * day)),
      },
      { onConflict: 'slug' }
    )
    .select('id')
    .single()
  if (!ok(v.name, error)) continue
  ids[v.key] = data.id
}

const pitches = [
  { key: 'p1', venue: 'v1', name: '1 Numaralı Saha', format: 'seven_a_side', surface: 'artificial_turf', rate: 90000, capacity: 14 },
  { key: 'p2', venue: 'v1', name: '2 Numaralı Saha', format: 'five_a_side', surface: 'artificial_turf', rate: 70000, capacity: 10 },
  { key: 'p3', venue: 'v1', name: 'Kapalı Saha', format: 'five_a_side', surface: 'indoor_court', rate: 110000, capacity: 10, indoor: true },
  { key: 'p4', venue: 'v2', name: 'Ana Saha', format: 'eight_a_side', surface: 'hybrid', rate: 105000, capacity: 16 },
  { key: 'p5', venue: 'v3', name: 'Arena 1', format: 'seven_a_side', surface: 'natural_grass', rate: 85000, capacity: 14 },
]

for (const p of pitches) {
  if (!ids[p.venue]) continue
  const { data, error } = await db
    .from('pitches')
    .upsert(
      {
        venue_id: ids[p.venue],
        name: p.name,
        format: p.format,
        surface: p.surface,
        is_indoor: Boolean(p.indoor),
        capacity: p.capacity,
        hourly_rate_minor: p.rate,
        currency: 'try',
        opening_time: '08:00',
        closing_time: '23:00',
        slot_minutes: 60,
        is_active: true,
      },
      { onConflict: 'venue_id,name' }
    )
    .select('id')
    .single()
  if (!ok(`${p.name}`, error)) continue
  ids[p.key] = data.id
}

console.log('\nteams')
const teams = [
  { key: 't1', owner: 'ayse', name: 'Kadıköy Kartalları', slug: 'kadikoy-kartallari', members: ['ayse', 'mehmet', 'burak', 'elif'] },
  { key: 't2', owner: 'can', name: 'Bostancı United', slug: 'bostanci-united', members: ['can', 'zeynep', 'minor'] },
]
for (const t of teams) {
  const { data, error } = await db
    .from('teams')
    .upsert(
      { owner_id: ids[t.owner], name: t.name, slug: t.slug, city: 'İstanbul', is_public: true, description: `${t.name} — haftalık halı saha takımı.` },
      { onConflict: 'slug' }
    )
    .select('id')
    .single()
  if (!ok(t.name, error)) continue
  ids[t.key] = data.id
  let jersey = 7
  for (const m of t.members) {
    if (!ids[m]) continue
    await db.from('team_members').upsert(
      { team_id: data.id, player_id: ids[m], role: m === t.owner ? 'captain' : 'member', jersey_number: jersey++ },
      { onConflict: 'team_id,player_id' }
    )
  }
}

console.log('\nbookings')
const bookings = [
  { key: 'b1', pitch: 'p1', by: 'ayse', team: 't1', start: at(3, 20), status: 'confirmed', payment: 'succeeded' },
  { key: 'b2', pitch: 'p2', by: 'can', team: 't2', start: at(5, 21), status: 'confirmed', payment: 'succeeded' },
  { key: 'b3', pitch: 'p1', by: 'mehmet', team: null, start: at(-7, 20), status: 'completed', payment: 'succeeded' },
  { key: 'b4', pitch: 'p4', by: 'elif', team: null, start: at(1, 19), status: 'awaiting_payment', payment: 'requires_payment' },
]
for (const b of bookings) {
  if (!ids[b.pitch] || !ids[b.by]) continue
  const end = new Date(b.start.getTime() + 3_600_000)
  const subtotal = pitches.find((p) => p.key === b.pitch).rate
  const fee = Math.round(subtotal * 0.1)
  const { data, error } = await db
    .from('bookings')
    .insert({
      pitch_id: ids[b.pitch],
      booked_by: ids[b.by],
      team_id: b.team ? ids[b.team] : null,
      time_range: range(b.start, end),
      status: b.status,
      payment_status: b.payment,
      subtotal_minor: subtotal,
      platform_fee_minor: fee,
      total_minor: subtotal,
      currency: 'try',
      connected_account_id: 'acct_dev_v1',
      stripe_payment_intent_id: b.payment === 'succeeded' ? `pi_dev_${b.key}` : null,
    })
    .select('id')
    .single()
  if (!ok(`${b.key} ${b.status}`, error)) continue
  ids[b.key] = data.id
}

console.log('\nmatches')
const squadA = ['ayse', 'mehmet', 'burak']
const squadB = ['elif', 'can', 'zeynep']

async function makeMatch({ key, booking, pitch, venue, kickoff, status, home, away, extra = {} }) {
  const { data, error } = await db
    .from('matches')
    .insert({
      booking_id: booking ? ids[booking] : null,
      pitch_id: ids[pitch],
      venue_id: ids[venue],
      format: 'seven_a_side',
      status,
      kickoff_at: iso(kickoff),
      duration_minutes: 60,
      home_team_id: ids.t1,
      away_team_id: ids.t2,
      is_ranked: true,
      created_by: ids.ayse,
      ...extra,
    })
    .select('id')
    .single()
  if (!ok(`${key} (${status})`, error)) return null
  ids[key] = data.id
  const rows = [
    ...home.map((k) => ({ match_id: data.id, player_id: ids[k], team_side: 'home', is_confirmed: true })),
    ...away.map((k) => ({ match_id: data.id, player_id: ids[k], team_side: 'away', is_confirmed: true })),
  ].filter((r) => r.player_id)
  const { error: pe } = await db.from('match_participants').insert(rows)
  if (pe) console.log(`    participants: ${pe.message}`)
  return data.id
}

await makeMatch({
  key: 'm_finalized',
  booking: 'b3',
  pitch: 'p1',
  venue: 'v1',
  kickoff: at(-7, 20),
  status: 'finalized',
  home: squadA,
  away: squadB,
  extra: { home_score: 4, away_score: 2, score_confirmed_at: iso(at(-7, 22)), match_quality: 0.78, predicted_draw_probability: 0.21 },
})

await makeMatch({
  key: 'm_scheduled',
  booking: 'b1',
  pitch: 'p1',
  venue: 'v1',
  kickoff: at(3, 20),
  status: 'scheduled',
  home: squadA,
  away: squadB,
  extra: { match_quality: 0.83, predicted_draw_probability: 0.27 },
})

await makeMatch({
  key: 'm_live',
  booking: null,
  pitch: 'p2',
  venue: 'v1',
  kickoff: at(0, new Date().getHours()),
  status: 'live',
  home: squadA,
  away: squadB,
  extra: { home_score: 1, away_score: 1, match_quality: 0.9 },
})

// A disputed match, so the admin console's queue has something in it.
const disputed = await makeMatch({
  key: 'm_consensus',
  booking: 'b2',
  pitch: 'p2',
  venue: 'v1',
  // THREE HOURS AGO, NOT TWO DAYS. A single score report is accepted by default once the
  // 24h window closes, so a two-day-old fixture is already final by the time the opposing
  // captain files a conflicting one — and the seeder's consensus demo never opens.
  kickoff: at(0, new Date().getHours() - 3),
  status: 'requires_consensus',
  home: squadA,
  away: squadB,
  extra: {
    requires_consensus: true,
    anomaly_score: 0.74,
    anomaly_checked_at: iso(new Date(now - 60_000)),
    consensus_deadline: iso(new Date(now + 24 * 60 * 60_000)),
  },
})

if (disputed) {
  console.log('\nconflicting score reports and anomaly flag')
  const reports = [
    { by: 'ayse', side: 'home', h: 6, a: 1 },
    { by: 'can', side: 'away', h: 2, a: 5 },
  ]
  for (const r of reports) {
    const { error } = await db.from('score_reports').insert({
      match_id: disputed,
      reported_by: ids[r.by],
      team_side: r.side,
      home_score: r.h,
      away_score: r.a,
      // MINUTES AGO, NOT DAYS. `evaluate_score_consensus` accepts a single uncontested report
      // 24 hours after it was FILED, so a back-dated `reported_at` finalises the match on the
      // first insert and the second, conflicting report is refused — which is the whole thing
      // this fixture exists to demonstrate.
      reported_at: iso(new Date(now - (r.by === 'ayse' ? 6 : 3) * 60_000)),
    })
    ok(`report ${r.by} ${r.h}-${r.a}`, error)
  }
  const { error: fe } = await db.from('match_anomaly_flags').insert({
    match_id: disputed,
    source: 'isolation_forest',
    anomaly_score: 0.74,
    is_anomalous: true,
    model_version: 'rules-fallback-v1',
    leaf_depth: 3,
    average_path_length: 4.1,
    reasons: ['score variance in the 98th percentile', 'both rosters have met 5 times in 7 days', 'reported 41 seconds apart'],
  })
  ok('anomaly flag', fe)
}

/*
 * A season behind the demo data.
 *
 * Eight weekly matches, oldest first, so the seeded accounts land with a real streak, real form,
 * and enough history for the achievement thresholds to mean anything. Without it every dashboard
 * in a dev build reads "1 match, level 2" and none of the progression is visible.
 *
 * EACH ONE IS FINALIZED BY AN UPDATE, NOT BY AN INSERT. `trg_match_progression` fires on a status
 * TRANSITION into 'finalized' (0008), so a row inserted already-final never earns anything. Going
 * awaiting_report -> finalized is also the path production takes, so the seeder exercises the
 * trigger rather than working around it.
 */
console.log('\nseason history')
{
  const SEASON_WEEKS = 8
  // Not a monotone run: three home wins, two draws, three away wins, and a clean sheet each way
  // so the `wall` badge is reachable from the seed.
  const RESULTS = [
    { h: 3, a: 1 }, { h: 2, a: 2 }, { h: 0, a: 2 }, { h: 4, a: 0 },
    { h: 1, a: 3 }, { h: 2, a: 1 }, { h: 1, a: 1 }, { h: 0, a: 3 },
  ]
  let finalized = 0

  for (let week = SEASON_WEEKS; week >= 1; week--) {
    const result = RESULTS[SEASON_WEEKS - week]
    // Alternate venues so `distinct_venues` moves and `explorer` is reachable.
    const onV1 = week % 3 !== 0
    // Some late kick-offs, for `night_owl`.
    const kickoff = at(-7 * week, week % 4 === 0 ? 22 : 20)

    const matchId = await makeMatch({
      key: `m_w${week}`,
      booking: null,
      pitch: onV1 ? 'p1' : 'p4',
      venue: onV1 ? 'v1' : 'v2',
      kickoff,
      status: 'awaiting_report',
      home: squadA,
      away: squadB,
      extra: { match_quality: 0.7 + (week % 3) * 0.06 },
    })
    if (!matchId) continue

    // Goals go in BEFORE finalization: the progression trigger reads player_stats at the moment
    // the status flips, so a stat row written afterwards earns nothing.
    const sheet = [
      { k: 'ayse', side: 'home', team: 't1', g: Math.min(result.h, week % 2 === 0 ? 2 : 1), a: week % 3 === 0 ? 1 : 0 },
      { k: 'mehmet', side: 'home', team: 't1', g: Math.max(0, result.h - (week % 2 === 0 ? 2 : 1)), a: 1 },
      { k: 'burak', side: 'home', team: 't1', g: 0, a: 0, s: 4 + (week % 3) },
      { k: 'elif', side: 'away', team: 't2', g: week % 2 === 0 ? result.a : 0, a: 0 },
      { k: 'can', side: 'away', team: 't2', g: week % 2 === 0 ? 0 : result.a, a: week % 2 === 0 ? 1 : 0 },
      { k: 'zeynep', side: 'away', team: 't2', g: 0, a: 1 },
    ]
    const { error: se } = await db.from('player_stats').insert(
      sheet
        .filter((row) => ids[row.k])
        .map((row) => ({
          match_id: matchId,
          player_id: ids[row.k],
          team_id: ids[row.team],
          team_side: row.side,
          goals: row.g,
          assists: row.a,
          saves: row.s ?? 0,
          minutes_played: 60,
        })),
    )
    if (se) console.log(`    stats week ${week}: ${se.message}`)

    const { error: fe } = await db
      .from('matches')
      .update({
        status: 'finalized',
        home_score: result.h,
        away_score: result.a,
        score_confirmed_at: iso(at(-7 * week, 22)),
      })
      .eq('id', matchId)
    if (fe) ok(`finalize week ${week}`, fe)
    else finalized += 1
  }

  console.log(`  ✓ ${finalized} finalized matches across ${SEASON_WEEKS} weeks`)
}

console.log('\nratings and match stats')
const ratings = {
  ayse: [31.2, 4.1],
  mehmet: [28.7, 3.9],
  burak: [26.4, 5.2],
  elif: [24.9, 4.4],
  can: [22.1, 6.1],
  zeynep: [27.8, 4.8],
  minor: [25.0, 8.333333333333334],
}
for (const [key, [mu, sigma]] of Object.entries(ratings)) {
  if (!ids[key]) continue
  const played = key === 'minor' ? 0 : 8 + Math.floor(mu % 7)
  const { error } = await db.from('player_ratings').upsert(
    {
      player_id: ids[key],
      mu,
      sigma,
      matches_played: played,
      wins: Math.floor(played * 0.5),
      draws: Math.floor(played * 0.2),
      losses: played - Math.floor(played * 0.5) - Math.floor(played * 0.2),
      last_match_at: key === 'minor' ? null : iso(at(-7, 21)),
    },
    { onConflict: 'player_id' }
  )
  if (error) ok(key, error)
}
console.log(`  ✓ ${Object.keys(ratings).length} player ratings`)

if (ids.m_finalized) {
  const stats = [
    { k: 'ayse', side: 'home', team: 't1', g: 2, a: 1, before: [30.4, 4.3], after: [31.2, 4.1] },
    { k: 'mehmet', side: 'home', team: 't1', g: 2, a: 0, before: [28.0, 4.1], after: [28.7, 3.9] },
    { k: 'burak', side: 'home', team: 't1', g: 0, a: 0, s: 6, before: [25.8, 5.4], after: [26.4, 5.2] },
    { k: 'elif', side: 'away', team: 't2', g: 1, a: 0, before: [25.6, 4.6], after: [24.9, 4.4] },
    { k: 'can', side: 'away', team: 't2', g: 1, a: 1, before: [22.9, 6.3], after: [22.1, 6.1] },
    { k: 'zeynep', side: 'away', team: 't2', g: 0, a: 1, before: [28.5, 5.0], after: [27.8, 4.8] },
  ]
  for (const s of stats) {
    if (!ids[s.k]) continue
    const { error } = await db.from('player_stats').insert({
      match_id: ids.m_finalized,
      player_id: ids[s.k],
      team_id: ids[s.team],
      team_side: s.side,
      goals: s.g,
      assists: s.a,
      saves: s.s ?? 0,
      minutes_played: 60,
      mu_before: s.before[0],
      sigma_before: s.before[1],
      mu_after: s.after[0],
      sigma_after: s.after[1],
    })
    if (error) ok(`stats ${s.k}`, error)
  }
  console.log(`  ✓ ${stats.length} per-match stat rows`)
}

console.log('\nnotifications')
const notes = [
  { to: 'ayse', type: 'booking_confirmed', title: 'Rezervasyon onaylandı', body: 'Kadıköy Spor Kompleksi, 1 Numaralı Saha — 20:00' },
  { to: 'ayse', type: 'consensus_open', title: 'Skor onayı bekleniyor', body: 'Bostancı United maçının skoru için oy vermen gerekiyor.' },
  { to: 'owner', type: 'payout_paid', title: 'Ödeme aktarıldı', body: '₺810,00 hesabına gönderildi.' },
  { to: 'admin', type: 'match_disputed', title: 'İtirazlı maç', body: 'Bir maç anomali skoru 0.74 ile incelemeye alındı.' },
]
for (const n of notes) {
  if (!ids[n.to]) continue
  await db.from('notifications').insert({ user_id: ids[n.to], type: n.type, title: n.title, body: n.body, data: {} })
}
console.log(`  ✓ ${notes.length} notifications`)

// Matches inserted with status already 'finalized' never crossed the transition the trigger
// listens for. This is the same function an operator runs once after deploying 0008 to a database
// that already held finished football.
console.log('\nprogression backfill')
{
  const { data, error } = await db.rpc('backfill_progression', { p_limit: 500 })
  if (error) ok('backfill_progression', error)
  else console.log(`  ✓ ${data ?? 0} match(es) backfilled`)

  // The season above was replayed AFTER this week's challenges already existed, so each
  // player's baseline was captured somewhere in the middle of eight weeks of history and the
  // weekly objectives read as already finished. Dropping the rows makes `my_progress()`
  // recapture them at today's counters, which is the state a real player starts a week in.
  // Production never needs this: a challenge is created on Monday and the baseline is taken
  // the first time the player does anything after it.
  const { error: ce } = await db.from('challenge_progress').delete().gte('baseline', 0)
  if (ce) ok('challenge baseline reset', ce)
  else console.log('  ✓ weekly challenge baselines reset to today')

  // Leagues are driven by the same status transition, so matches inserted already-final never
  // reached the table either. Ordered by kick-off inside the function, so the standings
  // accumulate in the order the football was actually played.
  const { data: leagues, error: le } = await db.rpc('backfill_leagues', { p_limit: 500 })
  if (le) ok('backfill_leagues', le)
  else console.log(`  ✓ ${leagues ?? 0} match(es) counted toward a league`)
}

console.log('\n' + '─'.repeat(64))
console.log('  Sign in at http://localhost:3000/login')
console.log('  Password for every account below:  ' + PASSWORD)
console.log('─'.repeat(64))
for (const p of PEOPLE) {
  const note = p.key === 'minor' ? '  (under 16, consent pending)' : ''
  console.log(`  ${p.role.padEnd(12)} ${p.email.padEnd(24)} ${p.name}${note}`)
}
console.log('─'.repeat(64) + '\n')
