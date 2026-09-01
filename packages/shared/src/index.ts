// Code shared by the Next.js web app and the Expo mobile app.
//
// Everything here must stay platform-neutral: no next/*, no react-native, no node:*,
// no DOM globals. If a module cannot satisfy that, it belongs in an app, not here.
//
// The TrueSkill implementation is the one exception worth calling out. It mirrors
// public.trueskill2_update in supabase/migrations/0004_trueskill.sql, which remains
// the only writer of persisted ratings. This copy exists so both clients can preview
// a rating change without a round-trip, and the two must stay numerically identical.

export * from "./database"
export * from "./domain"
export * from "./trueskill"
export * from "./balance"
export * from "./quality"
export * from "./channels"
export * from "./gamification"
export * from "./leagues"
export * from "./matchday"
