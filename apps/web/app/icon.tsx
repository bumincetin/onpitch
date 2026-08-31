import { ImageResponse } from "next/og"

/**
 * app/icon.tsx — the favicon, generated rather than committed.
 *
 * The app had no icon at all: browsers fell back to a blank page glyph, and an installed PWA
 * would have had nothing on the home screen. Generating it here rather than committing a `.ico`
 * keeps the mark in the same place as the palette it comes from — the floodlit turf of the
 * landing scene — so it cannot drift away from the design the way a binary asset does.
 *
 * It is a centre circle on night turf: legible at 16px, where a ball or a full pitch is mud.
 *
 * Edge runtime, like `opengraph-image.tsx`. `@vercel/og` under the Node runtime resolves
 * its WASM payload through `fileURLToPath`, which throws `Invalid URL` on a Windows build
 * host — the icon then fails to prerender and takes the whole export down with it. Edge is
 * the runtime the library is built for; the cost is that the route renders on demand rather
 * than being prerendered, which for a cacheable PNG this size is nothing.
 */
export const runtime = "edge"

export const size = { width: 32, height: 32 }
export const contentType = "image/png"

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // NIGHT.turfDark -> a lighter centre, the same vertical lift the pitch material has.
          background: "linear-gradient(160deg, #1d6a46 0%, #0f3d28 100%)",
          borderRadius: 7,
        }}
      >
        <div
          style={{
            width: 17,
            height: 17,
            borderRadius: "50%",
            // NIGHT.lamp, the floodlight colour.
            border: "2.5px solid #ffe6b8",
          }}
        />
      </div>
    ),
    size,
  )
}
