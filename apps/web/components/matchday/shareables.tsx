"use client"

/**
 * components/matchday/shareables.tsx
 *
 * The WhatsApp card, the story graphic and the plain-text message, each with one tap to share.
 * Previews are rendered off-screen to canvas and shown as images, so what the coach sees is the
 * exact PNG that will be sent.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Copy, Download, MessageCircle, Share2 } from "lucide-react"

import { debriefShareText, type LiveEvent, type Player, type PostMatchDebrief, type PreMatchPlan } from "@onpitch/shared/matchday"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/use-toast"
import { EXPORT_OUTCOME_MESSAGE, canvasToPngBlob, copyImage, downloadBlob, exportImage, shareText, type ExportOutcome } from "@/lib/matchday/export"
import { renderStoryGraphic, renderWhatsappCard, type GraphicInput } from "@/lib/matchday/render/graphics"

export interface ShareablesProps {
  debrief: PostMatchDebrief
  plan: PreMatchPlan | null
  players: Player[]
  teamName: string
  events: LiveEvent[]
}

export function Shareables({ debrief, plan, players, teamName, events }: ShareablesProps) {
  const input = useMemo<GraphicInput>(() => ({ debrief, players, teamName, plan, events }), [debrief, players, teamName, plan, events])
  const renderCard = useCallback(() => renderWhatsappCard(input), [input])
  const renderStory = useCallback(() => renderStoryGraphic(input), [input])
  const text = debriefShareText({ debrief, players, teamName, fairPlayToleranceMinutes: plan?.rotationIntervalMinutes ?? 10 })

  return (
    <div className="space-y-6">
      <Graphic
        title="WhatsApp kartı"
        description="Skor, goller, adil süre rozeti ve iki yıldız. Özel notlar yok."
        render={renderCard}
        filename={`mac-ozeti-${debrief.playedOn}.png`}
        previewClassName="max-w-[320px]"
      />
      <Graphic
        title="Instagram hikâyesi"
        description="9:16 — ilk 11, skor ve anlar."
        render={renderStory}
        filename={`mac-hikayesi-${debrief.playedOn}.png`}
        previewClassName="max-w-[240px]"
      />

      <section className="space-y-2 rounded-md border p-4" aria-labelledby="share-text-heading">
        <h3 id="share-text-heading" className="text-base font-semibold">
          Metin olarak
        </h3>
        <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 font-sans text-sm">{text}</pre>
        <Button
          type="button"
          className="h-11"
          onClick={() => void shareText(text, "Maç özeti").then((outcome) => toast({ description: EXPORT_OUTCOME_MESSAGE[outcome] }))}
        >
          <MessageCircle />
          Metni paylaş
        </Button>
      </section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Graphic({
  title,
  description,
  render,
  filename,
  previewClassName,
}: {
  title: string
  description: string
  render: () => HTMLCanvasElement
  filename: string
  previewClassName?: string
}) {
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const handle = window.requestAnimationFrame(() => {
      try {
        const url = render().toDataURL("image/png")
        if (!cancelled) setPreview(url)
      } catch {
        if (!cancelled) setPreview(null)
      }
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(handle)
    }
    // `render` closes over the debrief; a new closure means new content.
  }, [render])

  async function run(action: (blob: Blob) => Promise<ExportOutcome> | ExportOutcome) {
    setBusy(true)
    try {
      const blob = await canvasToPngBlob(render())
      toast({ description: EXPORT_OUTCOME_MESSAGE[await action(blob)] })
    } catch {
      toast({ variant: "destructive", description: "Görsel oluşturulamadı." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3 rounded-md border p-4" aria-label={title}>
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data URL rendered client-side
        <img src={preview} alt={`${title} önizlemesi`} className={`w-full rounded-md border ${previewClassName ?? ""}`} />
      ) : (
        <div className="h-48 animate-pulse rounded-md bg-muted" aria-hidden="true" />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="h-11" disabled={busy} onClick={() => void run((blob) => exportImage(blob, { filename, title }))}>
          <Share2 />
          Paylaş
        </Button>
        <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => void run(copyImage)}>
          <Copy />
          Kopyala
        </Button>
        <Button type="button" variant="outline" className="h-11" disabled={busy} onClick={() => void run((blob) => downloadBlob(blob, filename))}>
          <Download />
          İndir
        </Button>
      </div>
    </section>
  )
}
