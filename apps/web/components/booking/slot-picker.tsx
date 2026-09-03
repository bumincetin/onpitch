"use client"

/**
 * components/booking/slot-picker.tsx
 *
 * Pick a day, pick a time, reserve it.
 *
 * ===========================================================================
 * 1. THE GRID IS A FORECAST, NOT A RESERVATION
 * ===========================================================================
 * `GET /api/pitches/[id]/slots` answers with free/busy as of the instant it ran. Between that
 * read and the customer's click, someone else can take the slot — and the thing that decides who
 * gets it is the `bookings_no_double_booking` exclusion constraint inside the checkout INSERT,
 * never this component. So `SLOT_TAKEN` is treated as a normal outcome: say so plainly, refetch,
 * and let the customer pick again. It is not an error state and it is not retried silently.
 *
 * ===========================================================================
 * 2. TIMES ARE THE VENUE'S, NOT THE BROWSER'S
 * ===========================================================================
 * Every label is formatted with `timeZone: venue.timezone`. A player in Berlin looking at an
 * Istanbul pitch must read 21:00 and turn up at 21:00 local-to-the-pitch. The instants
 * themselves stay absolute (`startsAt` / `endsAt` are ISO strings straight from the server) and
 * are posted back untouched, so nothing in the browser's zone can move a booking.
 *
 * ===========================================================================
 * 3. KEYBOARD AND SCREEN READER
 * ===========================================================================
 * The slot buttons are a roving-tabindex group: one tab stop, arrows to move, Enter/Space to
 * choose. Taken slots are `aria-disabled` rather than `disabled`, so they stay reachable and
 * announce WHY they are gone instead of vanishing from the keyboard order — "already booked" is
 * information a customer wants, and a disabled button cannot deliver it.
 *
 * Arrow keys walk the list linearly (Left/Up back, Right/Down forward). The visual grid reflows
 * between one and six columns with the viewport, so "up" cannot mean "one row up" at any width
 * without lying at most of them.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { API_ERROR_CODES, formatMinor } from "@onpitch/shared/domain"

/* ========================================================================== */
/*  Wire parsing — the API is a trust boundary like any other                 */
/* ========================================================================== */

const slotSchema = z.object({
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  available: z.boolean(),
  priceMinor: z.number().int().nonnegative(),
  reason: z.enum(["booked", "blocked", "closed", "past", "venue_not_payable"]).optional(),
})

const slotsPayloadSchema = z.object({
  venue: z.object({ timezone: z.string().min(1), isPayable: z.boolean() }),
  grid: z.object({
    slotMinutes: z.number().int().positive(),
    currency: z.string().min(3).max(3),
    days: z.array(z.object({ date: z.string(), slots: z.array(slotSchema) })),
  }),
  generatedAt: z.string(),
})

const apiErrorSchema = z.object({ code: z.string(), message: z.string() })

const checkoutResultSchema = z.object({ bookingId: z.string().uuid() })

type Slot = z.infer<typeof slotSchema>

/** Copy for every `SlotUnavailableReason` the API can return. */
const REASON_LABEL: Readonly<Record<NonNullable<Slot["reason"]>, string>> = {
  booked: "Booked",
  blocked: "Held by the venue",
  closed: "Closed",
  past: "Gone",
  venue_not_payable: "Not on sale",
}

const REASON_DETAIL: Readonly<Record<NonNullable<Slot["reason"]>, string>> = {
  booked: "Someone else has this slot.",
  blocked: "The venue has taken this time off sale.",
  closed: "The pitch is not open then.",
  past: "That time has already passed.",
  venue_not_payable: "This venue cannot take payments yet.",
}

/* ========================================================================== */
/*  Props                                                                     */
/* ========================================================================== */

export interface SlotPickerTeam {
  id: string
  name: string
}

export interface SlotPickerProps {
  pitchId: string
  pitchName: string
  /** IANA zone of the venue. Every label on this component is rendered in it. */
  timezone: string
  /** Local calendar days to offer, `YYYY-MM-DD`, resolved server-side from the venue's today. */
  dates: readonly string[]
  /** Which of `dates` opens first. */
  initialDate: string
  /** Teams the signed-in user may book on behalf of. Empty means personal bookings only. */
  teams?: readonly SlotPickerTeam[]
  /** Longest run of consecutive slots the picker will offer. */
  maxSlots?: number
}

