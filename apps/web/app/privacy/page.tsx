/**
 * app/privacy/page.tsx — the privacy notice.
 *
 * Three places link here and all of them are on surfaces a signed-out visitor sees: the auth
 * shell footer (`app/(auth)/layout.tsx`), the player shell footer (`app/(app)/layout.tsx`) and
 * the guardian consent page (`app/(auth)/parental-consent/page.tsx`), which cites it as part of
 * the GDPR Art. 8 flow. It therefore sits at the app root rather than inside a route group: the
 * `(app)` and `(dashboard)` layouts both call `requireRole()`, and a privacy notice you have to
 * sign in to read is no notice at all. `middleware.ts` does not list `/privacy`, so it stays open.
 *
 * The wording below describes what the code actually does — nothing more. It is a plain-language
 * summary written by the build, not reviewed legal copy; the banner says so.
 */

import type { Metadata } from "next"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Gizlilik",
  description: "OnPitch'nın hakkında ne sakladığı, nedeni ve verini nasıl geri alıp sildirebileceğin.",
}

interface Section {
  heading: string
  body: readonly string[]
}

const SECTIONS: readonly Section[] = [
  {
    heading: "Neyi saklıyoruz",
    body: [
      "Your account: email address, the name you choose to display, and — because the law sets an age threshold for consent — your date of birth. City, preferred position and a short bio are optional and only stored if you fill them in.",
      "Your activity: the pitches you book, the matches you take part in, the scores reported for them, and the rating those results produce.",
      "Payments: the amount, currency and Stripe reference for each booking. Card numbers never reach our servers — Stripe collects and holds them.",
    ],
  },
  {
    heading: "Kim görebilir",
    body: [
      "Profiles are private by default. A match record names the people in it, and it is readable only by those people, the organiser, and the venue whose pitch was booked.",
      "Venue owners see the bookings made on their own pitches — the payer's name, the slot, and the amount — because they need them to run the booking.",
      "Access is enforced in the database itself, row by row, not only in the interface.",
    ],
  },
  {
    heading: "16 yaş altı oyuncular",
    body: [
      "An account whose date of birth puts the holder under 16 cannot book or play until a guardian approves it by email. Until then, location sharing, a public profile and marketing email are all switched off and cannot be switched on.",
      "A guardian can withdraw that approval at any time.",
    ],
  },
  {
    heading: "Talep üzerine verilerin",
    body: [
      "You can export everything we hold about you as a single file, and you can ask for your account to be erased.",
      "Erasure removes your personal details. Booking and payment records are kept in a form that no longer identifies you, because the law on accounting records requires them to be kept for a period.",
    ],
  },
  {
    heading: "Üçüncü taraflar",
    body: [
      "Stripe processes payments and payouts. Supabase hosts the database and the authentication service. Both act on our instructions; neither is given your data for their own purposes.",
    ],
  },
]

export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-16">
      <Link href="/" className="text-sm text-muted-foreground underline underline-offset-4">
        OnPitch&apos;ya dön
      </Link>

      <h1 className="mt-6 text-3xl font-bold tracking-tight">Gizlilik bildirimi</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Bu ürünün neyi neden sakladığının sade bir özeti.
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
        <Link href="/terms" className="underline underline-offset-4">
          kullanım şartları
        </Link>
        .
      </p>
    </main>
  )
}
