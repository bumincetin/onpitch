import { PitchBanner } from "@/components/three/pitch-banner"
import { cn } from "@/lib/utils"
import type { BannerShot } from "@/components/three/scene"

/**
 * The band at the top of every page.
 *
 * It is the landing page's opening shot, held as a strip: a live floodlit pitch behind the
 * headline, framed per page by `shot`. That is the product's ground rather than a flourish on one
 * route — the whole app is meant to feel like standing at a pitch at night, and a header that was
 * the same flat panel everywhere would undo that on the second screen.
 *
 * The 3D is progressive. `PitchBanner` paints the CSS floodlight gradient first and fades the
 * canvas in over it, so a machine with no WebGL gets the same composition without the motion, and
 * the loop stops as soon as the band scrolls out of view.
 *
 * ONE CANVAS PER PAGE. WebGL contexts are a scarce browser resource; a page that mounted three of
 * these would start losing them. A second band on the same page passes `live={false}` and renders
 * the gradient alone.
 *
 * Structure mirrors the landing page's chapter heads: an eyebrow, a light headline, an optional
 * measure column on the right, and a hairline under the lot.
 */

export interface NightBandProps {
  eyebrow: string
  title: React.ReactNode
  lede?: React.ReactNode
  /** Rendered on the trailing edge on wide screens, under the text on a phone. */
  aside?: React.ReactNode
  children?: React.ReactNode
  /** Which composed shot sits behind this page. See `BANNER_SHOTS` in `three/scene.ts`. */
  shot?: BannerShot
  /** The one band per page that owns the WebGL context. Others render the gradient only. */
  live?: boolean
  className?: string
}

export function NightBand({
  eyebrow,
  title,
  lede,
  aside,
  children,
  shot = "stands",
  live = true,
  className,
}: NightBandProps) {
  return (
    <section
      className={cn(
        "night-fallback relative -mx-4 overflow-hidden border-b border-foreground/15 px-4 sm:-mx-6 sm:px-6",
        className,
      )}
    >
      {live ? <PitchBanner shot={shot} /> : null}
      <div className="paper-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden="true" />

      <div className="relative py-10 lg:py-14">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="label-eyebrow">{eyebrow}</p>
            <h1 className="mt-4 text-balance text-3xl font-light leading-[1.1] tracking-tight sm:text-4xl">
              {title}
            </h1>
            {lede ? (
              <p className="mt-4 max-w-xl text-pretty leading-relaxed text-muted-foreground">
                {lede}
              </p>
            ) : null}
          </div>

          {aside ? <div className="shrink-0">{aside}</div> : null}
        </div>

        {children ? <div className="mt-10">{children}</div> : null}
      </div>
    </section>
  )
}

/**
 * A section head inside a dashboard: number, title, and a hairline that runs to the edge.
 *
 * The numbering is the landing page's spine carried inward, so a dashboard reads as chapters
 * of one document rather than as a pile of cards.
 */
export function SectionHead({
  n,
  title,
  aside,
  className,
}: {
  n: string
  title: string
  aside?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-baseline gap-4", className)}>
      <span className="section-number">{n}</span>
      <h2 className="text-lg font-normal tracking-tight">{title}</h2>
      <span aria-hidden="true" className="h-px flex-1 bg-foreground/15" />
      {aside}
    </div>
  )
}

/**
 * A measure: label above, value below, hairline on top.
 *
 * Used everywhere a dashboard states a number. Kept here rather than in a `MetricCard` because
 * a card would put a box around something that only needs a rule.
 */
export function Measure({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: "default" | "gold" | "teal" | "vermilion"
  className?: string
}) {
  return (
    <div className={cn("border-t border-foreground/15 pt-3", className)}>
      <p className="label-eyebrow">{label}</p>
      <p
        className={cn(
          "nums mt-1.5 text-2xl font-light leading-none",
          tone === "gold" && "text-gold",
          tone === "teal" && "text-teal",
          tone === "vermilion" && "text-vermilion",
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