const PERSONAL = "personal"

/* ========================================================================== */

export function SlotPicker({
  pitchId,
  pitchName,
  timezone,
  dates,
  initialDate,
  teams = [],
  maxSlots = 4,
}: SlotPickerProps) {
  const router = useRouter()
  const baseId = useId()

  const [date, setDate] = useState(() => (dates.includes(initialDate) ? initialDate : (dates[0] ?? initialDate)))
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [currency, setCurrency] = useState("try")
  const [slotMinutes, setSlotMinutes] = useState(60)
  const [venuePayable, setVenuePayable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedStart, setSelectedStart] = useState<string | null>(null)
  const [runLength, setRunLength] = useState(1)
  const [teamId, setTeamId] = useState<string>(PERSONAL)
  const [reserving, setReserving] = useState(false)
  const [reserveError, setReserveError] = useState<{ code: string; message: string } | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)

  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())
  /** Bumped to force a refetch of the same date after a lost race. */
  const [reloadToken, setReloadToken] = useState(0)

  // The fetch effect deliberately does not depend on the selection, so it reads the current one
  // through a ref instead of closing over a stale value.
  const selectedStartRef = useRef<string | null>(null)
  useEffect(() => {
    selectedStartRef.current = selectedStart
  }, [selectedStart])

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    setLoading(true)
    setLoadError(null)

    void (async () => {
      try {
        const response = await fetch(
          `/api/pitches/${encodeURIComponent(pitchId)}/slots?date=${encodeURIComponent(date)}&days=1`,
          { credentials: "same-origin", signal: controller.signal, headers: { Accept: "application/json" } },
        )
        const body: unknown = await response.json()
        if (cancelled) return

        if (!isEnvelopeOk(body)) {
          const parsedError = apiErrorSchema.safeParse((body as { error?: unknown }).error)
          setSlots(null)
          setLoadError(
            parsedError.success
              ? parsedError.data.message
              : "Bu sahanın takvimini okuyamadık. Birazdan tekrar dene.",
          )
          return
        }

        const parsed = slotsPayloadSchema.safeParse(body.data)
        if (!parsed.success) {
          setSlots(null)
          setLoadError("The calendar came back in a shape we did not expect. Try refreshing.")
          return
        }

        const day = parsed.data.grid.days.find((candidate) => candidate.date === date)
        const fresh = day?.slots ?? []
        setSlots(fresh)
        setCurrency(parsed.data.grid.currency)
        setSlotMinutes(parsed.data.grid.slotMinutes)
        setVenuePayable(parsed.data.venue.isPayable)

        // A refresh can land on a slot the customer had already chosen. Dropping it silently
        // would leave a summary they cannot act on, so say what happened.
        const held = selectedStartRef.current
        if (held && !fresh.some((slot) => slot.startsAt === held && slot.available)) {
          setSelectedStart(null)
          setRunLength(1)
          toast({
            variant: "warning",
            title: "Seçtiğin saat gitti",
            description: "Bu sayfa açıkken başkası aldı. Başka bir saat seç.",
          })
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return
        setSlots(null)
        setLoadError("We could not reach the server. Check your connection and try again.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [pitchId, date, reloadToken])

  // Coming back to a tab that has been open for a while is exactly when the grid is most likely
  // to be stale, and a stale grid sends people into a checkout that answers SLOT_TAKEN.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") setReloadToken((token) => token + 1)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  /* ------------------------------------------------------------ selection */

  const selectedIndex = useMemo(
    () => (slots && selectedStart ? slots.findIndex((slot) => slot.startsAt === selectedStart) : -1),
    [slots, selectedStart],
  )

  /** How many consecutive free slots start at the selection, capped at `maxSlots`. */
  const maxRun = useMemo(() => {
    if (!slots || selectedIndex < 0) return 0
    let run = 0
    let expectedStart: number | null = null
    for (let cursor = selectedIndex; cursor < slots.length && run < maxSlots; cursor += 1) {
      const slot = slots[cursor]
      if (!slot || !slot.available) break
      const startMs = Date.parse(slot.startsAt)
      if (expectedStart !== null && startMs !== expectedStart) break
      expectedStart = Date.parse(slot.endsAt)
      run += 1
    }
    return run
  }, [slots, selectedIndex, maxSlots])

  useEffect(() => {
    if (runLength > maxRun) setRunLength(Math.max(1, maxRun))
  }, [maxRun, runLength])

  const selection = useMemo(() => {
    if (!slots || selectedIndex < 0) return null
    const first = slots[selectedIndex]
    const last = slots[selectedIndex + runLength - 1]
    if (!first || !last) return null
    return {
      startsAt: first.startsAt,
      endsAt: last.endsAt,
      totalMinor: first.priceMinor * runLength,
      minutes: slotMinutes * runLength,
    }
  }, [slots, selectedIndex, runLength, slotMinutes])

  /* ------------------------------------------------------------ formatting */

  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat("tr-TR", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [timezone],
  )

  const longFormatter = useMemo(
    () => new Intl.DateTimeFormat("tr-TR", { timeZone: timezone, dateStyle: "full", timeStyle: "short" }),
    [timezone],
  )

  /* ------------------------------------------------------------ reserving */

  const reserve = useCallback(async (): Promise<void> => {
    if (!selection) return
    setReserving(true)
    setReserveError(null)

    try {
      const response = await fetch("/api/bookings/checkout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          pitchId,
          startsAt: selection.startsAt,
          endsAt: selection.endsAt,
          ...(teamId !== PERSONAL ? { teamId } : {}),
        }),
      })

      const body: unknown = await response.json()

      if (!isEnvelopeOk(body)) {
        const parsedError = apiErrorSchema.safeParse((body as { error?: unknown }).error)
        const failure = parsedError.success
          ? parsedError.data
          : { code: API_ERROR_CODES.INTERNAL, message: "Bir şeyler ters gitti. Tekrar dene." }

        setReserveError(failure)

        if (failure.code === API_ERROR_CODES.SLOT_TAKEN) {
          // Someone won the race. Drop the selection and pull a fresh grid rather than leaving a
          // dead choice on screen.
          setSelectedStart(null)
          setRunLength(1)
          setReloadToken((token) => token + 1)
          toast({
            variant: "warning",
            title: "O saat az önce gitti",
            description: "Takvim yenilendi. Başka bir saat seç.",
          })
        }
        return
      }

      const parsed = checkoutResultSchema.safeParse(body.data)
      if (!parsed.success) {
        setReserveError({
          code: API_ERROR_CODES.INTERNAL,
          message: "Rezervasyon oluştu ama geri okuyamadık. Rezervasyonlarım sayfasını kontrol et.",
        })
        return
      }

      router.push(`/checkout/${parsed.data.bookingId}`)
    } catch {
      setReserveError({
        code: API_ERROR_CODES.INTERNAL,
        message: "Sunucuya ulaşamadık. Kartından çekim yapılmadı.",
      })
    } finally {
      setReserving(false)
    }
  }, [pitchId, router, selection, teamId])

  /* ------------------------------------------------------------ keyboard */

  const moveFocus = useCallback(
    (nextIndex: number): void => {
      if (!slots || slots.length === 0) return
      const clamped = Math.min(Math.max(nextIndex, 0), slots.length - 1)
      const target = slots[clamped]
      if (!target) return
      setFocusIndex(clamped)
      buttonRefs.current.get(target.startsAt)?.focus()
    },
    [slots],
  )

  const onSlotKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault()
          moveFocus(index + 1)
          break
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault()
          moveFocus(index - 1)
          break
        case "Home":
          event.preventDefault()
          moveFocus(0)
          break
        case "End":
          event.preventDefault()
          moveFocus((slots?.length ?? 1) - 1)
          break
        default:
          break
      }
    },
    [moveFocus, slots],
  )

  /* ------------------------------------------------------------ rendering */

  const dayTabsId = `${baseId}-days`
  const gridId = `${baseId}-slots`
  const freeCount = slots?.filter((slot) => slot.available).length ?? 0
  // A refetch can shorten the list. Clamping at render keeps exactly one button in the tab order
  // instead of stranding the roving tabindex past the end of the grid.
  const rovingIndex = slots && slots.length > 0 ? Math.min(focusIndex, slots.length - 1) : 0

  return (
    <section aria-labelledby={`${baseId}-heading`} className="space-y-4">
      <h2 id={`${baseId}-heading`} className="text-lg font-semibold tracking-tight">
        Saat seç
      </h2>

      {/* ---- day strip ---- */}
      <div
        id={dayTabsId}
        role="group"
        aria-label="Gün"
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {dates.map((key) => {
          const active = key === date
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setDate(key)
                setSelectedStart(null)
                setRunLength(1)
                setReserveError(null)
                setFocusIndex(0)
              }}
              className={cn(
                "flex min-w-[4.5rem] shrink-0 flex-col items-center rounded-md border px-3 py-2 text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <span className="text-xs uppercase tracking-wide">{weekdayLabel(key)}</span>
              <span className="font-semibold">{dayLabel(key)}</span>
            </button>
          )
        })}
      </div>

      {/* ---- states ---- */}
      {loading && (
        <p className="sr-only" role="status">
          Loading times for {dayLabel(date)}.
        </p>
      )}

      {loading && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <Skeleton key={index} className="h-14 rounded-md" />
          ))}
        </div>
      )}

      {!loading && loadError && (
        <Alert variant="destructive">
          <AlertTitle>Takvim yüklenemedi</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => setReloadToken((token) => token + 1)}>
              Tekrar dene
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {!loading && !loadError && slots && slots.length === 0 && (
        <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {pitchName} is not open on this day.
        </p>
      )}

      {!loading && !loadError && slots && slots.length > 0 && (
        <>
          <p className="sr-only" aria-live="polite">
            {freeCount} of {slots.length} slots free on {dayLabel(date)}.
          </p>

          <div
            id={gridId}
            role="group"
            aria-label={`Slots for ${pitchName} on ${dayLabel(date)}`}
            className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6"
          >
            {slots.map((slot, index) => {
              const selected = slot.startsAt === selectedStart
              const inRun =
                selectedIndex >= 0 && index > selectedIndex && index < selectedIndex + runLength
              const reason = slot.reason
              const label = timeFormatter.format(new Date(slot.startsAt))

              return (
                <button
                  key={slot.startsAt}
                  ref={(node) => {
                    if (node) buttonRefs.current.set(slot.startsAt, node)
                    else buttonRefs.current.delete(slot.startsAt)
                  }}
                  type="button"
                  aria-pressed={selected || inRun}
                  aria-disabled={!slot.available}
                  tabIndex={index === rovingIndex ? 0 : -1}
                  onFocus={() => setFocusIndex(index)}
                  onKeyDown={(event) => onSlotKeyDown(event, index)}
                  onClick={() => {
                    if (!slot.available) return
                    setSelectedStart(slot.startsAt)
                    setRunLength(1)
                    setReserveError(null)
                  }}
                  className={cn(
                    "flex flex-col items-center rounded-md border px-2 py-2 text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    slot.available
                      ? "hover:bg-accent hover:text-accent-foreground"
                      : "cursor-not-allowed border-dashed bg-muted/40 text-muted-foreground",
                    (selected || inRun) && "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
                  )}
                >
                  <span className="font-semibold tabular-nums">{label}</span>
                  <span className="text-xs">
                    {slot.available ? formatMinor(slot.priceMinor, currency) : REASON_LABEL[reason ?? "booked"]}
                  </span>
                  {!slot.available && (
                    <span className="sr-only">{REASON_DETAIL[reason ?? "booked"]}</span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* ---- summary + reserve ---- */}
      {!venuePayable && !loading && (
        <Alert role="status">
          <AlertTitle>Henüz rezervasyon almıyor</AlertTitle>
          <AlertDescription>
            Bu işletme hakediş kurulumunu tamamlamamış; burada rezervasyon yapılamıyor. Şimdilik başka bir işletmeyi dene.
          </AlertDescription>
        </Alert>
      )}

      {selection && (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div>
            <p className="text-sm text-muted-foreground">Rezerve ettiğin</p>
            <p className="font-medium">{longFormatter.format(new Date(selection.startsAt))}</p>
            <p className="text-sm text-muted-foreground">
              {timeFormatter.format(new Date(selection.startsAt))} –{" "}
              {timeFormatter.format(new Date(selection.endsAt))} · {selection.minutes} minutes
            </p>
          </div>

          {maxRun > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor={`${baseId}-length`}>Ne kadar</Label>
              <div
                id={`${baseId}-length`}
                role="group"
                aria-label="Rezervasyon süresi"
                className="flex flex-wrap gap-2"
              >
                {Array.from({ length: maxRun }, (_, index) => index + 1).map((count) => (
                  <Button
                    key={count}
                    type="button"
                    size="sm"
                    variant={count === runLength ? "default" : "outline"}
                    aria-pressed={count === runLength}
                    onClick={() => setRunLength(count)}
                  >
                    {formatDuration(count * slotMinutes)}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {teams.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor={`${baseId}-team`}>Kimin için</Label>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger id={`${baseId}-team`}>
                  <SelectValue placeholder="Kendim" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PERSONAL}>Kendim</SelectItem>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p className="text-sm">
              <span className="text-muted-foreground">Toplam </span>
              <span className="text-lg font-semibold tabular-nums">
                {formatMinor(selection.totalMinor, currency)}
              </span>
            </p>
            <Button onClick={() => void reserve()} disabled={reserving || !venuePayable}>
              {reserving ? "Holding the slot…" : "Reserve and pay"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Ödeme yaparken saat sana ayrılır, ödeme tamamlanmazsa serbest bırakılır. Bir sonraki ekranda onaylayana kadar kartından çekim yapılmaz.
          </p>
        </div>
      )}

      {reserveError && <ReserveError code={reserveError.code} message={reserveError.message} />}
    </section>
  )
}

/* ========================================================================== */
/*  Error rendering                                                           */
/* ========================================================================== */

function ReserveError({ code, message }: { code: string; message: string }) {
  if (code === API_ERROR_CODES.CONSENT_REQUIRED) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Önce bir velinin bu hesabı onaylaması gerekiyor</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{message}</p>
          <a className="underline underline-offset-4" href="/parental-consent">
            Onay isteğini gönder
          </a>
        </AlertDescription>
      </Alert>
    )
  }

  if (code === API_ERROR_CODES.UNAUTHENTICATED) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Oturumun sona erdi</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>Tekrar giriş yap; saat hâlâ burada olacak — ya da biri daha hızlı davrandıysa gitmiş olacak.</p>
          <a className="underline underline-offset-4" href="/login">
            Giriş yap
          </a>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant={code === API_ERROR_CODES.SLOT_TAKEN ? "default" : "destructive"}>
      <AlertTitle>
        {code === API_ERROR_CODES.SLOT_TAKEN ? "That slot has gone" : "Could not hold that slot"}
      </AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/* ========================================================================== */
/*  Small helpers                                                             */
/* ========================================================================== */

/** Narrow the `ApiResponse` envelope without trusting anything inside `data`. */
function isEnvelopeOk(body: unknown): body is { ok: true; data: unknown } {
  return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true
}

/**
 * Labels for a `YYYY-MM-DD` key.
 *
 * The key is a CIVIL date with no instant attached, so it is materialised at UTC midnight and
 * formatted in UTC. Formatting it in the venue's zone would shift the label by a day for every
 * zone west of Greenwich.
 */
function dateKeyToUtc(key: string): Date {
  return new Date(`${key}T00:00:00Z`)
}

function weekdayLabel(key: string): string {
  return new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", weekday: "short" }).format(dateKeyToUtc(key))
}

function dayLabel(key: string): string {
  return new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", day: "numeric", month: "short" }).format(
    dateKeyToUtc(key),
  )
}

function formatDuration(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return hours === 1 ? "1 hour" : `${hours} hours`
  }
  if (minutes > 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes} min`
}
