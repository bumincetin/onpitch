/**
 * app/+native-intent.tsx
 *
 * Deep-link normalisation. expo-router hands every incoming link through `redirectSystemPath`
 * before it tries to match a route, which makes this the one place the link vocabulary is
 * defined:
 *
 *   halisaha://match/<uuid>     ->  /match/<uuid>
 *   halisaha://booking/<uuid>   ->  /booking/<uuid>
 *   halisaha://player/<uuid>    ->  /player/<uuid>
 *
 * The first two are the links that leave the app: a push notification about a score report, and
 * the booking confirmation email. The third is the player page a roster row opens, listed here so
 * a shared or notified profile link has somewhere to land rather than bouncing to the home tab.
 * Everything else falls through unchanged, so ordinary in-app navigation is unaffected by this
 * file existing.
 *
 * The id is checked against the uuid shape before it is forwarded. Not for security — the screen
 * still queries under RLS and gets nothing back for an id the caller cannot see — but because a
 * malformed id produces a screen stuck on a failed fetch, whereas the home tab is somewhere the
 * user can actually act.
 */

/** Same pattern as `isUuid` in @halisaha/shared/channels. Any RFC 4122 version, case-insensitive. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** The link prefixes this app publishes, mapped to the route that renders them. */
const DEEP_LINKS: ReadonlyArray<{ segment: string; route: string }> = [
  { segment: 'match', route: '/match' },
  { segment: 'booking', route: '/booking' },
  { segment: 'player', route: '/player' },
]

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const normalised = stripScheme(path)
  const segments = normalised.split('/').filter((segment) => segment.length > 0)

  // `noUncheckedIndexedAccess` is on: both of these are `string | undefined` until narrowed.
  const head = segments[0]
  const id = segments[1]

  if (head === undefined || id === undefined || segments.length !== 2) return path

  for (const link of DEEP_LINKS) {
    if (link.segment !== head.toLowerCase()) continue
    return UUID.test(id) ? `${link.route}/${id.toLowerCase()}` : '/'
  }

  return path
}

/**
 * Turns `halisaha://match/<id>`, `https://halisaha.app/match/<id>` and `/match/<id>` into
 * `match/<id>`.
 *
 * Hand-parsed rather than handed to `new URL()`: a custom scheme with no authority parses
 * inconsistently across platforms — `halisaha://match/x` puts `match` in the host on one and in
 * the path on the other — and getting that wrong drops the first segment of every link.
 */
function stripScheme(path: string): string {
  // Query and fragment are not part of the route match. Dropping them here keeps
  // `/match/<id>?from=push` from being read as an id of `<id>?from=push`.
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? ''

  const schemeEnd = withoutQuery.indexOf('://')
  if (schemeEnd === -1) return withoutQuery.replace(/^\/+/, '')

  const rest = withoutQuery.slice(schemeEnd + 3)
  const scheme = withoutQuery.slice(0, schemeEnd).toLowerCase()

  // For http(s) the first segment is a hostname and is not part of the route. For the custom
  // scheme there is no authority at all, so the first segment is already the route.
  if (scheme === 'http' || scheme === 'https') {
    const slash = rest.indexOf('/')
    return slash === -1 ? '' : rest.slice(slash + 1)
  }

  return rest.replace(/^\/+/, '')
}
