"use client"

/**
 * components/booking/venue-search.tsx
 *
 * The filter bar over the venue browse page.
 *
 * It owns no results. Submitting writes the filters into the URL and lets the Server Component
 * re-run the query, which keeps three things true that a client-side result cache would break: a
 * search is linkable and shareable, the back button returns to the previous search, and the rows
 * are read through the caller's own RLS-scoped session rather than assembled in the browser.
 *
 * Initial values arrive as props rather than from `useSearchParams()`, so this component never
 * forces the page out of the render mode the page itself chose.
 *
 * `Select` (Radix) reserves the empty string for "nothing chosen", so "no preference" is carried
 * by an explicit `any` sentinel that is stripped when the query string is built.
 */

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PITCH_FORMAT_LABELS, PITCH_SURFACE_LABELS } from "@/components/booking/pitch-card"
import { Constants } from "@halisaha/shared/database"
import { DEFAULT_CURRENCY, fromMinor, minorUnitExponent, toMinor } from "@halisaha/shared/domain"

const ANY = "any"

export interface VenueSearchValues {
  q: string
  city: string
  format: string
  surface: string
  /** `"any" | "indoor" | "outdoor"`. */
  indoor: string
  /** Major units, as typed. Empty means no ceiling. */
  maxPrice: string
  /** `YYYY-MM-DD`, or empty. */
  date: string
  /** `HH:MM`, or empty. */
  from: string
  to: string
}

export interface VenueSearchProps {
  initial: VenueSearchValues
  /** Currency the price ceiling is entered in. Venue currencies are per-pitch; this is the default. */
  currency?: string
  /** Number of venues the current filters returned, for the live region. */
  resultCount?: number
}

/**
 * Nothing selected.
 *
 * Deliberately not exported to the page that renders this form: every export of a `'use client'`
 * module is a client reference, so a Server Component importing it would get a proxy rather than
 * the value. The page parses its own `searchParams` and passes plain strings in.
 */
const EMPTY_SEARCH_VALUES: VenueSearchValues = {
  q: "",
  city: "",
  format: ANY,
  surface: ANY,
  indoor: ANY,
  maxPrice: "",
  date: "",
  from: "",
  to: "",
}

/**
 * Turn form state into a query string.
 *
 * The price ceiling is entered in major units and travels in MINOR units, because that is what
 * `pitches.hourly_rate_minor` stores and what the API compares against. `toMinor()` does the
 * conversion once, here, rather than letting a float cross the wire.
 *
 * Module-private for the same reason as `EMPTY_SEARCH_VALUES` above.
 */
function toQueryString(values: VenueSearchValues, currency: string): string {
  const params = new URLSearchParams()
  const put = (key: string, value: string): void => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== ANY) params.set(key, trimmed)
  }

  put("q", values.q)
  put("city", values.city)
  put("format", values.format)
  put("surface", values.surface)
  if (values.indoor === "indoor") params.set("indoor", "true")
  if (values.indoor === "outdoor") params.set("indoor", "false")

  const ceiling = Number(values.maxPrice)
  if (values.maxPrice.trim() && Number.isFinite(ceiling) && ceiling > 0) {
    params.set("maxPriceMinor", String(toMinor(ceiling, currency)))
  }

  put("date", values.date)
  // A time window is meaningless without a day, and silently applying one is worse than ignoring
  // it: the customer would see a filtered list and no explanation of what filtered it.
  if (values.date.trim()) {
    put("from", values.from)
    put("to", values.to)
  }

  return params.toString()
}

