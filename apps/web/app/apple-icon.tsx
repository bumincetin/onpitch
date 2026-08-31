import { ImageResponse } from "next/og"

/**
 * app/apple-icon.tsx — the 180px home-screen icon iOS uses when the site is added to the dock.
 *
 * Same mark as `icon.tsx`, drawn for the size it actually gets: at 180px the halfway line and
 * the sodium glow read, where at 32px they would be noise. iOS applies its own mask and does not
 * honour transparency, so the background is painted edge to edge.
 *
 * Edge runtime, like `opengraph-image.tsx`. `@vercel/og` under the Node runtime resolves
 * its WASM payload through `fileURLToPath`, which throws `Invalid URL` on a Windows build
 * host — the icon then fails to prerender and takes the whole export down with it. Edge is
 * the runtime the library is built for; the cost is that the route renders on demand rather
 * than being prerendered, which for a cacheable PNG this size is nothing.
 */
export const runtime = "edge"

export const size = { width: 180, height: 180 }
export const contentType = "image/png"

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          background: "linear-gradient(160deg, #1d6a46 0%, #0f3d28 100%)",
        }}
      >
        {/* The floodlight pool, offset the way the landing scene's lamps fall. */}
        <div
          style={{
            position: "absolute",
            top: -40,
            left: -40,
            width: 180,
            height: 180,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,230,184,0.28) 0%, rgba(255,230,184,0) 70%)",
          }}
        />
        {/* Halfway line. */}
        <div
          style={{
            position: "absolute",
            top: 90,
            left: 0,
            width: 180,
            height: 3,
            background: "rgba(255,230,184,0.55)",
          }}
        />
        {/* Centre circle. */}
        <div
          style={{
            width: 92,
            height: 92,
            borderRadius: "50%",
            border: "6px solid #ffe6b8",
          }}
        />
      </div>
    ),
    size,
  )
}
