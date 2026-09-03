/**
 * components/profile/profile-card.tsx
 *
 * A person's card: the composed pitch shot they chose as the ground, their accent as the light,
 * their photo, their name, their number.
 *
 * It is the same component on the profile page (full width, live WebGL behind it), in the
 * account editor (as the preview that updates while they pick), and — small — anywhere a person
 * is introduced. The ground is the `night-fallback` gradient plus a tint of their accent, so the
 * card is theirs even before, or without, the canvas.
 *
 * Server component. The live pitch is layered in by the caller with `PitchBanner` when the page
 * has a WebGL budget left; the card itself never mounts one.
 */

import { Avatar } from "@/components/ui/avatar"
import { accentStyle } from "@/lib/profile/accent"
import { cn } from "@/lib/utils"
import {
  BANNER_SHOT_LABEL,
  DOMINANT_FOOT_LABEL,
  accentColorOf,
  bannerShotOf,
  type ProfileStyle,
} from "@onpitch/shared/profile"

export interface ProfileCardProps {
  name: string
  avatarUrl?: string | null
  style: ProfileStyle
  city?: string | null
  position?: string | null
  role?: "player" | "venue_owner" | "admin" | string | null
  /** Rendered over the ground on the trailing edge. */
  children?: React.ReactNode
  /** Something behind the veil — a `PitchBanner`. */
  scene?: React.ReactNode
  size?: "preview" | "hero"
  className?: string
}

export function ProfileCard({
  name,
  avatarUrl,
  style,
  city,
  position,
  role,
  children,
  scene,
  size = "hero",
  className,
}: ProfileCardProps) {
  const accent = accentColorOf(style.accentColor)
  const shot = bannerShotOf(style.bannerShot)
  const hero = size === "hero"

  return (
    <section
      className={cn("night-fallback relative overflow-hidden rounded-md border border-foreground/12", className)}
      style={accentStyle(accent)}
      aria-label={`${name} profil kartı`}
    >
      {scene}
      {/* The accent as light: a pool from the top-left, the way a floodlight sits on paper. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(38rem 20rem at 12% 0%, hsl(var(--accent-user) / 0.28), transparent 62%), linear-gradient(to right, rgba(5,7,12,0.88) 0%, rgba(5,7,12,0.55) 55%, rgba(5,7,12,0.15) 100%)",
        }}
      />
      <div className="paper-grid pointer-events-none absolute inset-0 opacity-30" aria-hidden="true" />

      <div className={cn("relative flex items-end gap-4", hero ? "p-6 sm:p-8" : "p-4")}>
        <Avatar name={name} src={avatarUrl} accent={accent} size={hero ? "hero" : "xl"} />

        <div className="min-w-0 flex-1">
          <p className="label-eyebrow text-user">
            {role === "venue_owner" ? "İşletme" : "Oyuncu"}
            {city ? ` · ${city}` : ""}
            {hero ? ` · ${BANNER_SHOT_LABEL[shot].title}` : ""}
          </p>
          <h2
            className={cn(
              "mt-2 truncate font-light tracking-tight",
              hero ? "text-3xl sm:text-4xl" : "text-2xl",
            )}
          >
            {name}
          </h2>
          {style.tagline ? (
            <p className={cn("mt-1.5 text-pretty text-muted-foreground", hero ? "text-base" : "text-sm")}>
              {style.tagline}
            </p>
          ) : null}
          <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            {position ? <span>{position}</span> : null}
            {style.dominantFoot ? <span>{DOMINANT_FOOT_LABEL[style.dominantFoot]} ayak</span> : null}
          </p>
        </div>

        {style.jerseyNumber !== null ? (
          <span
            aria-label={`Forma numarası ${style.jerseyNumber}`}
            className={cn(
              "nums shrink-0 self-start font-mono font-light leading-none text-user",
              hero ? "text-7xl sm:text-8xl" : "text-5xl",
            )}
            style={{ textShadow: "0 0 32px hsl(var(--accent-user) / 0.45)" }}
          >
            {style.jerseyNumber}
          </span>
        ) : null}
      </div>

      {children ? <div className={cn("relative border-t border-foreground/10", hero ? "px-6 py-4 sm:px-8" : "px-4 py-3")}>{children}</div> : null}
    </section>
  )
}
