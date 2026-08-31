"use client"

/**
 * components/account/data-export-card.tsx
 *
 * GDPR Art. 15 and Art. 20 from the UI: one button that saves everything we hold about the
 * signed-in person as a JSON file.
 *
 * `GET /api/gdpr/export` already sets `Content-Disposition: attachment`, so a plain anchor would
 * download it. This goes through `fetch` anyway for one reason: an anchor cannot tell the user
 * that the export failed. A 500 from `export_my_data()` in an anchor navigation replaces the
 * page with a JSON error body; here it becomes a sentence and the page stays put.
 *
 * The blob URL is revoked immediately after the click. Leaving it alive keeps the whole export —
 * the most personal payload this app can produce — resident in the tab for as long as the
 * document lives.
 */

import { useCallback, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@halisaha/shared/domain"

/** `attachment; filename="halisaha-data-export-2026-08-30.json"` -> the filename. */
function filenameFrom(header: string | null): string | null {
  if (!header) return null
  const quoted = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  const captured = quoted?.[1]
  if (!captured) return null
  try {
    return decodeURIComponent(captured.trim())
  } catch {
    return captured.trim()
  }
}

function fallbackFilename(): string {
  return `halisaha-data-export-${new Date().toISOString().slice(0, 10)}.json`
}

export function DataExportCard({ className }: { className?: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastDownload, setLastDownload] = useState<string | null>(null)

  const download = useCallback(async () => {
    setError(null)
    setPending(true)

    try {
      const response = await fetch("/api/gdpr/export", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      })

      if (!response.ok) {
        // Errors keep the ApiResponse envelope even though the success body deliberately does
        // not — see the route's header comment.
        const payload = (await response.json().catch(() => null)) as ApiResponse<never> | null
        setError(
          payload && !isApiOk(payload)
            ? payload.error.message
            : "Dışa aktarmanı şu an oluşturamadık. Lütfen tekrar dene.",
        )
        return
      }

      const filename = filenameFrom(response.headers.get("content-disposition")) ?? fallbackFilename()
      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)

      const anchor = document.createElement("a")
      anchor.href = objectUrl
      anchor.download = filename
      anchor.rel = "noopener"
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(objectUrl)

      setLastDownload(filename)
      toast({ title: "Dışa aktarma indirildi", description: filename, variant: "success" })
    } catch {
      setError("Could not reach the server. Check your connection and try again.")
    } finally {
      setPending(false)
    }
  }, [])

  return (
    <div className={cn("space-y-4", className)}>
      <p className="text-sm text-muted-foreground">
        Dosya; profilini, rezervasyonlarını ve ödeme referanslarını, katıldığın bütün maçları, reyting geçmişini, onay kaydını ve bildirimlerini içerir. Düz ve okunaklı JSON&apos;dur; kendin okuyabilir ya da başka bir servise verebilirsin.
      </p>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Dışa aktarma indirilemedi</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void download()} disabled={pending}>
          {pending ? "Building your export…" : "Download my data"}
        </Button>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {pending
            ? "This can take a few seconds on a busy account."
            : lastDownload
              ? `Saved as ${lastDownload}.`
              : "Nothing is emailed — the file downloads straight to this device."}
        </p>
      </div>
    </div>
  )
}
