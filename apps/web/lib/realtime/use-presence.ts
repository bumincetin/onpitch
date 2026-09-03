"use client"

/**
 * lib/realtime/use-presence.ts
 *
 * "Who is actually at the pitch right now."
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT PRESENCE IS
 * ---------------------------------------------------------------------------------------------
 *
 * Presence is ephemeral state held in the Realtime server's CRDT and replicated between Realtime
 * nodes. It never touches the WAL, never touches a table, and is gone the moment the last member
 * of the channel leaves (0006 §7). Nothing here is durable and nothing here is evidence:
 *
 *   * Attendance that MATTERS is `match_participants.is_confirmed`, written through PostgREST
 *     like any other row and protected by RLS.
 *   * A presence payload is authored by the client that sent it. `teamSide` in a presence entry
 *     is a hint for the roster UI, never an input to scoring, quorum or rating.
 *   * The only fact the server may derive from presence is "someone holding this profile id has a
 *     live socket on this match" — and even that is only as trustworthy as the topic ACL.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS WRAPS THE MATCH CHANNEL
 * ---------------------------------------------------------------------------------------------
 *
 * Presence rides the SAME channel as the score feed, `match:<id>`, as prescribed by 0006 §7:
 *
 *   * One socket, one join, one authorisation. Presence inherits the `realtime.messages` ACL for
 *     `extension = 'presence'` automatically instead of needing policies of its own that could
 *     drift from the broadcast ones.
 *   * A separate `presence:<id>` topic would match NO policy in 0006, and RLS with zero policies
 *     denies — the channel would never join, silently.
 *   * Realtime is Phoenix underneath, and Phoenix rejects a second join on a topic the socket has
 *     already joined. Two channels for one match leaves the second one permanently errored.
 *
 * So `usePresence` is `useMatchChannel` with the caller only reading the presence lane. If a page
 * needs BOTH the scoreboard and a roster, it must call `useMatchChannel` ONCE, at the top, and
 * pass `members` down as props — see `app/(app)/matches/[id]/live/page.tsx`. `useMatchChannel`
 * asserts on the duplicate in development so this cannot be got wrong quietly.
 *
 * ---------------------------------------------------------------------------------------------
 * KEYING
 * ---------------------------------------------------------------------------------------------
 *
 * The presence key is the PROFILE ID, never a per-connection id. The key is the deduplication
 * unit: keyed by user, a player whose wifi drops and who comes back on 4G replaces their own
 * entry and the headcount converges. Keyed by connection, the count inflates on every reconnect
 * and never comes back down.
 */

import { useMemo } from "react"

import { useMatchChannel } from "@/lib/realtime/use-match-channel"
import type { MatchPresencePayload, RealtimeConnection } from "@onpitch/shared/channels"

export type { MatchPresencePayload }

export interface UsePresenceOptions {
  matchId: string
  /**
   * What to publish about the viewer, or `null` to watch invisibly.
   *
   * Keep it small: the FULL presence state is re-sent to every member on every join and leave, so
   * the bytes cost roughly members-squared over a session. And never put coordinates in it —
   * `profiles.location_sharing_enabled` defaults to false and `profiles_minor_privacy_locked_check`
   * hard-locks it off for minors. Presence is not an exemption from that constraint.
   */
  self?: MatchPresencePayload | null
  /** False keeps the socket closed. Use it to switch presence off for a finished match. */
  enabled?: boolean
}

export interface UsePresenceResult {
  /** Everyone currently on the channel, sorted by display name. */
  members: MatchPresencePayload[]
  /** The same set keyed by profile id, for O(1) lookups while rendering a roster. */
  byId: Record<string, MatchPresencePayload>
  /** Headcount. Correct precisely because the presence key is the profile id. */
  count: number
  connection: RealtimeConnection
  error: string | null
  /** Is this specific player here right now? */
  isPresent: (profileId: string) => boolean
}

/**
 * Presence for one match.
 *
 * @example
 * const { members, isPresent } = usePresence({
 *   matchId,
 *   self: { profileId: user.id, displayName: profile.display_name, teamSide: 'home',
 *           checkedInAt: new Date().toISOString() },
 * })
 */
export function usePresence(options: UsePresenceOptions): UsePresenceResult {
  const { matchId, self = null, enabled = true } = options

  /*
   * The score lane is joined too — it comes free with the channel and cannot be joined separately.
   * The initial snapshot is a throwaway: `updatedAt` is the epoch so any authoritative event is
   * accepted, and the caller here never reads `score` or `status`. It costs one `select` of the
   * match row per (re)connect, which is the same read the page already did server-side.
   */
  const channel = useMatchChannel({
    matchId,
    enabled,
    presence: self,
    initial: {
      homeScore: null,
      awayScore: null,
      status: "scheduled",
      updatedAt: new Date(0).toISOString(),
    },
  })

  const { presence, members, connection, error } = channel

  const isPresent = useMemo(() => {
    return (profileId: string) => Object.prototype.hasOwnProperty.call(presence, profileId.toLowerCase())
  }, [presence])

  return {
    members,
    byId: presence,
    count: members.length,
    connection,
    error,
    isPresent,
  }
}
