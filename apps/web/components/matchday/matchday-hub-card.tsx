"use client"

/**
 * components/matchday/matchday-hub-card.tsx
 *
 * The matchday entry point on the match page: where this fixture is in the coach's lifecycle and
 * the one or two things to do next. Reads the local record, so it is a client island; renders a
 * neutral skeleton until hydrated so the server markup never disagrees with the browser.
 */

import Link from "next/link"
import { ClipboardList, Radio, Share2, Sparkles } from "lucide-react"

import type { Enums } from "@halisaha/shared/database"
import { MATCHDAY_PHASE_LABEL } from "@halisaha/shared/matchday"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useMatchday } from "@/lib/matchday/use-matchday"

export interface MatchdayHubCardProps {
  matchId: string
  matchStatus: Enums<"match_status">
}

export function MatchdayHubCard({ matchId, matchStatus }: MatchdayHubCardProps) {
  const { record, phase, hydrated } = useMatchday({ matchId, matchStatus })

  const plan = record.plan
  const debrief = record.debrief
  const liveOpen = matchStatus === "scheduled" || matchStatus === "live" || matchStatus === "awaiting_report"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Maç günü</CardTitle>
          {hydrated ? (
            <Badge variant={phase === "in_progress" ? "destructive" : phase === "completed" ? "default" : "secondary"}>
              {MATCHDAY_PHASE_LABEL[phase]}
            </Badge>
          ) : (
            <span className="h-5 w-16 animate-pulse rounded bg-muted" aria-hidden="true" />
          )}
        </div>
        <CardDescription>
          {!hydrated
            ? "Plan yükleniyor…"
            : phase === "completed" && debrief?.completedAt
              ? "Özet tamamlandı. Kartları paylaşabilir ya da düzeltebilirsin."
              : phase === "in_progress"
                ? "Maç oynanıyor. Canlı ekranda plan yüklü."
                : plan
                  ? `${plan.startingLineup.length} kişilik diziliş ve ${plan.scheduledRotations.filter((block) => block.swaps.length > 0).length} değişiklik anı hazır.`
                  : "Kadro, diziliş, eşit süre rotasyonu ve kenar notu. Maçtan sonra 60 saniyelik özet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild variant={plan ? "outline" : "default"} className="h-11">
          <Link href={`/matches/${matchId}/plan`}>
            {plan ? <ClipboardList /> : <Sparkles />}
            {plan ? "Planı aç" : "Maç planı oluştur"}
          </Link>
        </Button>
        {liveOpen ? (
          <Button asChild variant="outline" className="h-11">
            <Link href={`/matches/${matchId}/live`}>
              <Radio />
              Canlı
            </Link>
          </Button>
        ) : null}
        <Button asChild variant={phase === "completed" && !debrief?.completedAt ? "default" : "outline"} className="h-11">
          <Link href={`/matches/${matchId}/debrief`}>
            <Share2 />
            {debrief?.completedAt ? "Özet ve kartlar" : "Maç özeti"}
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
