/**
 * app/(auth)/signup/page.tsx
 *
 * Server Component wrapping the `SignupForm` island.
 *
 * The privacy note below is not boilerplate: GDPR Art. 13 requires the subject to be told what
 * is collected and why AT THE POINT OF COLLECTION, and Art. 12 requires it in language a child
 * can understand. Since this form asks a possibly-13-year-old for a date of birth and a parent's
 * email address, the explanation belongs on the page itself, not behind a link nobody opens.
 */

import type { Metadata } from "next"

import { SignupForm } from "@/components/auth/signup-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DIGITAL_CONSENT_AGE } from "@/lib/gdpr"

export const metadata: Metadata = {
  title: "Hesap oluştur",
  description: "Saha tutmak, maç kurmak ve reytingini takip etmek için OnPitch'ya katıl.",
}

export default function SignupPage({
  searchParams,
}: {
  searchParams?: { next?: string }
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hesabını oluştur</CardTitle>
        <CardDescription>
          Saha tut, maç kur ve onaylanmış sonuçlardan TrueSkill reytingi biriktir.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <SignupForm nextPath={searchParams?.next} />

        <div className="rounded-lg border bg-muted/40 p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">Neyi neden topluyoruz</p>
          <p className="mt-1">
            Your name and email identify your account. Your date of birth decides which rules
            apply to you — players under {DIGITAL_CONSENT_AGE} get a locked-down profile and need
            a guardian&apos;s approval before booking. We never store a player&apos;s location,
            and we never sell anything to anyone.
          </p>
          <p className="mt-2">
            Hakkında tuttuğumuz her şeyi istediğin an hesap ayarlarından indirebilir ya da silinmesini isteyebilirsin.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
