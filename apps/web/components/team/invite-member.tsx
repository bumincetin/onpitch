"use client"

/**
 * components/team/invite-member.tsx
 *
 * Add somebody to the squad by display name or by email.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO LOOKUPS, TWO DIFFERENT PRIVACY STORIES
 * ---------------------------------------------------------------------------------------------
 * Typing a NAME searches `profiles` straight from the browser under the caller's own session.
 * `display_name` is in the SELECT grant and `profiles_select_self_or_visible` scopes the rows, so
 * a private account simply does not appear — which is what the person chose when they set it
 * private. No route is needed and none is used: RLS is doing the work.
 *
 * Typing an EMAIL cannot work that way. `profiles.email` is outside the column-level SELECT grant,
 * and a column privilege covers the WHERE clause too, so the browser cannot filter on it at all.
 * The address is posted to `POST /api/teams/[id]/members`, which resolves it server-side against
 * an exact match and never reveals more than the person's display name. There is no partial email
 * search anywhere in this product, by design.
 *
 * The email route is not a way around the name search's privacy, though it reads like one. The
 * server re-reads whatever the address matched through the CALLER'S own session before it answers,
 * so a profile the name search would not show is reported as "no match" here too. An address is
 * only ever a way to name somebody you could already have found — otherwise a captain could add a
 * stranger to their roster and the shared team would hand them `can_view_profile()` for good.
 *
 * ---------------------------------------------------------------------------------------------
 * NOBODY IS INVENTED
 * ---------------------------------------------------------------------------------------------
 * If the address belongs to no account, nothing is written — no placeholder profile, no pending
 * invite row, no email sent on the captain's behalf. The honest answer is "they need an account
 * first", so this offers a signup link to send them and stops there.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"

import { JerseyPicker } from "@/components/team/jersey-picker"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"

export interface InviteMemberProps {
  teamId: string
  teamName: string
  /** Player ids already on the active squad; they are filtered out of the search results. */
  existingPlayerIds: readonly string[]
  /** Kadro numbers already worn, so the picker greys them out. */
  takenNumbers: readonly number[]
  className?: string
}

interface Candidate {
  id: string
  displayName: string
  city: string | null
  preferredPosition: string | null
}

const SEARCH_DEBOUNCE_MS = 250
const MIN_SEARCH_LENGTH = 2
const MAX_RESULTS = 6

/** Good enough to decide which branch to take; the server does the real validation. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/* ========================================================================== */

