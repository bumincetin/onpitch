"use client"

/**
 * components/account/delete-account-dialog.tsx
 *
 * GDPR Art. 17 erasure, with the part most products leave out said on screen.
 *
 * `public.request_account_erasure()` pseudonymises the profile, clears everything the person
 * wrote, de-identifies the consent evidence, deletes their notifications and kills every session
 * — and KEEPS the booking rows and payment references. That retention is Art. 17(3)(b),
 * compliance with a legal obligation: Turkish accounting law (VUK art. 253, TTK art. 82) requires
 * transaction records to survive for years. Claiming a total deletion in the UI and then keeping
 * those rows would be the lie; the copy below states the split before the button is enabled.
 *
 * The confirmation string is not decoration. `gdprErasureSchema` types it as
 * `z.literal('DELETE MY ACCOUNT')`, so the server refuses anything else — the input here just
 * makes that requirement visible instead of surprising. A checkbox is too easy to click through
 * for an action with no undo.
 */

import { useCallback, useId, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@halisaha/shared/domain"

/** Must match `gdprErasureSchema`'s literal exactly, including the case. */
const CONFIRMATION = "DELETE MY ACCOUNT"

interface ErasureData {
  status: string
  erasedAt: string | null
  retainedBookingCount: number
  retentionNote: string
}

export function DeleteAccountDialog({ className }: { className?: string }) {
  const baseId = useId()

  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ErasureData | null>(null)

  const confirmed = typed === CONFIRMATION

  const reset = useCallback(
    (next: boolean) => {
      // Once the erasure has committed there is no account behind this page, so Escape and the
      // overlay must not drop the user back onto a dead screen. The receipt's own button leaves.
      if (receipt && !next) return

      setOpen(next)
      if (!next) {
        setTyped("")
        setError(null)
      }
    },
    [receipt],
  )

  const erase = useCallback(async () => {
    if (!confirmed) return
    setError(null)
    setPending(true)

    try {
      const response = await fetch("/api/gdpr/erase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ confirmation: CONFIRMATION }),
      })
      const payload = (await response.json()) as ApiResponse<ErasureData>

      if (!isApiOk(payload)) {
        setError(payload.error.message)
        return
      }

      setReceipt(payload.data)
    } catch {
      setError("Could not reach the server. Nothing has been deleted.")
    } finally {
      setPending(false)
    }
  }, [confirmed])

  const id = (suffix: string): string => `${baseId}-${suffix}`

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button variant="destructive" className={className}>
          Hesabımı sil
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {receipt ? (
          <>
            <DialogHeader>
              <DialogTitle>Hesabın silindi</DialogTitle>
              <DialogDescription>
                Bütün cihazlarda çıkış yapılır ve geri giriş yapılacak bir hesap kalmaz.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 text-sm">
              <Alert variant="success">
                <AlertTitle>Kişisel bilgiler kaldırıldı</AlertTitle>
                <AlertDescription>
                  Adın, e-postan, telefonun, doğum tarihin, biyografin ve veli kaydın silindi. Bildirimlerin ve oturumların da öyle.
                </AlertDescription>
              </Alert>

              <div className="rounded-md border p-4">
                <p className="font-medium">
                  {receipt.retainedBookingCount}{" "}
                  {receipt.retainedBookingCount === 1 ? "booking is" : "bookings are"} kept in
                  pseudonymised form
                </p>
                <p className="mt-1 text-muted-foreground">{receipt.retentionNote}</p>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  // A full navigation, not router.push: every client cache in this tab is holding
                  // data for an account that no longer exists.
                  window.location.assign("/")
                }}
              >
                Kapat ve çık
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Halısaha hesabını sil</DialogTitle>
              <DialogDescription>
                Bu geri alınamaz ve çıkış yapmakla aynı şey değildir.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 text-sm">
              <div className="rounded-md border p-4">
                <p className="font-medium">Neler siliniyor</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>Adın, e-posta adresin, telefon numaran ve doğum tarihin</li>
                  <li>Fotoğrafın, biyografin, şehrin ve tercih ettiğin mevki</li>
                  <li>Velinin adı ve e-postası ile onay kanıtı</li>
                  <li>Bildirimlerin ve bütün cihazlardaki açık oturumların</li>
                </ul>
              </div>

              <div className="rounded-md border p-4">
                <p className="font-medium">Neler kalıyor ve neden</p>
                <p className="mt-2 text-muted-foreground">
                  Rezervasyonlar ve ödeme referansları, kimliğin çıkarılmış hâlde veritabanında kalır. Türk vergi mevzuatı işletmelerin işlem kayıtlarını yıllarca saklamasını gerektirir ve GDPR md. 17(3)(b) tam olarak bunu silme hakkının dışında bırakır. O satırlara bakıp senin olduklarını kimse anlayamaz.
                </p>
                <p className="mt-2 text-muted-foreground">
                  Katıldığın maç sonuçları da kalır; çünkü bir skorun tek oyuncuya ait yarısını silmek, diğer herkesin reyting geçmişini yeniden yazmak olurdu.
                </p>
              </div>

              {error ? (
                <Alert variant="destructive">
                  <AlertTitle>Hiçbir şey silinmedi</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor={id("confirm")}>
                  Yaz <span className="font-mono font-semibold">{CONFIRMATION}</span> yazarak onayla
                </Label>
                <Input
                  id={id("confirm")}
                  value={typed}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={pending}
                  aria-describedby={id("confirm-hint")}
                  className={cn(typed.length > 0 && !confirmed && "border-destructive")}
                  onChange={(event) => setTyped(event.target.value)}
                />
                <p id={id("confirm-hint")} className="text-xs text-muted-foreground">
                  Tam olarak yazıldığı gibi, büyük harfle.
                </p>
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" disabled={pending} onClick={() => reset(false)}>
                Hesabımı tut
              </Button>
              <Button variant="destructive" disabled={!confirmed || pending} onClick={() => void erase()}>
                {pending ? "Erasing…" : "Erase my account"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
