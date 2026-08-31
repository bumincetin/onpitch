import Link from "next/link"

import { ChapterRail } from "@/components/marketing/chapter-rail"
import { SiteHeader } from "@/components/nav/site-header"
import { NightPitch } from "@/components/three/night-pitch"
import { Button } from "@/components/ui/button"
import { getSessionUser } from "@/lib/rbac"
import { cn } from "@/lib/utils"

/**
 * Marketing landing page — "Gece Sahası".
 *
 * The page is one continuous camera move through a floodlit halısaha complex, cut into chapters.
 * A fixed WebGL layer holds the world; everything here is the type laid over it. The `data-shot`
 * attributes are the contract between the two: each numbered section owns one waypoint on the
 * camera spline, and `components/three/scene.ts` reads them from the DOM rather than keeping a
 * second copy of the running order that could fall out of step with this file.
 *
 * Two things this page will not do. It will not require WebGL — the gradient under the canvas is
 * the design, not a spinner, and the page reads completely without a triangle drawn. And it will
 * not move for a reader who has asked things not to: `prefers-reduced-motion` paints one composed
 * frame and never starts the loop.
 *
 * The session is read so the primary call to action matches reality for a signed-in visitor. An
 * "Üye ol" button shown to someone already logged in is the fastest way to look broken.
 */

interface Chapter {
  n: string
  key: string
  tr: string
  en: string
  /** The shot itself, captioned the way a photograph would be. */
  shot: string
  lede: string
  body: readonly string[]
  /** Which edge the type is composed against, so the picture keeps one side clear. */
  side: "left" | "right"
}

const CHAPTERS: readonly Chapter[] = [
  {
    n: "01",
    key: "saha",
    tr: "Saha",
    en: "The pitch",
    shot: "Saha kenarı · tel örgünün ardı",
    lede: "Boş saati bul, fiyatını gör, üstüne kilitle.",
    body: [
      "Şehir, tarih, format ve fiyat aralığına göre ara. Müsaitlik işletmenin kendi saat diliminde hesaplanır; kapalı saatler ve bakım blokları düşülür.",
      "Aynı saati iki kişinin alması uygulama katmanında değil, veritabanında engellenir. İkinci rezervasyon kabul edilmez — “önce ben tıkladım” tartışması olmaz.",
    ],
    side: "left",
  },
  {
    n: "02",
    key: "kadro",
    tr: "Kadro",
    en: "The squad",
    shot: "Kuzey kalenin arkası · ısınma",
    lede: "Takımlar beceriye göre kurulur, tahmine göre değil.",
    body: [
      "Her oyuncunun becerisi tek bir sayı değil, bir aralıktır: ortalama ve belirsizlik. Yeni oyuncunun reytingi hızlı oynar, oynadıkça yerine oturur.",
      "Kadro bölünürken beraberlik olasılığı en yüksek olan dizilim seçilir. Tek taraflı maçlar kendiliğinden azalır.",
    ],
    side: "right",
  },
  {
    n: "03",
    key: "mac",
    tr: "Maç",
    en: "Maç",
    shot: "Orta yuvarlak · ikinci devre",
    lede: "Skor sahadan girilir, herkesin ekranında görünür.",
    body: [
      "Canlı skor anlık yayınlanır. Maç bittiğinde sonucu taraflar bildirir; herkes bir kez bildirir ve bildirimi sonradan değiştiremez.",
      "Bildirimler çelişirse sonuç kadroya gider. Onay için üçte iki çoğunluk ve her iki taraftan en az bir oyuncu gerekir; oy verilen skorun özeti imzalanır, böylece onay o skora bağlanır.",
    ],
    side: "left",
  },
  {
    n: "04",
    key: "hesap",
    tr: "Hesap",
    en: "The settlement",
    shot: "Sahanın üstü · maç sonu",
    lede: "Para elden değil, aynı işlemde bölünür.",
    body: [
      "Ödeme Stripe üzerinden alınır. İşletme payı doğrudan işletmenin bağlı hesabına geçer, platform komisyonu aynı çekimde kesilir.",
      "İşletme paneli her rezervasyonun brütünü, komisyonu ve net hakedişi ayrı gösterir; ödemeler Stripe takviminde izlenir.",
    ],
    side: "right",
  },
]

interface Corridor {
  n: string
  title: string
  role: string
  body: string
  href: string
  cta: string
}

