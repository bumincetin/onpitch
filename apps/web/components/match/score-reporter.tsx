"use client"

/**
 * components/match/score-reporter.tsx
 *
 * The end-of-match self-report form.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS WRITES STRAIGHT TO `score_reports`
 * ---------------------------------------------------------------------------------------------
 *
 * `0002_rls.sql` grants `authenticated` an INSERT on exactly six columns of `score_reports`
 * (`match_id, reported_by, team_side, home_score, away_score, client_reported_at`) and the RLS
 * policy pins `reported_by = auth.uid()`. Everything that makes a report trustworthy happens in
 * the database, not in a route handler:
 *
 *   * `trg_score_reports_validate` (BEFORE INSERT) runs the rule engine — participation, match
 *     state, kickoff, plausible scoreline, the 48-hour window, a per-reporter rate limit — and
 *     raises PostgREST-mapped SQLSTATEs (PT403 / PT404 / PT409 / PT422 / PT429).
 *   * It also NORMALISES `team_side` from `match_participants`, which is why this form does not
 *     send one: you report as whichever side you actually played for, or as a neutral if you are
 *     the venue owner. Sending a side would at best be ignored and at worst be rejected.
 *   * `payload_hash` is computed server-side and is not in the grant — a hash the client picked
 *     proves nothing.
 *   * `trg_score_reports_evaluate` (AFTER INSERT) runs the corroboration pass, which may finalise
 *     the match, open a consensus round, or simply wait for the other side.
 *
 * So the honest client is a form that inserts a row and then reads back what the database decided.
 * Reports are APPEND ONLY — there is no UPDATE grant and no DELETE grant, and
 * `score_reports_unique (match_id, reported_by)` makes "once" literal. That is what turns a
 * disagreement between two sides into evidence instead of a race, and the copy says so before the
 * user commits.
 */

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import type { PostgrestError } from "@supabase/supabase-js"

import { createClient } from "@/lib/supabase/client"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { Enums } from "@onpitch/shared/database"

/* -------------------------------------------------------------------------- */
/*  Turning SQLSTATEs into sentences                                           */
/* -------------------------------------------------------------------------- */

/**
 * Fallbacks for the cases the database cannot phrase for itself.
 *
 * The rule-engine messages in `0005_integrity_consensus.sql` are already written for a person
 * ("This match has not kicked off yet.", "A single side cannot score more than 30 goals."), so
 * the right thing is to SHOW them, not to re-invent them behind a generic code. This table only
 * covers the errors that arrive as raw Postgres — a unique violation, an RLS refusal — where the
 * native text is machine noise.
 */
const FALLBACK_BY_CODE: Record<string, { title: string; body: string }> = {
  "23505": {
    title: "Bu maçı zaten bildirdin",
    body:
      "Maç başına kişi başına tek bildirim; gönderilen bildirim düzeltilemez ya da geri " +
      "çekilemez — bir anlaşmazlığın üzerinden karara bağlandığı kanıt odur. Bildirdiğin skor " +
      "yanlışsa düzeltmesi için işletmeye ya da bir yöneticiye söyle.",
  },
  "42501": {
    title: "Bu maç için bildirim yapamazsın",
    body: "Skoru yalnızca maçta oynayanlar ya da maçın oynandığı işletmenin sahibi bildirebilir.",
  },
  PGRST301: {
    title: "Oturumun sona erdi",
    body: "Tekrar giriş yap ve bildirimi yeniden gönder.",
  },
}

const GENERIC_FAILURE = {
  title: "İşlem tamamlanmadı",
  body: "Bizim tarafımızda bir şeyler ters gitti. Birazdan tekrar dene.",
}

interface PlainError {
  title: string
  body: string
  /** The database's `hint`, when there is one. Rendered as a second, quieter line. */
  hint?: string
}

/**
 * Renders a PostgrestError as something a footballer can act on.
 *
 * PostgREST maps a SQLSTATE of the form `PTxxx` onto HTTP status `xxx` and passes `message`,
 * `details` and `hint` through verbatim, so for every error the rule engine raises deliberately
 * the best copy available is the copy the migration author already wrote.
 */
