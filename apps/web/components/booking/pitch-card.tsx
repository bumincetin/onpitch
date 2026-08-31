/**
 * components/booking/pitch-card.tsx
 *
 * One pitch, as it appears on a venue page and inside a search result.
 *
 * Presentational and server-rendered: it takes already-resolved values and renders them. The
 * hourly rate arrives as an integer count of minor units straight off `pitches.hourly_rate_minor`
 * and is formatted — never divided, never rounded — by `formatMinor()`.
 */

import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { Enums } from "@halisaha/shared/database"
import { formatMinor } from "@halisaha/shared/domain"

/* -------------------------------------------------------------------------- */
/*  Shared vocabulary                                                          */
/* -------------------------------------------------------------------------- */

export const PITCH_FORMAT_LABELS: Readonly<Record<Enums<"match_format">, string>> = {
  five_a_side: "5 kişilik",
  six_a_side: "6 kişilik",
  seven_a_side: "7 kişilik",
  eight_a_side: "8 kişilik",
  eleven_a_side: "11 kişilik",
}

export const PITCH_SURFACE_LABELS: Readonly<Record<Enums<"pitch_surface">, string>> = {
  natural_grass: "Natural grass",
  artificial_turf: "Artificial turf",
  hybrid: "Hybrid",
  indoor_court: "Indoor court",
}

/** `"08:00:00"` → `"08:00"`. The seconds on a `time` column are never interesting here. */
export function shortTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(value)
  if (!match) return value
  const hours = match[1]
  const minutes = match[2]
  if (hours === undefined || minutes === undefined) return value
  return `${hours.padStart(2, "0")}:${minutes}`
}

/** "60-minute slots" / "1h 30m slots" — whichever reads better for the length. */
export function slotLengthLabel(slotMinutes: number): string {
  if (slotMinutes % 60 === 0 && slotMinutes >= 60) {
    const hours = slotMinutes / 60
    return hours === 1 ? "1-hour slots" : `${hours}-hour slots`
  }
  if (slotMinutes > 60) {
    return `${Math.floor(slotMinutes / 60)}h ${slotMinutes % 60}m slots`
  }
  return `${slotMinutes}-minute slots`
}

/* -------------------------------------------------------------------------- */

export interface PitchCardPitch {
  id: string
  name: string
  format: Enums<"match_format">
  surface: Enums<"pitch_surface">
  isIndoor: boolean
  capacity: number | null
  hourlyRateMinor: number
  currency: string
  slotMinutes: number
  openingTime: string
  closingTime: string
  /** Free slots on the day the customer asked about; null when they asked about no day. */
  availableSlots?: number | null
  /** Earliest free slot on that day, as an ISO instant. */
  nextAvailableAt?: string | null
}

export interface PitchCardProps {
  pitch: PitchCardPitch
  /** `venues.slug`, for the link into the slot picker. */
  venueSlug: string
  /** IANA zone of the parent venue — opening hours and `nextAvailableAt` are read in it. */
  timezone: string
  /** Set when the venue cannot take money; the card renders as a non-link with the reason. */
  unavailableReason?: string | null
  className?: string
}

export function PitchCard({
  pitch,
  venueSlug,
  timezone,
  unavailableReason,
  className,
}: PitchCardProps) {
  const href = `/venues/${encodeURIComponent(venueSlug)}/${pitch.id}`
  const bookable = !unavailableReason

  const nextAvailable = pitch.nextAvailableAt
    ? new Intl.DateTimeFormat("tr-TR", {
        timeZone: timezone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(pitch.nextAvailableAt))
    : null

  return (
    <Card className={cn("flex h-full flex-col", className)}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-base">{pitch.name}</CardTitle>
          <p className="text-sm font-semibold tabular-nums">
            {formatMinor(pitch.hourlyRateMinor, pitch.currency)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">/ hour</span>
          </p>
        </div>
        <ul className="flex flex-wrap gap-1.5 pt-1" aria-label={`${pitch.name} details`}>
          <li>
            <Badge variant="secondary">{PITCH_FORMAT_LABELS[pitch.format]}</Badge>
          </li>
          <li>
            <Badge variant="outline">{PITCH_SURFACE_LABELS[pitch.surface]}</Badge>
          </li>
          <li>
            <Badge variant="outline">{pitch.isIndoor ? "Indoor" : "Outdoor"}</Badge>
          </li>
          {pitch.capacity !== null && (
            <li>
              <Badge variant="outline">{pitch.capacity} players</Badge>
            </li>
          )}
        </ul>
      </CardHeader>

      <CardContent className="mt-auto space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
          <dt className="sr-only">Çalışma saatleri</dt>
          <dd>
            {shortTime(pitch.openingTime)} – {shortTime(pitch.closingTime)}
          </dd>
          <dt className="sr-only">Saat dilimi uzunluğu</dt>
          <dd className="text-right">{slotLengthLabel(pitch.slotMinutes)}</dd>
        </dl>

        {typeof pitch.availableSlots === "number" && (
          <p className={cn("text-sm", pitch.availableSlots > 0 ? "text-foreground" : "text-muted-foreground")}>
            {pitch.availableSlots > 0
              ? `${pitch.availableSlots} slot${pitch.availableSlots === 1 ? "" : "s"} free${
                  nextAvailable ? `, from ${nextAvailable}` : ""
                }`
              : "Nothing free that day"}
          </p>
        )}

        {bookable ? (
          <Link
            href={href}
            className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Saatleri gör<span className="sr-only"> for {pitch.name}</span>
          </Link>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            {unavailableReason}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