export function VenueSearch({
  initial,
  currency = DEFAULT_CURRENCY,
  resultCount,
}: VenueSearchProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [values, setValues] = useState<VenueSearchValues>(initial)
  const ids = useFieldIds()

  const set = <K extends keyof VenueSearchValues>(key: K, value: VenueSearchValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const submit = (next: VenueSearchValues): void => {
    const query = toQueryString(next, currency)
    startTransition(() => {
      router.push(query ? `/venues?${query}` : "/venues")
    })
  }

  const symbol = currency.toUpperCase()
  const step = minorUnitExponent(currency) === 0 ? "1" : String(fromMinor(1, currency))

  return (
    <form
      className="grid gap-4 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit(values)
      }}
      aria-busy={pending}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={ids.q}>Ara</Label>
          <Input
            id={ids.q}
            name="q"
            type="search"
            placeholder="İşletme adı ya da semt"
            value={values.q}
            maxLength={80}
            onChange={(event) => set("q", event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.city}>Şehir</Label>
          <Input
            id={ids.city}
            name="city"
            value={values.city}
            maxLength={80}
            autoComplete="address-level2"
            onChange={(event) => set("city", event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.maxPrice}>Max per hour ({symbol})</Label>
          <Input
            id={ids.maxPrice}
            name="maxPrice"
            type="number"
            inputMode="decimal"
            min="0"
            step={step}
            value={values.maxPrice}
            onChange={(event) => set("maxPrice", event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={ids.format}>Format</Label>
          <Select value={values.format} onValueChange={(value) => set("format", value)}>
            <SelectTrigger id={ids.format}>
              <SelectValue placeholder="Bütün formatlar" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Bütün formatlar</SelectItem>
              {Constants.public.Enums.match_format.map((value) => (
                <SelectItem key={value} value={value}>
                  {PITCH_FORMAT_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.surface}>Zemin</Label>
          <Select value={values.surface} onValueChange={(value) => set("surface", value)}>
            <SelectTrigger id={ids.surface}>
              <SelectValue placeholder="Bütün zeminler" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Bütün zeminler</SelectItem>
              {Constants.public.Enums.pitch_surface.map((value) => (
                <SelectItem key={value} value={value}>
                  {PITCH_SURFACE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.indoor}>Kapalı ya da açık</Label>
          <Select value={values.indoor} onValueChange={(value) => set("indoor", value)}>
            <SelectTrigger id={ids.indoor}>
              <SelectValue placeholder="Fark etmez" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Fark etmez</SelectItem>
              <SelectItem value="indoor">Kapalı</SelectItem>
              <SelectItem value="outdoor">Açık</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="pb-1 text-sm font-medium">Ne zaman</legend>
        <div className="space-y-1.5">
          <Label htmlFor={ids.date}>Tarih</Label>
          <Input
            id={ids.date}
            name="date"
            type="date"
            value={values.date}
            onChange={(event) => set("date", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.from}>Başlangıç</Label>
          <Input
            id={ids.from}
            name="başlangıç"
            type="time"
            step={900}
            value={values.from}
            disabled={!values.date}
            onChange={(event) => set("from", event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.to}>Bitiş</Label>
          <Input
            id={ids.to}
            name="to"
            type="time"
            step={900}
            value={values.to}
            disabled={!values.date}
            onChange={(event) => set("to", event.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-3">
          Saatler işletmenin yerel saatidir. Müsaitliğe göre süzmek için bir tarih seç; tarih seçmezsen liste eşleşen bütün işletmeleri gösterir.
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Searching…" : "Search"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setValues(EMPTY_SEARCH_VALUES)
            submit(EMPTY_SEARCH_VALUES)
          }}
        >
          Filtreleri temizle
        </Button>
        <p aria-live="polite" className="ml-auto text-sm text-muted-foreground">
          {pending
            ? "Updating results…"
            : typeof resultCount === "number"
              ? `${resultCount} venue${resultCount === 1 ? "" : "s"}`
              : ""}
        </p>
      </div>
    </form>
  )
}

/** Stable ids for label/control pairs, per instance. */
function useFieldIds(): Record<"q" | "city" | "maxPrice" | "format" | "surface" | "indoor" | "date" | "from" | "to", string> {
  const base = useId()
  return {
    q: `${base}-q`,
    city: `${base}-city`,
    maxPrice: `${base}-max-price`,
    format: `${base}-format`,
    surface: `${base}-surface`,
    indoor: `${base}-indoor`,
    date: `${base}-date`,
    from: `${base}-from`,
    to: `${base}-to`,
  }
}