export function InviteMember({
  teamId,
  teamName,
  existingPlayerIds,
  takenNumbers,
  className,
}: InviteMemberProps) {
  const router = useRouter()
  const [term, setTerm] = useState("")
  const [jersey, setJersey] = useState<number | null>(null)
  const [results, setResults] = useState<Candidate[]>([])
  const [searching, setSearching] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const supabase = useMemo(() => createClient(), [])
  const existing = useMemo(() => new Set(existingPlayerIds), [existingPlayerIds])
  const trimmed = term.trim()
  const looksLikeEmail = EMAIL_SHAPE.test(trimmed)

  // The last search to be started wins. Without this counter a slow query for "ka" can land after
  // a fast one for "kartal" and repopulate the list with stale rows.
  const requestRef = useRef(0)

  useEffect(() => {
    setNotFound(false)
    setError(null)

    if (looksLikeEmail || trimmed.length < MIN_SEARCH_LENGTH) {
      setResults([])
      setSearching(false)
      return
    }

    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setSearching(true)

    const timer = setTimeout(() => {
      void (async () => {
        // No `display_name is not null` filter is needed: NULL never matches ILIKE, so the
        // pattern already excludes unnamed profiles. RLS decides the rest.
        const { data, error: searchError } = await supabase
          .from("profiles")
          .select("id, display_name, city, preferred_position")
          .ilike("display_name", `${escapeLike(trimmed)}%`)
          .limit(MAX_RESULTS + existing.size)

        if (requestRef.current !== requestId) return
        setSearching(false)

        if (searchError) {
          setError("Could not search for players just now.")
          setResults([])
          return
        }

        const rows = (data ?? [])
          .filter((row) => !existing.has(row.id))
          .slice(0, MAX_RESULTS)
          .map((row) => ({
            id: row.id,
            // Non-null in practice (see the ILIKE note above), but the column is nullable and
            // this narrows it without an assertion.
            displayName: row.display_name ?? "Unnamed player",
            city: row.city,
            preferredPosition: row.preferred_position,
          }))

        setResults(rows)
      })()
    }, SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [existing, looksLikeEmail, supabase, trimmed])

  const add = useCallback(
    async (body: { playerId?: string; email?: string }, label: string, key: string) => {
      setPendingId(key)
      setNotFound(false)
      setError(null)

      const result = await callApi(`/api/teams/${teamId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, jerseyNumber: jersey }),
      })

      setPendingId(null)

      if (!result.ok) {
        if (result.status === 404) {
          setNotFound(true)
          return
        }
        setError(result.message)
        return
      }

      toast({
        variant: "success",
        title: `${label} added`,
        description: `They are on the ${teamName} squad now.`,
      })
      setTerm("")
      setJersey(null)
      setResults([])
      router.refresh()
    },
    [jersey, router, teamId, teamName],
  )

  const inputId = "invite-member-search"

  /**
   * Spoken form of what the list below is showing. The results `<ul>`, the "no match" notice and
   * the email row all appear and disappear silently — the only thing tied to the input is the hint
   * paragraph, and an `aria-describedby` target whose text mutates is not reliably re-announced.
   * So a screen-reader user typing a name would otherwise never learn that candidates arrived, how
   * many there are, or that they should reach for an email address instead. Same `sr-only` +
   * `aria-live` pattern as `components/booking/slot-picker.tsx`.
   */
  const searchStatus = looksLikeEmail
    ? `Ready to add the account registered to ${trimmed}.`
    : searching
      ? "Searching…"
      : trimmed.length < MIN_SEARCH_LENGTH
        ? ""
        : results.length > 0
          ? `${results.length} ${results.length === 1 ? "player" : "players"} found.`
          : "No visible profile matches that name."

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className="text-base">Oyuncu ekle</CardTitle>
        <CardDescription>
          Görünen ada göre ara ya da biliyorsan e-posta adresini yaz. E-posta araması tam eşleşmedir. Her iki durumda da yalnızca profilini zaten görebildiğin birini ekleyebilirsin.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1 space-y-1.5">
            <Label htmlFor={inputId}>Görünen ad ya da e-posta</Label>
            <Input
              id={inputId}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Ada, or ada@example.com"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${inputId}-hint`}
            />
            <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
              {searching ? "Searching…" : "At least two characters to search by name."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${inputId}-jersey`}>Forma numarası</Label>
            <div>
              <JerseyPicker
                id={`${inputId}-jersey`}
                value={jersey}
                taken={takenNumbers}
                onChange={setJersey}
              />
            </div>
          </div>
        </div>

        <p className="sr-only" aria-live="polite">
          {searchStatus}
        </p>

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Eklenemedi</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {notFound ? <NoAccountNotice /> : null}

        {looksLikeEmail ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <p className="text-sm">
              Add the account registered to{" "}
              <span className="font-medium">{trimmed}</span>.
            </p>
            <Button
              size="sm"
              disabled={pendingId !== null}
              onClick={() => void add({ email: trimmed }, "That player", "email")}
            >
              {pendingId === "email" ? "Adding…" : "Add by email"}
            </Button>
          </div>
        ) : null}

        {!looksLikeEmail && results.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {results.map((candidate) => (
              <li
                key={candidate.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{candidate.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[candidate.city, candidate.preferredPosition].filter(Boolean).join(" · ") ||
                      "No details shared"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pendingId !== null}
                  onClick={() =>
                    void add({ playerId: candidate.id }, candidate.displayName, candidate.id)
                  }
                >
                  {pendingId === candidate.id ? "Adding…" : "Add"}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {!looksLikeEmail && !searching && trimmed.length >= MIN_SEARCH_LENGTH && results.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            Bu ada uyan görünür bir profil yok. Biliyorsan e-posta adresini dene — ama gizli bir profilin kadroya eklenebilmesi için önce görünür yapılması gerekir.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  No account                                                                 */
/* -------------------------------------------------------------------------- */

function NoAccountNotice() {
  const [copied, setCopied] = useState(false)
  const [signupUrl, setSignupUrl] = useState("/signup")

  useEffect(() => {
    setSignupUrl(`${window.location.origin}/signup`)
  }, [])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(signupUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is denied in plenty of ordinary situations (an insecure origin, a
      // permissions policy, Safari without a user gesture). The link is on screen either way.
      toast({
        title: "Bağlantıyı elle kopyala",
        description: "Tarayıcın panoya yazmamıza izin vermedi.",
      })
    }
  }, [signupUrl])

  return (
    <Alert role="alert">
      <AlertTitle>Bu adrese sahip, ekleyebileceğin biri yok</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Yer tutucu hesap oluşturmuyoruz; kişi kayıt olana kadar eklenecek bir şey yok. Bu bağlantıyı gönder, kayıt olduğunda ekle. Hesabı varsa ama profili gizliyse, ekleyebilmen için önce profilini görünür yapması gerekir.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 text-xs">{signupUrl}</code>
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
})

async function callApi(
  url: string,
  init: RequestInit,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  let response: Response
  try {
    response = await fetch(url, { credentials: "same-origin", ...init })
  } catch {
    return { ok: false, status: 0, message: "Sunucuya ulaşılamadı. Bağlantını kontrol et." }
  }

  const payload: unknown = await response.json().catch(() => null)
  const failure = failureSchema.safeParse(payload)

  if (failure.success) {
    return { ok: false, status: response.status, message: failure.data.error.message }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: "Bir şeyler ters gitti. Lütfen tekrar dene.",
    }
  }
  return { ok: true }
}

/**
 * Neutralise every wildcard on the way to `ilike`.
 *
 * PostgREST rewrites `*` into `%` before the pattern reaches SQL, and SQL treats `%` and `_` as
 * wildcards with backslash as the escape. Left alone, typing "%" would list every profile the
 * viewer may see, which is a directory dump rather than a search.
 */
function escapeLike(value: string): string {
  return value.replace(/\*/g, "").replace(/[\\%_]/g, (character) => `\\${character}`)
}
