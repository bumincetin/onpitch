import type { Metadata, Viewport } from "next"
import { JetBrains_Mono, Onest } from "next/font/google"

import { Toaster } from "@/components/ui/toaster"

import "./globals.css"

/**
 * Root layout.
 *
 * `latin-ext` is not optional here: the product is Turkish and the Latin subset alone has no
 * glyphs for ı, ş, ğ, ç, ö, ü — every venue name would fall back mid-word to a system face.
 */
const onest = Onest({
  subsets: ["latin", "latin-ext"],
  variable: "--font-sans",
  display: "swap",
  weight: ["300", "400", "500", "600"],
})

/**
 * Mono is not decoration here. Scores, money, ratings, kickoff times and section numbers all
 * need figures that line up in a column, and the uppercase tracked label that carries this
 * design's structure reads wrong in a proportional face.
 */
const jetbrains = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500"],
})

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "OnPitch — saha kirala, maç kur, oyna",
    template: "%s · OnPitch",
  },
  description:
    "Amatör futbol için çift taraflı pazar yeri: oyuncular boş saatleri anında rezerve eder, işletmeler takvimini ve ödemelerini tek panelden yönetir.",
  applicationName: "OnPitch",
  keywords: ["onpitch", "halisaha", "saha kiralama", "amator futbol", "mac organizasyonu", "rezervasyon"],
  openGraph: {
    type: "website",
    locale: "tr_TR",
    url: siteUrl,
    siteName: "OnPitch",
    title: "OnPitch — saha kirala, maç kur, oyna",
    description:
      "Boş saatleri anında rezerve et, ödemeyi güvenle böl, dengeli takımlarla oyna.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Halısaha",
    description: "Amatör futbol için saha rezervasyonu ve maç organizasyonu.",
  },
  robots: {
    index: true,
    follow: true,
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1512" },
  ],
}

/**
 * Applies the `.dark` class before first paint.
 *
 * There is no ThemeProvider in this app — the theme is one class on <html> and a localStorage
 * key. This runs synchronously in <head>, so the page never paints light and then flips, which
 * is the flash every provider-based setup spends a client bundle to avoid.
 */
const themeBootstrap = `(function(){try{var t=localStorage.getItem("onpitch-theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr" className={`${onest.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <a
          href="#main"
          className="sr-only-focusable absolute left-4 top-4 z-[200] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          İçeriğe atla
        </a>
        {children}
        <Toaster />
      </body>
    </html>
  )
}
