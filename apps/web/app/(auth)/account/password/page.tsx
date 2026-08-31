/**
 * app/(auth)/account/password/page.tsx
 *
 * The destination of a password-recovery link. `/auth/callback` verifies the recovery OTP and
 * redirects here (`app/auth/callback/route.ts`), so this URL has to exist — without it the whole
 * "forgot my password" flow ends on `app/not-found.tsx`.
 *
 * It lives in the `(auth)` group on purpose: that layout deliberately does not gate on a session
 * (see its header comment), and `/account` is deliberately absent from `PROTECTED_PREFIXES` in
 * `middleware.ts` — a recovery token's JWT may carry no `user_role` claim yet if the access-token
 * hook is not enabled, so a role gate here would bounce the very user it is meant to serve.
 * `supabase.auth.updateUser()` is the real check: with no session it simply refuses.
 */

import type { Metadata } from "next"

import { UpdatePasswordForm } from "@/components/auth/update-password-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Yeni bir şifre seç",
  description: "Halısaha hesabın için yeni bir şifre belirle.",
}

export default function UpdatePasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Yeni bir şifre seç</CardTitle>
        <CardDescription>
          Bir kurtarma bağlantısıyla geldin, eski şifrene ihtiyacın yok.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <UpdatePasswordForm />
      </CardContent>
    </Card>
  )
}