const CORRIDORS: readonly Corridor[] = [
  {
    n: "01",
    title: "Oyuncu",
    role: "player",
    body: "Saha ara, saati kilitle, maça katıl. Reytingin her maçta güncellenir ve profilinde belirsizlik payıyla birlikte görünür.",
    href: "/venues",
    cta: "Saha ara",
  },
  {
    n: "02",
    title: "Takım",
    role: "captain",
    body: "Kadro kur, forma numarası ver, kaptanlığı devret. Takımın reytingi oyuncularının reytinglerinden hesaplanır.",
    href: "/teams",
    cta: "Takımlara bak",
  },
  {
    n: "03",
    title: "İşletme",
    role: "venue_owner",
    body: "Sahalarını ve saatlerini tanımla, takvimini canlı gör, hakedişini Stripe takviminden takip et.",
    href: "/venue/onboarding",
    cta: "İşletmeni kaydet",
  },
]

interface Phase {
  n: string
  title: string
  duration: string
  body: string
}

const PHASES: readonly Phase[] = [
  { n: "01", title: "Ara", duration: "dakikalar", body: "Şehir, tarih ve format seç. Boş saatler fiyatıyla listelenir." },
  { n: "02", title: "Kilitle", duration: "anında", body: "Ödeme alındığı anda saat sana ayrılır. Kimse üstüne yazamaz." },
  { n: "03", title: "Kadroyu kur", duration: "maça kadar", body: "Oyuncuları çağır; takımlar beceriye göre dengelenir." },
  { n: "04", title: "Oyna", duration: "60–90 dk", body: "Skor canlı girilir, katılanlar aynı anda görür." },
  { n: "05", title: "Onayla", duration: "24 saat", body: "Sonuç bildirilir. Çelişirse kadro oylar, sonra reytingler işlenir." },
]

const FOOTER = [
  {
    heading: "Bölümler",
    links: [
      { label: "Saha", href: "#saha" },
      { label: "Kadro", href: "#kadro" },
      { label: "Maç", href: "#mac" },
      { label: "Hesap", href: "#hesap" },
    ],
  },
  {
    heading: "Oyuncu",
    links: [
      { label: "Saha ara", href: "/venues" },
      { label: "Maçlar", href: "/matches" },
      { label: "Takımlar", href: "/teams" },
      { label: "Rezervasyonlarım", href: "/bookings" },
    ],
  },
  {
    heading: "İşletme",
    links: [
      { label: "İşletmeni kaydet", href: "/venue/onboarding" },
      { label: "İşletme paneli", href: "/venue" },
      { label: "Takvim", href: "/venue/calendar" },
      { label: "Hakediş", href: "/venue/payouts" },
    ],
  },
  {
    heading: "Hesap",
    links: [
      { label: "Giriş yap", href: "/login" },
      { label: "Üye ol", href: "/signup" },
      { label: "Gizlilik", href: "/privacy" },
      { label: "Şartlar", href: "/terms" },
    ],
  },
] as const

/**
 * The hero headline, split so each word arrives on its own.
 *
 * The gap between words is a margin rather than a space character: each word is an
 * `inline-block` so it can be transformed independently, and an inline-block swallows the
 * whitespace at its own edge. A margin also keeps the line wrappable, which a non-breaking
 * space would not.
 */
const HERO_WORDS = [
  { text: "İki", gold: false },
  { text: "Kale", gold: false },
  { text: "·", gold: true },
  { text: "Two", gold: false },
  { text: "Goals", gold: false },
] as const

