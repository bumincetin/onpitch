"use client"

/**
 * components/matchday/cheat-sheet.tsx
 *
 * The sideline sheet on screen, and the buttons that get it onto a lock screen or paper.
 *
 * The on-screen version is HTML — high contrast, big type, printable through the `matchday-print`
 * class in globals.css. The export renders the same model to a 1080×1920 canvas, so the image on
 * the phone says what the screen says.
 */

import { useCallback, useEffect, useState } from "react"
import { Copy, Download, Printer, Share2 } from "lucide-react"

import type { PreMatchPlan } from "@onpitch/shared/matchday"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/use-toast"
import {
  EXPORT_OUTCOME_MESSAGE,
  canCopyImages,
  canShareFiles,
  canvasToPngBlob,
  copyImage,
  downloadBlob,
  exportImage,
} from "@/lib/matchday/export"
import { displayName } from "@/lib/matchday/plan"
import { cheatSheetModel, renderCheatSheet } from "@/lib/matchday/render/cheat-sheet"
import { cn } from "@/lib/utils"

import { PitchBoard } from "./pitch-board"

export interface CheatSheetProps {
  plan: PreMatchPlan
  teamName: string
  opponentName: string
  subtitle: string
}

export function CheatSheet({ plan, teamName, opponentName, subtitle }: CheatSheetProps) {
  const model = cheatSheetModel(plan)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Feature detection has to wait for the client; the server has no `navigator`.
  const [capabilities, setCapabilities] = useState({ share: false, copy: false })

  useEffect(() => {
    setCapabilities({ share: canShareFiles(), copy: canCopyImages() })
  }, [])

  // Re-render the preview whenever the plan changes, debounced a frame so typing stays smooth.
  useEffect(() => {
    let cancelled = false
    const handle = window.requestAnimationFrame(() => {
      try {
        const canvas = renderCheatSheet({ plan, teamName, opponentName, subtitle })
        if (!cancelled) setPreview(canvas.toDataURL("image/png"))
      } catch {
        if (!cancelled) setPreview(null)
      }
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(handle)
    }
  }, [plan, teamName, opponentName, subtitle])

  const render = useCallback(async () => {
    const canvas = renderCheatSheet({ plan, teamName, opponentName, subtitle })
    return canvasToPngBlob(canvas)
  }, [plan, teamName, opponentName, subtitle])

  const filename = `kenar-notu-${teamName.replace(/\s+/g, "-").toLocaleLowerCase("tr-TR")}.png`

  async function run(action: (blob: Blob) => Promise<string> | string) {
    setBusy(true)
    try {
      const blob = await render()
      const outcome = await action(blob)
      toast({ description: EXPORT_OUTCOME_MESSAGE[outcome as keyof typeof EXPORT_OUTCOME_MESSAGE] ?? outcome })
    } catch {
      toast({ variant: "destructive", description: "Görsel oluşturulamadı." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="h-11" disabled={busy} onClick={() => void run((blob) => exportImage(blob, { filename, title: "Kenar notu" }))}>
          <Share2 />
          {capabilities.share ? "Kilit ekranına gönder" : capabilities.copy ? "Panoya kopyala" : "PNG indir"}
        </Button>
        {capabilities.copy && capabilities.share ? (
          <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => void run(copyImage)}>
            <Copy />
            Kopyala
          </Button>
        ) : null}
        <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => void run((blob) => downloadBlob(blob, filename))}>
          <Download />
          İndir
        </Button>
        <Button type="button" variant="outline" className="h-11" onClick={() => window.print()}>
          <Printer />
          Yazdır
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Görsel 1080×1920, üst kısmı kilit ekranı saati için boş. Telefonda &quot;Duvar kâğıdı yap&quot; de, kenarda telefona
        bakmadan oku.
      </p>

      {/* ---- the sheet itself: what prints ------------------------------- */}
      <article
        className={cn(
          "matchday-print space-y-5 rounded-md border-2 border-foreground bg-[#0f1520] p-4 text-[#f6f1e7] print:border-0 print:bg-white print:text-black",
        )}
        aria-label="Kenar notu"
      >
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-xl font-bold leading-tight">
              {teamName} <span className="opacity-60">vs</span> {opponentName}
            </h3>
            <p className="text-sm opacity-70">{subtitle}</p>
          </div>
          <p className="font-mono text-sm font-bold uppercase tracking-[0.2em] text-gold">{model.formation.name}</p>
        </header>

        <PitchBoard formation={model.formation} lineup={plan.startingLineup} players={plan.squad} readOnly className="print:hidden" />

        <ul className="hidden grid-cols-2 gap-x-4 gap-y-1 text-sm print:grid">
          {model.startingRows.map((row) => (
            <li key={row.slotLabel}>
              <span className="font-mono text-xs uppercase opacity-70">{row.slotLabel}</span> {displayName(row.player)}
            </li>
          ))}
        </ul>

        <section>
          <h4 className="font-mono text-xs font-bold uppercase tracking-[0.25em] text-gold">Değişiklikler</h4>
          {model.swapBlocks.length === 0 ? (
            <p className="mt-2 text-sm opacity-80">Planlı değişiklik yok — herkes maç boyu sahada.</p>
          ) : (
            <ol className="mt-2 space-y-3">
              {model.swapBlocks.map((block) => (
                <li key={block.index}>
                  <p className="flex items-baseline gap-2">
                    <span className="font-mono text-2xl font-bold tabular-nums text-teal">{block.startMinute}&apos;</span>
                    <span className="text-sm opacity-70">{block.period}. devre</span>
                  </p>
                  <ul className="mt-1 space-y-1 text-base font-semibold">
                    {block.swaps.map((swap, index) => (
                      <li key={index} className="flex flex-wrap items-center gap-x-2">
                        <span className="text-vermilion">ÇIKAN {displayName(swap.out)}</span>
                        <span aria-hidden="true">›</span>
                        <span className="text-teal">GİREN {displayName(swap.in)}</span>
                        <span className="font-mono text-xs font-normal uppercase opacity-70">{swap.slotLabel}</span>
                      </li>
                    ))}
                    {model.keeperMode === "rotating" && block.keeper ? (
                      <li className="text-gold">Kaleci: {displayName(block.keeper)}</li>
                    ) : null}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>

        <footer className="space-y-1 border-t border-current/20 pt-3 text-sm opacity-80">
          <p>{model.bench.length > 0 ? `Yedek: ${model.bench.map((player) => displayName(player)).join(", ")}` : "Yedek yok"}</p>
          {model.unavailable.length > 0 ? <p>Yok: {model.unavailable.map((player) => player.name).join(", ")}</p> : null}
        </footer>
      </article>

      {preview ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Kilit ekranı önizlemesi</summary>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL rendered client-side */}
          <img src={preview} alt="Kenar notu, kilit ekranı boyutunda" className="mt-2 w-full max-w-[270px] rounded-md border" />
        </details>
      ) : null}
    </div>
  )
}
