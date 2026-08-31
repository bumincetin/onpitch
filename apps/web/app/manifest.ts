import type { MetadataRoute } from "next"

/**
 * app/manifest.ts
 *
 * What this buys, concretely: a player who adds Halısaha to their home screen gets a standalone
 * window with the app's own colours instead of a Safari chrome bar, and the two shortcuts below
 * take them straight to the two things anyone opens this app to do — find a slot tonight, or see
 * where they stand.
 *
 * `display: "standalone"` rather than `fullscreen`: the booking flow hands off to Stripe, and a
 * fullscreen PWA that loses the URL bar during a payment is a phishing-shaped experience even
 * when it is legitimate.
 *
 * `orientation` is deliberately unset. The 3D scenes are built for portrait but a venue owner
 * reading the payouts table on a tablet in landscape is a real thing, and locking orientation
 * also overrides a device's accessibility rotation setting.
 *
 * The icons point at the routes `icon.tsx` and `apple-icon.tsx` generate; there are no binary
 * assets to fall out of sync with the palette.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Halısaha — saha kirala, maç kur, oyna",
    short_name: "Halısaha",
    description:
      "Amatör futbol için saha rezervasyonu, maç organizasyonu ve şehir ligleri. Boş saatleri anında ayırt, ödemeyi güvenle böl, dengeli takımlarla oyna.",
    start_url: "/",
    // A launched PWA lands on the dashboard for a signed-in player and gets redirected to the
    // login page otherwise, which is the correct behaviour in both cases.
    scope: "/",
    display: "standalone",
    // Matches the `--surface` the night theme paints, so the splash screen does not flash white.
    background_color: "#0b1512",
    theme_color: "#0b1512",
    lang: "tr-TR",
    dir: "ltr",
    categories: ["sports", "lifestyle", "social"],
    icons: [
      {
        src: "/icon",
        sizes: "32x32",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        // "any" rather than "maskable": the mark has no safe-zone padding, and a maskable hint
        // would let Android crop the centre circle into a sliver.
        purpose: "any",
      },
    ],
    shortcuts: [
      {
        name: "Saha bul",
        short_name: "Sahalar",
        description: "Bu akşam boş olan sahaları gör",
        url: "/venues",
      },
      {
        name: "Gelişimim",
        short_name: "Gelişim",
        description: "Seviyeni, serini ve lig sıranı gör",
        url: "/dashboard",
      },
    ],
  }
}
