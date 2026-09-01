"use client"

/**
 * lib/matchday/export.ts
 *
 * Getting a canvas out of the browser and into a lock screen, a WhatsApp group or a story.
 *
 * Order of preference, each falling through to the next when the platform cannot do it:
 *
 *   1. Web Share API with a file — the native share sheet on iOS and Android, which is the only
 *      route that lands an image directly in WhatsApp or Instagram.
 *   2. Clipboard image write — desktop browsers; paste into the chat.
 *   3. A download — the universal fallback.
 *
 * A user dismissing the share sheet is `cancelled`, not a failure, and does not fall through:
 * closing the sheet and getting a surprise download would be worse than nothing.
 */

export type ExportOutcome = "shared" | "copied" | "downloaded" | "cancelled" | "failed"

export interface ExportOptions {
  filename: string
  title?: string
  text?: string
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("Canvas could not be encoded as PNG"))
    }, "image/png")
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

export function canShareFiles(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false
  if (typeof navigator.canShare !== "function") return false
  try {
    const probe = new File([new Uint8Array(1)], "probe.png", { type: "image/png" })
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

export function canCopyImages(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard !== "undefined" &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  )
}

export async function shareImage(blob: Blob, options: ExportOptions): Promise<ExportOutcome> {
  const file = new File([blob], options.filename, { type: "image/png" })
  try {
    await navigator.share({ files: [file], title: options.title, text: options.text })
    return "shared"
  } catch (error) {
    return isAbortError(error) ? "cancelled" : "failed"
  }
}

export async function copyImage(blob: Blob): Promise<ExportOutcome> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
    return "copied"
  } catch {
    return "failed"
  }
}

export function downloadBlob(blob: Blob, filename: string): ExportOutcome {
  try {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.rel = "noopener"
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Give the browser a tick to start the download before the URL is revoked.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
    return "downloaded"
  } catch {
    return "failed"
  }
}

/** One tap: share sheet, else clipboard, else download. */
export async function exportImage(blob: Blob, options: ExportOptions): Promise<ExportOutcome> {
  if (canShareFiles()) {
    const outcome = await shareImage(blob, options)
    if (outcome !== "failed") return outcome
  }
  if (canCopyImages()) {
    const outcome = await copyImage(blob)
    if (outcome === "copied") return outcome
  }
  return downloadBlob(blob, options.filename)
}

export async function shareText(text: string, title?: string): Promise<ExportOutcome> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ text, title })
      return "shared"
    } catch (error) {
      if (isAbortError(error)) return "cancelled"
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return "copied"
  } catch {
    return "failed"
  }
}

export const EXPORT_OUTCOME_MESSAGE: Record<ExportOutcome, string> = {
  shared: "Paylaşıldı.",
  copied: "Panoya kopyalandı — sohbete yapıştırabilirsin.",
  downloaded: "İndirildi.",
  cancelled: "Paylaşım iptal edildi.",
  failed: "Paylaşılamadı. Tekrar dene ya da indir.",
}
