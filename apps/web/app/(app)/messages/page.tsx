/**
 * app/(app)/messages/page.tsx
 *
 * The inbox with nothing open. On a laptop this is the right-hand pane's empty state; on a
 * phone the list (rendered by the layout) is the page, and this pane is hidden. The
 * "could not open" notice is the layout's, so it is visible on both.
 */

import type { Metadata } from "next"
import { MessageCircle } from "lucide-react"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Mesajlar",
  description: "Takım arkadaşların ve işletmelerle sohbetlerin.",
}

export default function MessagesIndexPage() {
  return (
    <div className="messages-index flex h-full min-h-[40vh] flex-col items-center justify-center gap-4 p-8 text-center">
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
