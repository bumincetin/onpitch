/**
 * app/terms/page.tsx — the terms of use.
 *
 * Linked from the auth shell footer (`app/(auth)/layout.tsx`) and the player shell footer
 * (`app/(app)/layout.tsx`). Like `/privacy` it sits at the app root, outside every route group
 * that calls `requireRole()`, so a signed-out visitor can read it; `middleware.ts` does not list
 * `/terms`, so nothing gates it.
 *
 * The wording below describes the rules the code actually enforces — the platform fee, the
 * booking exclusion constraint, the consensus flow, the age gate. It is a plain-language summary
 * written by the build, not reviewed legal copy; the banner says so.
 */

import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Şartlar",
  description: "Halısaha'da saha tutma, maç oynama ve ödeme alma kuralları.",
}

interface Section {
  heading: string
  body: readonly string[]
}

const SECTIONS: readonly Section[] = [
  {
    heading: "Halısaha nedir",
    body: [
      "Halisaha is a marketplace. Venues list their pitches and set their own prices; players book and pay for a slot. The pitch, and everything that happens on it, is the venue's responsibility and the players' — not ours.",
    ],
  },
  {
    heading: "Rezervasyon ve ödeme",
    body: [
      "A slot is yours once the payment succeeds, and not before. Two people cannot hold the same pitch for overlapping times — the database refuses it outright, so whoever pays first has the slot.",
      "Payment is taken by Stripe. The venue's share is paid directly into the venue's own Stripe account and our commission is deducted in the same transaction. Refunds follow the venue's cancellation policy and are made through the same payment.",
    ],
  },
  {
    heading: "Maçlar, skorlar ve reytingler",
    body: [
      "Players report the result of their own matches. When reports disagree, or when a result looks anomalous, the match is held for consensus rather than counted.",
      "Ratings are calculated from confirmed results. We may exclude a match from the ratings, or correct a rating, when a result has been manipulated.",
    ],
  },
  {
    heading: "Hesaplar",
    body: [
      "Kişi başına tek hesap, bilgiler doğru olmalı. 16 yaş altı oyuncuların saha tutup oynayabilmesi için veli onayı gerekir.",
      "We may suspend an account that manipulates results, abuses other players, or charges back a payment for a match that was played.",
    ],
  },
  {
    heading: "Sorumluluk",
    body: [
      "Amateur football carries a risk of injury. Playing is at your own risk, and insurance for the pitch and the people on it is a matter between the venue and its players.",
    ],
  },
]

export default function TermsPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-16">
      <Link href="/" className="text-sm text-muted-foreground underline underline-offset-4">
        Halısaha&apos;ya dön
      </Link>

      <h1 className="mt-6 text-3xl font-bold tracking-tight">Kullanım şartları</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Bu ürünün uyguladığı kuralların sade bir özeti.
      </p>

      <p className="mt-6 rounded-lg border border-warning/60 p-4 text-sm text-muted-foreground">
        Bu, yazılımın bugün yaptığına uygun olarak yazılmış bir özettir. İncelenmiş bir hukuki belge değildir ve ürün gerçek müşterilere açılmadan önce bir hukukçu tarafından kontrol edilmelidir.
      </p>

      <div className="mt-8 flex flex-col gap-8">
        {SECTIONS.map((section) => (
          <section key={section.heading} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold tracking-tight">{section.heading}</h2>
            {section.body.map((paragraph) => (
              <p key={paragraph} className="text-sm leading-relaxed text-muted-foreground">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>

      <p className="mt-10 text-sm text-muted-foreground">
        See also the{" "}
        <Link href="/privacy" className="underline underline-offset-4">
          gizlilik bildirimi
        </Link>
        .
      </p>
    </main>
  )
}