export default async function HomePage() {
  const session = await getSessionUser()
  const role = session?.profile.role ?? null
  const displayName = session?.profile.display_name ?? session?.profile.full_name ?? null

  const primaryCta = session
    ? { href: role === "venue_owner" ? "/venue" : "/dashboard", label: "Panele git" }
    : { href: "/signup", label: "Üye ol" }

  return (
    <div className="night relative flex min-h-dvh flex-col bg-background text-foreground">
      <NightPitch />

      <ChapterRail items={CHAPTERS.map((c) => ({ n: c.n, id: c.key, label: c.tr }))} />

      {/* The header floats on the scene. A solid bar would cut the sky off in a straight line
          across the top of every shot; a gradient lets the frame run to the edge. */}
      <SiteHeader
        role={role}
        displayName={displayName}
        className="border-transparent bg-transparent bg-gradient-to-b from-[#05070c] via-[#05070c]/70 to-transparent"
      />

      <main id="main" className="relative z-10 flex-1">
        {/* ---------------------------------------------------------------- hero */}
        <section data-shot="0" className="relative flex min-h-[100svh] flex-col justify-end">
          <div className="night-veil-y pointer-events-none absolute inset-0" aria-hidden="true" />
          <div className="night-veil pointer-events-none absolute inset-0" aria-hidden="true" />

          <div className="relative mx-auto w-full max-w-6xl px-6 pb-16 pt-28 lg:pb-24">
            <p className="label-eyebrow fade-rise" style={{ animationDelay: "120ms" }}>
              Türkiye · Amatör futbol · Gece
            </p>

            <h1 className="mt-8 max-w-4xl text-balance text-5xl font-light leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl">
              {HERO_WORDS.map((word, i) => (
                <span
                  key={word.text}
                  className={cn(
                    "word-rise",
                    i < HERO_WORDS.length - 1 && "mr-[0.26em]",
                    word.gold && "align-middle text-gold",
                  )}
                  style={{ animationDelay: `${260 + i * 115}ms` }}
                >
                  {word.text}
                </span>
              ))}
            </h1>

            <div className="rule fade-rise mt-10 max-w-4xl" style={{ animationDelay: "760ms" }} />

            <div className="mt-10 grid gap-10 lg:grid-cols-12">
              <p
                className="fade-rise max-w-xl text-pretty text-lg font-light leading-relaxed text-foreground/85 lg:col-span-7"
                style={{ animationDelay: "820ms" }}
              >
                Bir sahanın iki kalesi vardır, bir pazarın iki tarafı. Halısaha oyuncularla saha
                işletmelerini aynı yerde buluşturur: boş saat anında rezerve edilir, ödeme aynı
                işlemde bölünür, takımlar beceriye göre kurulur ve skor kimsenin tek başına
                değiştiremeyeceği şekilde onaylanır.
              </p>

              <dl
                className="fade-rise grid grid-cols-2 gap-x-8 gap-y-6 self-end lg:col-span-5"
                style={{ animationDelay: "920ms" }}
              >
                {[
                  { label: "Rezervasyon", value: "Anında" },
                  { label: "Ödeme", value: "Stripe" },
                  { label: "Eşleme", value: "TrueSkill" },
                  { label: "Skor", value: "Canlı" },
                ].map((stat) => (
                  <div key={stat.label} className="border-t border-foreground/15 pt-3">
                    <dt className="label-eyebrow">{stat.label}</dt>
                    <dd className="mt-1 text-xl font-light">{stat.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div
              className="fade-rise mt-12 flex flex-col gap-3 sm:flex-row"
              style={{ animationDelay: "1020ms" }}
            >
              <Button size="lg" asChild>
                <Link href={primaryCta.href}>{primaryCta.label}</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/venues">Saha ara</Link>
              </Button>
            </div>

            <div className="fade-rise mt-16 flex items-end gap-4" style={{ animationDelay: "1160ms" }}>
              <span className="scroll-tick" aria-hidden="true" />
              <p className="label-eyebrow pb-1">Aşağı kaydır</p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ the numbered spine */}
        {CHAPTERS.map((c, i) => {
          const right = c.side === "right"
          return (
            <section
              key={c.key}
              id={c.key}
              data-shot={i + 1}
              className="relative flex min-h-[128svh] scroll-mt-16 items-center"
            >
              <div
                className={cn(
                  "pointer-events-none absolute inset-0",
                  right ? "night-veil-r" : "night-veil",
                )}
                aria-hidden="true"
              />

              <div className="relative mx-auto w-full max-w-6xl px-6 py-24">
                <div className="grid gap-10 lg:grid-cols-12">
                  <div className={cn("lg:col-span-5", right && "lg:col-start-8")}>
                    <div className="flex items-baseline gap-4">
                      <p className="section-number">{c.n}</p>
                      <span aria-hidden="true" className="h-px flex-1 bg-foreground/15" />
                    </div>

                    <h2 className="mt-5 text-3xl font-light tracking-tight sm:text-4xl">
                      {c.tr}
                      <span className="mx-3 text-gold">·</span>
                      <span className="text-muted-foreground">{c.en}</span>
                    </h2>

                    <p className="mt-6 text-pretty text-lg font-light leading-relaxed text-foreground/85">
                      {c.lede}
                    </p>

                    <div className="mt-8 space-y-5">
                      {c.body.map((p) => (
                        <p
                          key={p.slice(0, 24)}
                          className="text-pretty text-sm leading-relaxed text-muted-foreground"
                        >
                          {p}
                        </p>
                      ))}
                    </div>

                    <p className="label-eyebrow mt-10 flex items-center gap-3">
                      <span aria-hidden="true" className="inline-block h-px w-6 bg-gold/70" />
                      {c.shot}
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )
        })}

        {/* ------------------------------------------------------------- corridors */}
        <section data-shot="5" className="relative flex min-h-[110svh] items-center">
          <div className="night-veil-y pointer-events-none absolute inset-0" aria-hidden="true" />

          <div className="relative mx-auto w-full max-w-6xl px-6 py-24">
            <p className="label-eyebrow">Üç giriş</p>
            <h2 className="mt-4 max-w-2xl text-3xl font-light tracking-tight sm:text-4xl">
              Platforma nereden girdiğin, ne gördüğünü belirler.
            </h2>

            <div className="mt-14 grid gap-px border border-foreground/15 bg-foreground/15 sm:grid-cols-3">
              {CORRIDORS.map((corridor) => (
                <div
                  key={corridor.role}
                  className="flex flex-col bg-[#05070c]/85 p-8 transition-colors duration-500 hover:bg-[#0b1220]/90"
                >
                  <p className="section-number">{corridor.n}</p>
                  <h3 className="mt-4 text-2xl font-light tracking-tight">{corridor.title}</h3>
                  <p className="mt-4 flex-1 text-pretty text-sm leading-relaxed text-muted-foreground">
                    {corridor.body}
                  </p>
                  <Link
                    href={corridor.href}
                    className="label-eyebrow mt-8 inline-flex items-center gap-2 text-gold transition-opacity hover:opacity-70"
                  >
                    {corridor.cta}
                    <span aria-hidden="true">→</span>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- closing */}
        <section data-shot="6" className="relative flex min-h-[100svh] items-center">
          <div className="night-veil-y pointer-events-none absolute inset-0" aria-hidden="true" />

          <div className="relative mx-auto w-full max-w-6xl px-6 py-24">
            <div className="frame-ticks relative max-w-3xl p-8">
              <h2 className="text-balance text-3xl font-light leading-tight tracking-tight sm:text-5xl">
                Sahayı tut, kadroyu kur, skoru kayda geçir.
              </h2>
              <p className="mt-6 max-w-xl text-pretty leading-relaxed text-muted-foreground">
                Işıklar sönene kadar oynanan her maç bir kayıt bırakır: kim oynadı, skor neydi,
                kim onayladı, para nereye gitti.
              </p>
              <div className="mt-10 flex flex-col gap-3 sm:flex-row">
                <Button size="lg" asChild>
                  <Link href={primaryCta.href}>{primaryCta.label}</Link>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <Link href="/venue/onboarding">İşletmeni kaydet</Link>
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/*
        Below this marker the canvas is fully covered and the render loop stops. What follows is
        dense reference material — the running order of a match, and the site index — which
        belongs on solid ground rather than over a moving picture.
      */}
      <div data-canvas-end className="relative z-10 bg-background">
        <section id="nasil-calisir" className="scroll-mt-16 border-t border-foreground/15">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
            <div className="grid gap-10 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <p className="label-eyebrow">Sıra</p>
                <h2 className="mt-4 text-3xl font-light tracking-tight sm:text-4xl">
                  Bir maç nasıl olur
                </h2>
                <p className="mt-5 max-w-sm text-pretty leading-relaxed text-muted-foreground">
                  Beş adım. Her adımın ne kadar sürdüğü baştan belli; hiçbiri elden yürütülmüyor.
                </p>
              </div>

              <ol className="lg:col-span-7 lg:col-start-6">
                {PHASES.map((phase) => (
                  <li
                    key={phase.n}
                    className="ruled-row grid grid-cols-[3rem_1fr_auto] items-baseline gap-4"
                  >
                    <span className="section-number">{phase.n}</span>
                    <div>
                      <h3 className="text-lg font-normal">{phase.title}</h3>
                      <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
                        {phase.body}
                      </p>
                    </div>
                    <span className="label-eyebrow nums whitespace-nowrap">{phase.duration}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <footer className="border-t border-foreground/15">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
              {FOOTER.map((col) => (
                <div key={col.heading}>
                  <h2 className="label-eyebrow">{col.heading}</h2>
                  <ul className="mt-4 space-y-2.5">
                    {col.links.map((link) => (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="rule mt-14 pt-6">
              <p className="label-eyebrow">
                Halısaha · İstanbul
                <span className="mx-3 text-gold">·</span>
                İki kale, tek saha
              </p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