export function toPlainError(error: PostgrestError | null): PlainError {
  if (!error) return GENERIC_FAILURE

  const code = error.code ?? ""

  // Deliberate, human-authored errors from the rule engine.
  if (code.startsWith("PT") && error.message) {
    const detail = error.details && error.details !== error.message ? ` ${error.details}` : ""
    return {
      title: titleForPtCode(code),
      body: `${error.message}${detail}`.trim(),
      hint: error.hint ?? undefined,
    }
  }

  const fallback = FALLBACK_BY_CODE[code]
  if (fallback) return { ...fallback, hint: error.hint ?? undefined }

  // Never surface a raw Postgres string: it leaks constraint and column names to no one's benefit.
  console.error("[score-reporter] unmapped database error", { code, message: error.message })
  return GENERIC_FAILURE
}

function titleForPtCode(code: string): string {
  switch (code) {
    case "PT403":
      return "Not your match to report"
    case "PT404":
      return "Match not found"
    case "PT409":
      return "Too late, or already settled"
    case "PT422":
      return "That scoreline does not add up"
    case "PT429":
      return "Slow down"
    default:
      return "Report rejected"
  }
}

/* -------------------------------------------------------------------------- */
/*  Verdict copy                                                               */
/* -------------------------------------------------------------------------- */

interface Verdict {
  title: string
  body: string
  tone: "settled" | "waiting" | "contested"
}

function verdictFor(
  status: Enums<"match_status">,
  scoreConfirmedAt: string | null,
  requiresConsensus: boolean,
  reportCount: number,
): Verdict {
  if (scoreConfirmedAt || status === "finalized") {
    return {
      title: "Sonuç onaylandı",
      body: "İki taraf da hemfikir; skor kesinleşti ve reytingler işlendi.",
      tone: "settled",
    }
  }
  if (requiresConsensus || status === "requires_consensus") {
    return {
      title: "Bildirimler çelişiyor",
      body:
        "Uzlaşma turu açıldı: hangi skorun geçerli olacağına kadro oy veriyor. Oylamayı " +
        "the vote on this page — it needs two thirds of the checked-in players, including at least " +
        "one from each side.",
      tone: "contested",
    }
  }
  if (status === "disputed") {
    return {
      title: "Yöneticiye gönderildi",
      body: "Oyuncular anlaşamadı; bu sonucu bir kişi karara bağlayacak.",
      tone: "contested",
    }
  }
  return {
    title: "Bildirim kaydedildi",
    body:
      reportCount > 1
        ? "Waiting for the remaining reports before the result can be settled."
        : "Waiting for someone from the other side to confirm it. If nobody contradicts it, it is accepted automatically after 24 hours.",
    tone: "waiting",
  }
}

/* -------------------------------------------------------------------------- */
/*  The form                                                                   */
/* -------------------------------------------------------------------------- */

export interface ScoreReporterProps {
  matchId: string
  /** The signed-in user's profile id. Must equal `auth.uid()` or RLS refuses the insert. */
  reporterId: string
  homeTeamName?: string | null
  awayTeamName?: string | null
  /** Prefill, e.g. from the live tally the pitch has been keeping. */
  defaultHomeScore?: number | null
  defaultAwayScore?: number | null
  /** Already filed? Then the form renders its "reports are final" state instead. */
  alreadyReported?: boolean
  className?: string
}

const MAX_GOALS = 30

