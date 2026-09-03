/**
 * lib/profile/accent.ts
 *
 * The person's chosen colour, as CSS.
 *
 * `profiles.accent_color` is a NAME (`gold`, `teal`, …). This module is where the name becomes a
 * token: an `H S% L%` triple in the same form as every other colour in `globals.css`, so it can be
 * dropped into `--accent-user` on the signed-in shell and used through Tailwind as `text-user`,
 * `bg-user/20`, `ring-user`. One variable, set once on the wrapper, and the whole app is tinted —
 * the nav underline, the level ring, the avatar ring, their message bubbles.
 *
 * Two luminances per colour: the night shell (near-black ground) needs a lifted tone, the paper
 * theme a deeper one, exactly as the existing accents do.
 */

import { ACCENT_COLORS, accentColorOf, type AccentColor } from "@onpitch/shared/profile"

interface AccentTokens {
  /** On the night ground. */
  night: string
  /** On paper. */
  paper: string
  /** For the swatch: a plain CSS colour, for the picker and for canvases. */
  swatch: string
}

export const ACCENT_TOKENS: Record<AccentColor, AccentTokens> = {
  gold: { night: "41 70% 60%", paper: "43 60% 45.1%", swatch: "#e0b352" },
  teal: { night: "183 61% 47%", paper: "185 74% 34.7%", swatch: "#2fb2bc" },
  vermilion: { night: "3 79% 58%", paper: "355 68.3% 48.2%", swatch: "#ea4a3f" },
  azure: { night: "211 63% 57%", paper: "212 68.8% 39%", swatch: "#4d8fd6" },
  violet: { night: "268 62% 68%", paper: "266 50% 50%", swatch: "#a97fe0" },
  lime: { night: "84 58% 56%", paper: "88 55% 38%", swatch: "#96d04f" },
  coral: { night: "16 86% 64%", paper: "14 75% 50%", swatch: "#f2845c" },
  ice: { night: "196 82% 72%", paper: "198 70% 42%", swatch: "#7fd3f2" },
}

/** The inline style that tints a subtree. Spread onto the shell wrapper. */
export function accentStyle(color: string | null | undefined, scope: "night" | "paper" = "night"): React.CSSProperties {
  const token = ACCENT_TOKENS[accentColorOf(color)][scope]
  return { "--accent-user": token } as React.CSSProperties
}

export function accentSwatch(color: string | null | undefined): string {
  return ACCENT_TOKENS[accentColorOf(color)].swatch
}

/** For the picker. */
export const ACCENT_CHOICES = ACCENT_COLORS.map((name) => ({ name, swatch: ACCENT_TOKENS[name].swatch }))
