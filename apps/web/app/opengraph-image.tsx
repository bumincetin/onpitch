import { ImageResponse } from "next/og"

/**
 * app/opengraph-image.tsx — the card that appears when a link to the site is pasted into
 * WhatsApp, X or Slack.
 *
 * `metadata.twitter.card` in `layout.tsx` already declares `summary_large_image`, which without
 * this file promises an image that does not exist: the unfurl renders as a bare grey box. Since
 * matches are organised almost entirely by pasting links into group chats, that unfurl is the
 * app's most-seen surface, and it was empty.
 *
 * Drawn to match the landing scene rather than by loading a screenshot of it: a real render is
 * megabytes and would need regenerating whenever the scene changes.
 */
export const runtime = "edge"
export const alt = "OnPitch — saha kirala, maç kur, oyna"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          position: "relative",
          background: "linear-gradient(180deg, #05070c 0%, #0b1512 55%, #133b28 100%)",
          padding: 72,
        }}
      >
        {/* Two floodlight pools, the same warm sodium as NIGHT.lamp. */}
        <div
          style={{
            position: "absolute",
            top: -220,
            left: 60,
            width: 720,
            height: 720,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,230,184,0.20) 0%, rgba(255,230,184,0) 68%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -160,
            right: -40,
            width: 620,
            height: 620,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,230,184,0.14) 0%, rgba(255,230,184,0) 68%)",
          }}
        />
        {/* Touchline and centre circle, in perspective the way the pitch reads on the page. */}
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            width: 1200,
            height: 3,
            background: "rgba(255,230,184,0.35)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -190,
            left: 440,
            width: 320,
            height: 320,
            borderRadius: "50%",
            border: "3px solid rgba(255,230,184,0.30)",
          }}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              display: "flex",
              fontSize: 26,
              letterSpacing: 10,
              textTransform: "uppercase",
              color: "#ffe6b8",
            }}
          >
            Amatör Futbol
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 92,
              fontWeight: 700,
              color: "#f4fbf7",
              lineHeight: 1.05,
            }}
          >
            OnPitch
          </div>
          <div style={{ display: "flex", fontSize: 38, color: "#a8c9b8", lineHeight: 1.3 }}>
            Saha kirala, maç kur, oyna.
          </div>
        </div>
      </div>
    ),
    size,
  )
}
