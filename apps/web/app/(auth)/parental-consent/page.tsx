/**
 * app/(auth)/parental-consent/page.tsx
 *
 * The guardian-facing page behind the emailed consent link. GDPR Art. 8(2): the controller must
 * make "reasonable efforts to verify that consent is given or authorised by the holder of
 * parental responsibility". This page is that verification step.
 *
 * Two design decisions worth defending, because both look like extra work:
 *
 * 1. VISITING THE LINK DOES NOT GRANT CONSENT. The token is redeemed by an explicit POST, never
 *    by the GET that renders this page. Corporate mail security (Outlook Safe Links, Proofpoint,
 *    Mimecast) fetches every URL in an inbound email; auto-redeeming on GET would let a link
 *    scanner consent on a parent's behalf, seconds after the email arrived and before any human
 *    read it. It would also make the token single-view rather than single-use. An explicit click
 *    is both the safer engineering choice and the closer match to "a clear affirmative act".
 *
 * 2. NO CLIENT-SIDE JAVASCRIPT. This is a plain Server Component and a plain HTML form. The
 *    person reading it is a parent on whatever device and mail client they happen to own, not a
 *    user of the product, and they get exactly one chance. A form post works everywhere.
 *    `/api/auth/parental-consent/verify` answers a form submission with a redirect back here
 *    carrying `?state=`, and answers a JSON request with the documented `ApiResponse` envelope.
 *
 * The token is in the URL, so this page sets `noindex` and never renders the token back into the
 * document except as the hidden field it must post.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { CONSENT_TOKEN_TTL_DAYS, DIGITAL_CONSENT_AGE } from "@/lib/gdpr"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Hesap onayı",
  // The URL carries a one-time credential. Keep it out of every index and referrer.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
}

type ConsentState = "granted" | "invalid" | "error"

const STATES: readonly ConsentState[] = ["granted", "invalid", "error"]

function readState(value: string | undefined): ConsentState | null {
  return value && (STATES as readonly string[]).includes(value) ? (value as ConsentState) : null
}

export default function ParentalConsentPage({
  searchParams,
}: {
  searchParams?: { token?: string; state?: string }
}) {
  const token = typeof searchParams?.token === "string" ? searchParams.token.trim() : ""
  const state = readState(searchParams?.state)

  /* ---------------------------------------------------------------- granted */
  if (state === "granted") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Onaylandı — teşekkürler</CardTitle>
          <CardDescription>
            Hesap artık saha tutabilir ve maçlara katılabilir.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>Kapalı kalanlar</AlertTitle>
            <AlertDescription>
              <p>
                Your approval unlocks booking and playing. It does not unlock anything else — for
                every account under {DIGITAL_CONSENT_AGE} we keep the following locked, whatever
                the account holder chooses:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                <li>konum paylaşımı kapalıdır ve açılamaz;</li>
                <li>profil asla herkese açık olmaz — yalnızca takım arkadaşları görebilir;</li>
                <li>asla pazarlama e-postası gönderilmez.</li>
              </ul>
            </AlertDescription>
          </Alert>

          <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Fikrini değiştirebilirsin</p>
            <p className="mt-1">
              Bu onayı istediğin an (GDPR md. 7(3)) sana gönderdiğimiz e-postayı yanıtlayarak geri çekebilirsin. Onay geri çekilince hesap o andan itibaren saha tutamaz ve maçlara katılamaz.
            </p>
          </div>
        </CardContent>
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            Bu sayfayı kapatabilirsin. Bağlantı kullanıldı ve bir daha çalışmayacak.
          </p>
        </CardFooter>
      </Card>
    )
  }

  /* ------------------------------------------------------- invalid / expired */
  if (state === "invalid") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bu bağlantı çalışmıyor</CardTitle>
          <CardDescription>
            Süresi dolmuş, daha önce kullanılmış ya da bizim verdiğimiz bir bağlantı değil.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertTitle>Hiçbir şey onaylanmadı</AlertTitle>
            <AlertDescription>
              Approval links are valid for {CONSENT_TOKEN_TTL_DAYS} days and can be used once. We
              deliberately don&apos;t say which of those applies here — telling the difference
              would help someone guessing at links.
            </AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">
            Gencin giriş yapıp hesap ayarlarından yeni bir onay e-postası istemesini söyle. O zamana kadar hesap saha tutamaz ve maça katılamaz.
          </p>
        </CardContent>
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            Bu e-postayı beklemiyor muydun? Görmezden gelebilirsin — onayın olmadan hiçbir şey olmaz.
          </p>
        </CardFooter>
      </Card>
    )
  }

  /* ---------------------------------------------------------- transient error */
  if (state === "error") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bizim tarafımızda bir şeyler ters gitti</CardTitle>
          <CardDescription>Bağlantında bir sorun yok. Biz işleyemedik.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive">
            <AlertTitle>Hiçbir şey değişmedi</AlertTitle>
            <AlertDescription>
              Lütfen birkaç dakika sonra e-postandaki bağlantıyı tekrar aç. Bağlantı henüz kullanılmadı.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  /* --------------------------------------------------------------- no token */
  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Onay bağlantısı bulunamadı</CardTitle>
          <CardDescription>
            Bu sayfa yalnızca gönderdiğimiz e-postadaki bağlantıyla açıldığında çalışır.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            &ldquo;Çocuğunuzun Halısaha hesabını onaylayın&rdquo; başlıklı e-postayı aç ve içindeki düğmeyi kullan. Bulamıyorsan gencin hesap ayarlarından yenisini göndermesini iste.
          </p>
        </CardContent>
        <CardFooter>
          <Link href="/" className="text-sm underline underline-offset-4">
            Halısaha&apos;ya dön
          </Link>
        </CardFooter>
      </Card>
    )
  }

  /* ------------------------------------------------------------ the decision */
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bu hesabı onaylıyor musun?</CardTitle>
        <CardDescription>
          Someone under {DIGITAL_CONSENT_AGE} has asked to join Halisaha and named you as their
          parent or guardian.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm">
          <p>
            Halisaha is an app for booking five- and seven-a-side pitches and organising amateur
            matches. Because they told us they are under {DIGITAL_CONSENT_AGE}, GDPR Article 8
            requires your approval before we may process their data.
          </p>
        </div>

        <div className="rounded-lg border bg-muted/40 p-4 text-sm">
          <p className="font-medium">Neyi onaylıyorsun</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Saha tutabilir ve maçlara katılabilir.</li>
            <li>
              Adını, e-postasını, doğum tarihini ve maç geçmişini tutuyoruz — fazlası yok, hiçbiri satılmaz ya da reklamverenlerle paylaşılmaz.
            </li>
          </ul>

          <p className="mt-4 font-medium">Onaylasan da onaylamasan da kapalı kalanlar</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>Konum paylaşımı kapalıdır ve açılamaz.</li>
            <li>Profili asla herkese açık olmaz — yalnızca takım arkadaşları görebilir.</li>
            <li>Pazarlama e-postası hiçbir zaman almaz.</li>
          </ul>
        </div>

        {/*
          A real form post, so this works with JavaScript disabled. The route answers a
          form-encoded request with a redirect back to this page carrying ?state=.
        */}
        <form method="post" action="/api/auth/parental-consent/verify" className="space-y-3">
          <input type="hidden" name="token" value={token} />
          <Button type="submit" className="w-full">
            Bu hesabı onaylıyorum
          </Button>
        </form>

        <p className="text-xs text-muted-foreground">
          Nothing happens until you press the button. If you don&apos;t want to approve, close this
          page — the link expires on its own after {CONSENT_TOKEN_TTL_DAYS} days and
          the account stays blocked from booking and playing.
        </p>
      </CardContent>

      <CardFooter className="flex-col items-start gap-1">
        <p className="text-xs text-muted-foreground">
          Onayını istediğin an geri çekebilirsin (GDPR md. 7(3)).
        </p>
        <Link href="/privacy" className="text-xs underline underline-offset-4">
          Gizlilik bildirimini oku
        </Link>
      </CardFooter>
    </Card>
  )
}
