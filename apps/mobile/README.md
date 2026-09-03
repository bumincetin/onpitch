# @onpitch/mobile

The Expo client. It signs in against the same Supabase project as the web app and calls the same
`/api/**` route handlers. The TrueSkill engine, domain schemas and realtime topic strings are
imported from `packages/shared` rather than copied.

## Running it

From the repository root, once:

```bash
npm install
cp apps/mobile/.env.example apps/mobile/.env   # then fill it in
```

Then:

```bash
npm run dev            # the Next.js app, which serves /api/** — the phone needs it
npm run dev:mobile     # Metro
```

`npm run dev:mobile` runs `expo start` in `apps/mobile`. Press `a` for Android, `i` for iOS, or
scan the QR code.

`apps/mobile` is not one of the root npm workspaces. It keeps its own `package-lock.json` so the
Expo SDK can pin React Native's dependency graph, and the root `postinstall` installs it with
`npm --prefix apps/mobile install`. `packages/shared` arrives as a `file:` dependency, symlinked
into `apps/mobile/node_modules/@onpitch/shared`, which is why the root install has to run first.

`EXPO_PUBLIC_API_URL` has to be an address the phone can reach. On a device
`http://localhost:3000` resolves to the phone itself, not to your laptop:

| Where the app runs | What to set |
| --- | --- |
| Physical device on the same Wi-Fi | `http://<your-lan-ip>:3000` |
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator | `http://localhost:3000` |

Env values are inlined into the bundle at build time, so after editing `.env` restart with
`npx expo start --clear`. A warm Metro cache keeps serving the old ones.

The pinned dependency versions are the ones this app was written against. If Expo complains that
one is off, `npx expo install --check` reconciles them with the SDK.

## How the monorepo resolution works

`metro.config.js` overrides four Metro defaults. Left at their defaults, each one produces a red
screen that points somewhere other than the resolution problem causing it:

1. **`watchFolders = [workspaceRoot]`** — `@onpitch/shared` is a symlink into
   `packages/shared`. Metro only reads files under the project root plus the watch folders, so
   without this every shared import fails to resolve and edits to the shared code never trigger a
   reload.
2. **`resolver.nodeModulesPaths`** — npm hoists most dependencies to `<root>/node_modules` and
   leaves conflicting ones in `apps/mobile/node_modules`. Both are listed, project-local first, so
   a locally pinned package wins.
3. **`resolver.disableHierarchicalLookup = true`** — stops Node's parent-directory walk. Without
   it a file in `packages/shared/src` can resolve `react` against a stray
   `packages/shared/node_modules`, the app loads two Reacts, and every hook throws
   "Invalid hook call" while pointing at the wrong component.
4. **`resolver.unstable_enablePackageExports = true`** — `@onpitch/shared` ships TypeScript
   source with no build step. `@onpitch/shared/domain` resolves only through the subpath exports
   map in its `package.json`; there is no file at the package root to fall back to.

Metro compiles the shared TypeScript itself, the same way Next compiles it through
`transpilePackages`. There is no build step to run before starting the app.

## The module contract

Screens import from these and do not redefine them.

| Module | Exports |
| --- | --- |
| `@/lib/supabase` | `supabase`, `SessionProvider`, `useSession()`, `useProfile()`, `Profile` |
| `@/lib/api` | `apiFetch<T>()`, `ApiError`, `isApiError()` |
| `@/lib/theme` | `theme`, `darkTheme`, `useTheme()`, `useIsDark()`, `ThemeColors`, `Theme` |
| `@/lib/format` | `formatKickoff`, `formatRelative`, `formatTime`, `formatTimeRange`, `formatDayLabel`, `formatDuration`, plus the money helpers re-exported from `@onpitch/shared/domain` (`formatMinor`, `toMinor`, `fromMinor`, `asMinor`, `minorUnitExponent`, `DEFAULT_CURRENCY`) |
| `@/lib/data-error` | `DataError`, `dataError()`, `isDataError()` — the shape screens throw for a failed Supabase read |
| `@/lib/gdpr` | `assessAge()`, `hasTransactingConsent()`, `consentBlockReason()`, `MINOR_PRIVACY_EXPLANATIONS`, the age constants |
| `@/lib/env` | `env` — the four `EXPO_PUBLIC_*` values, validated once at import |
| `@/components/ui` | `Screen`, `Text`, `Heading`, `Button`, `Card`, `Field`, `Toggle`, `Badge`, `Notice`, `NoticeBullet`, `Spinner`, `EmptyState`, `Separator`, `Sheet`, `Avatar` |

