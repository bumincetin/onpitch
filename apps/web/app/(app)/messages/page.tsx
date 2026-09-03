/**
 * app/(app)/messages/page.tsx
 *
 * The inbox with nothing open. On a laptop this is the right-hand pane's empty state; on a
 * phone the list (rendered by the layout) is the page, and this pane is hidden.
 *
 * `?refused=1` is stamped by `/messages/with/[userId]` when a thread could not be opened. The
 * reason is deliberately not surfaced — a block is the blocker's business.
 */

import type { Metadata } from "next"
import { MessageCircle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Mesajlar",
  description: "Takım arkadaşların ve işletmelerle sohbetlerin.",
}

export default function MessagesIndexPage({ searchParams }: { searchParams?: { refused?: string } }) {
  const refused = searchParams?.refused

  return (
    <div className="messages-index flex h-full min-h-[40vh] flex-col items-center justify-center gap-4 p-8 text-center">
      {refused ? (
        <Alert className="max-w-md text-left">
          <AlertTitle>Sohbet açılamadı</AlertTitle>
          <AlertDescription>
            {refused === "rate"
              ? "Kısa sürede çok fazla yeni sohbet başlattın. Biraz sonra tekrar dene."
              : "Bu kişi şu an senden mesaj kabul etmiyor. Takım arkadaşların ve rezervasyon yaptığın işletmelerle her zaman yazışabilirsin."}
          </AlertDescription>
        </Alert>
      ) : null}
      <span className="grid size-14 place-items-center rounded-full bg-user/15 text-user">
        <MessageCircle className="size-6" aria-hidden="true" />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-base">Bir sohbet seç ya da yenisini başlat.</p>
        <p className="text-sm text-muted-foreground">
          Oyuncu profillerinde, kadro listelerinde ve rezervasyon sayfalarında &quot;Mesaj gönder&quot; var.
          Kimlerin sana yazabileceğini{" "}
          <a href="/account/privacy" className="text-user underline underline-offset-4">
            gizlilik ayarlarından
          </a>{" "}
          seçersin.
        </p>
      </div>
    </div>
  )
}
