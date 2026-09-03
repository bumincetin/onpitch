/**
 * components/ui/avatar.tsx
 *
 * A person, as a circle: their photo when they have one, their initials when they do not, and
 * their chosen accent as the ring around it.
 *
 * The ring is the point. `profiles.accent_color` is the one thing a person picks that follows
 * them everywhere — the header, a roster, a chat bubble, a leaderboard row — and the avatar is
 * where everyone else sees it. Pass `accent` and the ring is theirs; leave it and the ring is
 * the viewer's own (`--accent-user` on the shell).
 *
 * Server component. No state, no effects; the photo is a plain `<img>` because Supabase Storage
 * URLs are already sized and `next/image` would add a remote-pattern dance for a 40px circle.
 */

import { accentColorOf, initialsOf } from "@onpitch/shared/profile"
import { ACCENT_TOKENS } from "@/lib/profile/accent"
import { cn } from "@/lib/utils"

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "hero"

const SIZE: Record<AvatarSize, { box: string; text: string; ring: string }> = {
  xs: { box: "size-6", text: "text-[10px]", ring: "ring-1" },
  sm: { box: "size-8", text: "text-xs", ring: "ring-2" },
  md: { box: "size-10", text: "text-sm", ring: "ring-2" },
  lg: { box: "size-14", text: "text-base", ring: "ring-2" },
  xl: { box: "size-20", text: "text-xl", ring: "ring-[3px]" },
  hero: { box: "size-28 sm:size-32", text: "text-3xl", ring: "ring-4" },
}

export interface AvatarProps {
  name: string | null | undefined
  src?: string | null
  /** The person's own accent name. Omit to use the viewer's shell accent. */
  accent?: string | null
  size?: AvatarSize
  /** Draw the accent ring. On by default. */
  ring?: boolean
  /** A small live dot on the ring, for presence or unread. */
  dot?: "live" | "unread" | null
  className?: string
}

export function Avatar({ name, src, accent, size = "md", ring = true, dot = null, className }: AvatarProps) {
  const dims = SIZE[size]
  const label = name?.trim() || "Oyuncu"
  const ringStyle = accent
    ? ({ "--tw-ring-color": `hsl(${ACCENT_TOKENS[accentColorOf(accent)].night})` } as React.CSSProperties)
    : undefined

  return (
    <span
      className={cn(
        "relative inline-grid shrink-0 place-items-center overflow-visible rounded-full bg-secondary font-mono font-medium uppercase text-foreground/90",
        dims.box,
        dims.text,
        ring && dims.ring,
        ring && "ring-offset-2 ring-offset-background",
        ring && !accent && "ring-user",
        className,
      )}
      style={ringStyle}
      role="img"
      aria-label={label}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- storage URL, already sized
        <img src={src} alt="" className="size-full rounded-full object-cover" loading="lazy" decoding="async" />
      ) : (
        <span aria-hidden="true">{initialsOf(label)}</span>
      )}
      {dot ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-background",
            dot === "live" ? "bg-teal" : "bg-vermilion",
          )}
        />
      ) : null}
    </span>
  )
}
