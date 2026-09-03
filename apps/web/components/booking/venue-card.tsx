/**
 * components/booking/venue-card.tsx
 *
 * A venue in a results list: name, where it is, what it sells, what it starts at.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PHOTO IS ORIGIN-CHECKED BEFORE IT IS RENDERED
 * ---------------------------------------------------------------------------
 * `venues.photos` is a `text[]` an owner writes. `next/image` will only load an origin listed in
 * `images.remotePatterns` (next.config.mjs allows the project's Supabase Storage host and nothing
 * else) and it does not fail softly — an unlisted host throws during render and takes the whole
 * results page down with it. So the URL is checked against the same rule the config encodes, and
 * anything else falls back to the monogram tile. A missing photo is a cosmetic problem; a search
 * page that 500s because one owner pasted an imgur link is not.
 */

import Image from "next/image"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PITCH_FORMAT_LABELS } from "@/components/booking/pitch-card"
import { cn } from "@/lib/utils"
import type { Enums } from "@onpitch/shared/database"
import { formatMinor } from "@onpitch/shared/domain"

/** Mirrors `images.remotePatterns` in next.config.mjs. Keep the two in step. */
function isRenderableImage(rawUrl: string | null | undefined): rawUrl is string {
  if (!rawUrl) return false
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (!url.pathname.startsWith("/storage/v1/object/public/")) return false

  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (configured) {
    try {
      if (url.hostname === new URL(configured).hostname) return true
    } catch {
      // A malformed env var is not this component's problem; fall through to the suffix rule.
    }
  }
  return url.hostname.endsWith(".supabase.in")
}

export interface VenueCardVenue {
  id: string
  name: string
  slug: string
  city: string | null
  district: string | null
  amenities: string[]
  photoUrl: string | null
  /** Cheapest hourly rate among the venue's matching pitches, in minor units. */
  fromPriceMinor: number | null
  currency: string
  pitchCount: number
  /** Distinct formats on offer, for the "what can I play here" line. */
  formats: Enums<"match_format">[]
  /** Free slots on the day the customer searched for, when they searched for one. */
  availableSlots?: number | null
}

export interface VenueCardProps {
  venue: VenueCardVenue
  className?: string
}

export function VenueCard({ venue, className }: VenueCardProps) {
  const location = [venue.district, venue.city].filter(Boolean).join(", ")
  const href = `/venues/${encodeURIComponent(venue.slug)}`
  const monogram = venue.name.trim().slice(0, 2).toUpperCase()

  return (
    // `relative` anchors the title link's stretched hit area (`after:inset-0`) to the card.
    <Card className={cn("relative flex h-full flex-col overflow-hidden", className)}>
      <div className="relative aspect-[16/9] w-full bg-muted">
        {isRenderableImage(venue.photoUrl) ? (
          <Image
            src={venue.photoUrl}
            alt=""
            fill
            sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 100vw"
            className="object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center bg-gradient-to-br from-muted to-accent text-2xl font-semibold tracking-tight text-muted-foreground"
          >
            {monogram}
          </div>
        )}
      </div>

      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          <Link
            href={href}
            className="rounded-sm after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {venue.name}
          </Link>
        </CardTitle>
        <CardDescription>{location || "Location not published"}</CardDescription>
      </CardHeader>

      <CardContent className="mt-auto space-y-3">
        {venue.formats.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Mevcut formatlar">
            {venue.formats.slice(0, 4).map((format) => (
              <li key={format}>
                <Badge variant="secondary">{PITCH_FORMAT_LABELS[format]}</Badge>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-end justify-between gap-3 text-sm">
          <p className="text-muted-foreground">
            {venue.pitchCount} pitch{venue.pitchCount === 1 ? "" : "es"}
            {typeof venue.availableSlots === "number" && venue.availableSlots > 0 && (
              <span className="block text-xs">{venue.availableSlots} slots free that day</span>
            )}
          </p>
          {venue.fromPriceMinor !== null && (
            <p className="text-right tabular-nums">
              <span className="block text-xs text-muted-foreground">başlangıç</span>
              <span className="font-semibold">{formatMinor(venue.fromPriceMinor, venue.currency)}</span>
              <span className="text-xs text-muted-foreground"> / hour</span>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