export function ScoreReporter({
  matchId,
  reporterId,
  homeTeamName,
  awayTeamName,
  defaultHomeScore,
  defaultAwayScore,
  alreadyReported = false,
  className,
}: ScoreReporterProps) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const home = homeTeamName ?? "Home"
  const away = awayTeamName ?? "Away"

  const [homeScore, setHomeScore] = useState<string>(
    typeof defaultHomeScore === "number" ? String(defaultHomeScore) : "",
  )
  const [awayScore, setAwayScore] = useState<string>(
    typeof defaultAwayScore === "number" ? String(defaultAwayScore) : "",
  )
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<PlainError | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<Verdict | null>(null)

  const parse = useCallback((raw: string): number | null => {
    if (raw.trim() === "") return null
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0 || value > MAX_GOALS) return null
    return value
  }, [])

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setFailure(null)
      setLocalError(null)

      const parsedHome = parse(homeScore)
      const parsedAway = parse(awayScore)

      if (parsedHome === null || parsedAway === null) {
        // Caught here purely to save a round trip; the same rule exists in the trigger, and the
        // trigger is the one that counts.
        setLocalError(`Enter a whole number of goals for each side, between 0 and ${MAX_GOALS}.`)
        return
      }

      setSubmitting(true)
      try {
        const { error } = await supabase.from("score_reports").insert({
          match_id: matchId,
          reported_by: reporterId,
          home_score: parsedHome,
          away_score: parsedAway,
          // What THIS DEVICE thinks the time is. Stored beside the server's own `reported_at`; the
          // gap between the two is an anomaly feature. Evidence, never truth — the trigger rejects
          // a value more than five minutes in the future or before kickoff.
          client_reported_at: new Date().toISOString(),
          // `team_side` is omitted on purpose: the BEFORE INSERT trigger derives it from
          // match_participants and refuses a report filed on behalf of the other side.
        })

        if (error) {
          setFailure(toPlainError(error))
          return
        }

        // Read back what the AFTER INSERT corroboration pass decided. The row is the truth; the
        // form does not get to guess a verdict it did not compute.
        const [{ data: match }, { count }] = await Promise.all([
          supabase
            .from("matches")
            .select("status, score_confirmed_at, requires_consensus")
            .eq("id", matchId)
            .maybeSingle(),
          supabase
            .from("score_reports")
            .select("id", { count: "exact", head: true })
            .eq("match_id", matchId),
        ])

        setVerdict(
          verdictFor(
            match?.status ?? "awaiting_report",
            match?.score_confirmed_at ?? null,
            match?.requires_consensus ?? false,
            count ?? 1,
          ),
        )

        // Pull the server component tree back down so the consensus panel, roster and status badge
        // all reflect the new state without a hard reload.
        router.refresh()
      } finally {
        setSubmitting(false)
      }
    },
    [supabase, matchId, reporterId, homeScore, awayScore, parse, router],
  )

  /* ---- already done ---------------------------------------------------- */

  if (verdict) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">{verdict.title}</CardTitle>
          <CardDescription>{verdict.body}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm tabular-nums">
            Senin bildirdiğin <strong>{home}</strong> {homeScore} &ndash; {awayScore}{" "}
            <strong>{away}</strong>.
          </p>
        </CardContent>
      </Card>
    )
  }

  if (alreadyReported) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Bu maçı zaten bildirdin</CardTitle>
          <CardDescription>
            Kişi başına tek bildirim ve gönderilen bildirim düzeltilemez ya da geri çekilemez — bir anlaşmazlığı anlamlı kılan, en son yazanın kazandığı bir yarış olmaması budur.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  /* ---- the form -------------------------------------------------------- */

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">Maç sonucunu bildir</CardTitle>
        <CardDescription>
          Gördüğünü gir. Bildirimin karşı tarafınkiyle karşılaştırılır; uyuşurlarsa sonuç onaylanır, uyuşmazlarsa kadro oylar.
        </CardDescription>
      </CardHeader>

      <form onSubmit={onSubmit} noValidate>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <GoalField
              id="home-score"
              label={home}
              value={homeScore}
              onChange={setHomeScore}
              disabled={submitting}
            />
            <GoalField
              id="away-score"
              label={away}
              value={awayScore}
              onChange={setAwayScore}
              disabled={submitting}
            />
          </div>

          {localError ? (
            <p role="alert" className="text-sm text-destructive">
              {localError}
            </p>
          ) : null}

          {failure ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{failure.title}</AlertTitle>
              <AlertDescription>
                {failure.body}
                {failure.hint ? (
                  <span className="mt-1 block text-xs opacity-80">{failure.hint}</span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Bunu bir kez gönderebilirsin ve sonradan değiştiremezsin. Bildirimlerin başlama saatinden itibaren 48 saat içinde yapılması gerekir; sonrasında sonucu işletme ya da bir yönetici kaydeder.
          </p>
        </CardContent>

        <CardFooter>
          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? "Filing…" : "File this report"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */

function GoalField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  const current = Number(value)
  const numeric = Number.isInteger(current) && value.trim() !== "" ? current : 0

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="block truncate">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          disabled={disabled || numeric <= 0}
          onClick={() => onChange(String(Math.max(0, numeric - 1)))}
          aria-label={`One fewer goal for ${label}`}
        >
          <span aria-hidden="true">−</span>
        </Button>

        <Input
          id={id}
          name={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_GOALS}
          step={1}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn("text-center text-lg tabular-nums")}
          placeholder="0"
          required
        />

        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          disabled={disabled || numeric >= MAX_GOALS}
          onClick={() => onChange(String(Math.min(MAX_GOALS, numeric + 1)))}
          aria-label={`One more goal for ${label}`}
        >
          <span aria-hidden="true">+</span>
        </Button>
      </div>
    </div>
  )
}
