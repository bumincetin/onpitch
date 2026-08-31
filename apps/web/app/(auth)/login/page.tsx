/**
 * app/(auth)/login/page.tsx
 *
 * Server Component. The interactive part is the `LoginForm` island; everything else — the card,
 * the copy, and the messages carried in the query string — renders on the server.
 *
 * The `?error=` and `?message=` parameters are produced by `/auth/callback` and by
 * `middleware.ts`. They are mapped through a fixed table rather than echoed, so a crafted link
 * cannot put arbitrary text (or markup) on the sign-in page of a site the user trusts.
 */

import type { Metadata } from "next"

import { LoginForm } from "@/components/auth/login-form"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const metadata: Metadata = {
  title: "Giriş yap",
  description: "Saha tutmak, maç kurmak ve reytingini takip etmek için giriş yap.",
}

/** Fixed, non-echoing messages. Anything not in here is ignored. */
const NOTICES: Record<string, { title: string; body: string; destructive: boolean }> = {
  auth_callback_failed: {
    title: "Bu bağlantı çalışmadı",
    body: "Süresi dolmuş ya da daha önce kullanılmış olabilir. Aşağıdan giriş yap veya yeni bağlantı iste.",
    destructive: true,
  },
  session_expired: {
    title: "Oturumun kapatıldı",
    body: "Oturumun sona erdi. Kaldığın yerden devam etmek için tekrar giriş yap.",
    destructive: false,
  },
  signed_out: {
    title: "Çıkış yapıldı",
    body: "Bu cihazda çıkış yaptın.",
    destructive: false,
  },
  account_erased: {
    title: "Hesabın silindi",
    body: "Kişisel bilgilerin kaldırıldı. Rezervasyon kayıtları, muhasebe mevzuatının gerektirdiği gibi, seni tanımlamayan bir biçimde saklanıyor.",
    destructive: false,
  },
  email_confirmed: {
    title: "E-posta doğrulandı",
    body: "Teşekkürler — adresin doğrulandı. Devam etmek için giriş yap.",
    destructive: false,
  },
}

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string; error?: string; message?: string }
}) {
  const key = searchParams?.error ?? searchParams?.message
  const notice = key ? NOTICES[key] : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle>Giriş yap</CardTitle>
        <CardDescription>Tekrar hoş geldin. Hadi seni sahaya çıkaralım.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {notice && (
          <Alert variant={notice.destructive ? "destructive" : "default"}>
            <AlertTitle>{notice.title}</AlertTitle>
            <AlertDescription>{notice.body}</AlertDescription>
          </Alert>
        )}

        <LoginForm nextPath={searchParams?.next} />
      </CardContent>
    </Card>
  )
}