`useSession()` returns `{ session, user, profile, loading, profileError, refresh, signOut }`.
`loading` stays true until both the stored session and the first profile read have settled, which
is what lets `app/_layout.tsx` hold the splash instead of flashing the signed-in UI.

`apiFetch` attaches the Supabase access token as `Authorization: Bearer <jwt>`, parses the
`ApiResponse<T>` envelope, and throws `ApiError` with the route's own `code` and `message` when
the envelope says `ok: false`. Catch once per screen; do not branch on `ok` at the call site.

The web side accepts that header: `createRouteClient()` in `apps/web/lib/supabase/server.ts`
resolves a bearer token when there is one and falls back to the browser's cookies, so the same
route handler serves both clients under the same RLS.

## Sessions

The session lives in AsyncStorage, not SecureStore. `lib/supabase.ts` explains why in full: the
serialised session exceeds SecureStore's 2 KB Android limit, and the refresh token is a rotating,
revocable bearer credential rather than a long-lived secret. `expo-secure-store` stays configured
in `app.json` for values that genuinely are secrets — the device signing key behind
`ConsensusApprovalInput.signature`, when that ships.

An `AppState` listener drives `supabase.auth.startAutoRefresh()` / `stopAutoRefresh()`, so the
refresh timer does not fire late against an expired token after the app is resumed.

## Routes

```
app/
  _layout.tsx            providers, splash gate, root Stack, ErrorBoundary
  index.tsx              redirect: session -> (tabs), otherwise -> (auth)/sign-in
  +native-intent.tsx     deep-link normalisation
  (auth)/
    _layout.tsx          signed-out Stack. Deliberately does NOT redirect on session.
    sign-in.tsx
    age-gate.tsx         GDPR Art. 8. Runs BEFORE the account form.
    sign-up.tsx          reads the gate's result from route params
  (tabs)/
    _layout.tsx          Matches | Book | Profile, with a session guard
    index.tsx            Matches
    book.tsx             Book
    profile.tsx          Profile
  match/[id]/
    index.tsx            match detail        <- onpitch://match/<uuid>
    live.tsx             live score, broadcast + Postgres Changes
    report.tsx           file a scoreline
    consensus.tsx        peer-consensus vote, when requires_consensus is set
  booking/[id].tsx       booking detail      <- onpitch://booking/<uuid>
  player/[id].tsx        player profile      <- onpitch://player/<uuid>
  venue/[slug].tsx       venue, pitch list
  venue/[slug]/[pitchId].tsx   slot grid for one pitch
  bookings.tsx           the signed-in user's bookings
  teams.tsx              teams the user belongs to
  settings/
    index.tsx
    notifications.tsx
    privacy.tsx          minors' locked toggles live here
```

The `(tabs)` filenames are fixed by `(tabs)/_layout.tsx`, and the three deep-link targets by
`+native-intent.tsx`. Renaming one silently drops the tab or sends the link to `/`.

## Deep links

Scheme is `onpitch`, declared in `app.json` and mirrored in the Android intent filter.
`app/+native-intent.tsx` normalises every incoming link before expo-router matches it:

```
onpitch://match/<uuid>     ->  /match/<uuid>
onpitch://booking/<uuid>   ->  /booking/<uuid>
onpitch://player/<uuid>    ->  /player/<uuid>
```

`https://onpitch.app/<segment>/<uuid>` and a bare `/<segment>/<uuid>` normalise to the same
routes. Anything else falls through unchanged, so in-app navigation is unaffected.

The id is checked against the uuid shape first. A malformed one goes to `/` rather than to a
screen that will sit on a failed fetch. That check is not a security control — the target screen
still queries under RLS and gets nothing back for an id the caller cannot see.

The same scheme is passed to `StripeProvider` as `urlScheme`, which is how a 3-D Secure challenge
returns to the app instead of stranding the customer in a browser tab.

Test one without a build:

```bash
npx uri-scheme open "onpitch://match/00000000-0000-4000-8000-000000000000" --android
```

## The age gate

`(auth)/age-gate.tsx` runs first, before any account details are collected. Under 13 is refused
outright; 13 to 15 collects a guardian's name and email and `sign-up.tsx` posts them to
`/api/auth/parental-consent/request` once a session exists. 16 and over passes straight through.

None of it is a security control. `private.is_minor_dob()`, `enforce_minor_privacy` and
`assert_consented()` make the same decisions in Postgres, and those are the ones that count. The
client-side copy exists so people get an explanation instead of a 42501.

Controls a minor cannot change are rendered **disabled with a reason**, never hidden — that is
what `Toggle`'s `lockedReason` prop is for. Hiding the row leaves the user hunting for a setting;
sending the write anyway earns a CHECK violation from the database.
