# OnPitch — Design

The product is set at a floodlit onpitch at night. That is not a theme on the landing page; it is
the ground the whole app stands on.

---

## The two halves of one palette

The design system came out of an editorial reference whose own tokens name `#1b2230` "white" and
`#f6f1e7` "obsidian" — it is a dark theme inverted onto paper. OnPitch uses both halves:

| | Ground | Ink | Accent |
|---|---|---|---|
| `:root` (marketing, light app theme) | `#f6f1e7` paper | `#1b2230` navy | `#b8902e` gold |
| `.night` (landing page, whole signed-in shell) | `#05070c` | `#f6f1e7` | `#e0b352` |
| `.dark` (the user's own theme choice) | `#1b2230` | `#f6f1e7` | `#d4a838` |

`.night` is **not** `.dark`. Dark mode is a preference the visitor set and it still governs
anything outside the signed-in shell; `.night` is a scope the product applies to itself. Every
accent keeps its meaning across all three and only its luminance changes: gold is the floodlight
and the caution, vermilion the away kit and the red card, teal the confirmed result.

Radius is **2px** everywhere. A cut edge, not a corner. Headings are `font-weight: 300` — weight
comes from size and space, never from bold.

---

## The pitch is the page

Every signed-in surface opens on a live WebGL pitch, framed by what the page is about.

| Shot | Where it is used |
|---|---|
| `stands` | ranking, player profiles — above the corner flag, whole pitch in frame |
| `centre` | dashboard, matches — boot height at the centre circle |
| `goalmouth` | badges, bookings — behind the goal, down the length |
| `touchline` | venues, checkout — outside the cage, looking in through the chain link |
| `aerial` | leagues, notifications, account — high and square on, the markings legible |
| `tunnel` | sign-in, team creation — low and central, walking in |

A header that was the same picture on twenty screens would stop being a place and start being
wallpaper, so the shot changes with the route. `components/three/route-banner.tsx` maps prefixes to
shots for the `(app)` group; the `(dashboard)` pages pass `shot` to `NightBand`.

**One canvas per page.** WebGL contexts are a scarce browser resource and a page that mounted
three of these would start losing them, so the banner lives in the layout rather than on each
page — which also means a new route gets the treatment by existing rather than by opting in.

### What makes it affordable

| | Landing page | Banner |
|---|---|---|
| Pitches | 4 (3 lit, 1 finished for the night) | 1 |
| Figures | 36 | 12 |
| Scenery | skyline, poplars, 260 moths | 8 blocks, 90 moths |
| Camera | Catmull-Rom spline driven by scroll | one composed shot, ~40s drift |
| Stops when | opaque content covers it | it scrolls out of view |

Plus, on both: a frame-time governor that drops render resolution when the average slips, a pause
on `document.hidden`, and `prefers-reduced-motion` painting **one still frame** and never starting
the loop.

### It is progressive, not required

`.night-fallback` — four floodlight pools over a horizon that goes warm at the bottom — is painted
server-side and the canvas fades in over it. A blocklisted driver, a failed context, a locked-down
browser and a slow chunk all land on the same composition without the motion. **No page requires
WebGL to be readable.**

---

## Type

Onest 300/400/500 for text, JetBrains Mono for labels and numerals, both self-hosted through
`next/font`. Uppercase mono at `0.6875rem` with `0.14em` tracking is the label voice — section
eyebrows, table headers, status chips: anywhere a word names a thing rather than says it.

Numbers are `tabular-nums` wherever they line up: scores, money, ratings, standings.

---

## Language

The product is **Turkish**. Every user-facing string in the web app and the Expo app, every
notification the database writes, every API error message.

Dates, times and numbers are formatted `tr-TR`. Times are rendered in the **venue's** timezone, not
the reader's: a fixture at 21:00 in Istanbul is at 21:00 for everyone going to it, whatever their
laptop thinks. Where a venue has no timezone the UI says so rather than passing off a device-local
time as the venue's.

Code, comments and documentation stay in English — they are read by a different audience than the
app is.

---

## Mobile

The Expo app carries the same palette, the same 2px radius, the same mono labels, the same numbered
section heads and hairline rules.

Two deliberate divergences:

**No WebGL.** Adding `expo-gl` means a native module and a dev build, against an Expo SDK 57
dependency set that was hard-won and is currently verified. The phone paints what the web paints
before the canvas arrives: `components/ui/night-band.tsx` is `.night-fallback` built from stacked
translucent Views — four floodlight pools over a horizon that goes warm at the bottom, the ruled
grid, the hairline — and every tab opens on one. The profile card draws its six "shots" as pitch
markings from borders. This is a reversible decision, not a permanent one.

**Always night.** There are no marketing pages on the phone, so `useTheme()` returns the night
palette regardless of the OS setting — the same rule the web applies to its signed-in shell.
The person's accent (`profiles.accent_color`) is `colors.user` on the theme.

**Motion, on the UI thread.** `lib/motion.ts` is the vocabulary: `riseIn(index)` for rows
arriving, `appear()` for a bubble, `useCountUp()` for a number, and the web's ease-out curve.
The band's pitch is laid flat with `rotateX` and a vanishing point and drifts for forty seconds
like the web camera; its floodlight pools breathe out of phase. The profile card tilts toward the
finger through `components/ui/tilt.tsx` (a pan gesture, perspective and two rotations, a
specular highlight sliding the other way, a spring back to flat). Every timing carries
`ReduceMotion.System`, and the JS-driven count-up asks the OS itself. On the web the card gets
the same tilt from the pointer in `components/profile/tilt-card.tsx`, and lists use the
`rise-stagger` utility.

**A plate, not a ring.** The web draws the level as an SVG arc; the phone draws a number with a
hairline bar under it, because an SVG arc in React Native means adding `react-native-svg` for one
decorative circle. The plate says the same three things — which level, how far into it, what is
left — in the same vocabulary.
