"use client"

/**
 * components/account/profile-style-form.tsx
 *
 * The bit of the account page that is about how you look: accent, pitch shot, tagline, number,
 * foot. The card above the controls is the live preview — every tap redraws it — and the form
 * saves through the same `PATCH /api/account` as the rest of the profile, changed fields only.
 *
 * The preview is `ProfileCard`, the same component the profile page renders, so what you see
 * is exactly what a teammate sees. No second, approximate version.
 */

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Check } from "lucide-react"

import { ProfileCard } from "@/components/profile/profile-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ACCENT_CHOICES } from "@/lib/profile/accent"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"
import {
  ACCENT_COLOR_LABEL,
  BANNER_SHOT_LABEL,
  DOMINANT_FEET,
  DOMINANT_FOOT_LABEL,
  JERSEY_NUMBER_MAX,
  JERSEY_NUMBER_MIN,
  PROFILE_BANNER_SHOTS,
  TAGLINE_MAX,
  type DominantFoot,
  type ProfileStyle,
} from "@onpitch/shared/profile"

export interface ProfileStyleFormProps {
  name: string
  avatarUrl: string | null
  city: string | null
  position: string | null
  role: string
  initial: ProfileStyle
  className?: string
}

/** Each shot as a small CSS composition — the picker must not mount six WebGL canvases. */
const SHOT_TILE: Record<(typeof PROFILE_BANNER_SHOTS)[number], string> = {
  stands: "radial-gradient(70% 60% at 50% 100%, rgba(255,201,120,.35), transparent 70%), linear-gradient(#05070c, #131c2b)",
  centre: "radial-gradient(50% 45% at 50% 50%, rgba(255,201,120,.4), transparent 70%), linear-gradient(#070b12, #1d2739)",
  goalmouth: "radial-gradient(40% 70% at 50% 20%, rgba(255,201,120,.35), transparent 70%), linear-gradient(#05070c, #0f1520)",
  touchline: "repeating-linear-gradient(90deg, rgba(246,241,231,.14) 0 1px, transparent 1px 9px), radial-gradient(60% 50% at 70% 60%, rgba(255,201,120,.3), transparent 70%), linear-gradient(#05070c, #131c2b)",
  aerial: "repeating-linear-gradient(0deg, rgba(246,241,231,.12) 0 1px, transparent 1px 12px), radial-gradient(50% 50% at 50% 50%, rgba(255,201,120,.25), transparent 70%), linear-gradient(#0a1018, #1d2739)",
  tunnel: "radial-gradient(35% 55% at 50% 30%, rgba(255,201,120,.45), transparent 70%), linear-gradient(#020305, #0f1520)",
}

export function ProfileStyleForm({ name, avatarUrl, city, position, role, initial, className }: ProfileStyleFormProps) {
  const router = useRouter()
  const [saved, setSaved] = useState<ProfileStyle>(initial)
  const [style, setStyle] = useState<ProfileStyle>(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = useMemo(() => {
    const keys = Object.keys(style) as (keyof ProfileStyle)[]
    return keys.filter((key) => style[key] !== saved[key])
  }, [style, saved])

  const set = useCallback(<K extends keyof ProfileStyle>(key: K, value: ProfileStyle[K]) => {
    setStyle((current) => ({ ...current, [key]: value }))
  }, [])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (dirty.length === 0) return
    setError(null)
    setPending(true)
    try {
      const body: Record<string, unknown> = {}
      for (const key of dirty) body[key] = style[key]
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      })
      const payload = (await response.json()) as ApiResponse<unknown>
      if (!isApiOk(payload)) {
        setError(payload.error.message)
        return
      }
      setSaved(style)
      toast({ title: "Görünüm kaydedildi", description: "Rengin ve kartın her yerde güncellendi.", variant: "success" })
      router.refresh()
    } catch {
      setError("Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.")
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className={cn("space-y-6", className)} noValidate>
      <ProfileCard
        name={name}
        avatarUrl={avatarUrl}
        style={style}
        city={city}
        position={position}
        role={role}
        size="preview"
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Kaydedilemedi</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={pending} className="space-y-6">
        {/* ---- accent ---- */}
        <div className="space-y-2">
          <Label>Rengin</Label>
          <p className="text-xs text-muted-foreground">
            Menünün altı, seviye halkan, kadrodaki avatarın ve mesaj baloncukların bu renkte olur.
          </p>
          <div role="radiogroup" aria-label="Vurgu rengi" className="flex flex-wrap gap-2">
            {ACCENT_CHOICES.map((choice) => {
              const on = style.accentColor === choice.name
              return (
                <button
                  key={choice.name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={ACCENT_COLOR_LABEL[choice.name]}
                  title={ACCENT_COLOR_LABEL[choice.name]}
                  onClick={() => set("accentColor", choice.name)}
                  className={cn(
                    "grid size-11 place-items-center rounded-full border-2 transition-transform",
                    on ? "scale-110 border-foreground" : "border-transparent hover:scale-105",
                  )}
                  style={{ backgroundColor: choice.swatch, boxShadow: on ? `0 0 24px ${choice.swatch}88` : undefined }}
                >
                  {on ? <Check className="size-5 text-[#05070c]" aria-hidden="true" /> : null}
                </button>
              )
            })}
          </div>
        </div>

        {/* ---- shot ---- */}
        <div className="space-y-2">
          <Label>Profilinin açıldığı kare</Label>
          <p className="text-xs text-muted-foreground">Profil sayfanın arkasındaki canlı saha hangi açıdan çekilsin.</p>
          <div role="radiogroup" aria-label="Saha karesi" className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {PROFILE_BANNER_SHOTS.map((shot) => {
              const on = style.bannerShot === shot
              return (
                <button
                  key={shot}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set("bannerShot", shot)}
                  className={cn(
                    "group flex min-h-[4.5rem] flex-col justify-end overflow-hidden rounded-md border p-2 text-left transition-colors",
                    on ? "border-user ring-2 ring-user" : "border-foreground/15 hover:border-foreground/40",
                  )}
                  style={{ backgroundImage: SHOT_TILE[shot] }}
                  title={BANNER_SHOT_LABEL[shot].hint}
                >
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#f6f1e7]">
                    {BANNER_SHOT_LABEL[shot].title}
                  </span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_8rem]">
          {/* ---- tagline ---- */}
          <div className="space-y-2">
            <Label htmlFor="tagline">Sloganın</Label>
            <Input
              id="tagline"
              value={style.tagline ?? ""}
              maxLength={TAGLINE_MAX}
              placeholder="Sol kanat, sağ ayak, geç kalmam."
              onChange={(event) => set("tagline", event.target.value.length ? event.target.value : null)}
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">
              {(style.tagline ?? "").length}/{TAGLINE_MAX}. Adının altında, kartında.
            </p>
          </div>

          {/* ---- number ---- */}
          <div className="space-y-2">
            <Label htmlFor="jersey">Numaran</Label>
            <Input
              id="jersey"
              inputMode="numeric"
              value={style.jerseyNumber ?? ""}
              placeholder="—"
              onChange={(event) => {
                const raw = event.target.value.replace(/\D/g, "").slice(0, 2)
                if (raw === "") return set("jerseyNumber", null)
                const n = Number.parseInt(raw, 10)
                set("jerseyNumber", Math.min(JERSEY_NUMBER_MAX, Math.max(JERSEY_NUMBER_MIN, n)))
              }}
              className="h-11 text-center font-mono text-lg"
            />
            <p className="text-xs text-muted-foreground">0–99</p>
          </div>
        </div>

        {/* ---- foot ---- */}
        <div className="space-y-2">
          <Label>Ayağın</Label>
          <div role="radiogroup" aria-label="Baskın ayak" className="grid grid-cols-4 gap-1">
            {[null, ...DOMINANT_FEET].map((foot) => {
              const on = style.dominantFoot === foot
              return (
                <button
                  key={foot ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set("dominantFoot", foot as DominantFoot | null)}
                  className={cn(
                    "min-h-11 rounded-md border text-sm transition-colors",
                    on ? "border-user bg-user/10 text-foreground" : "border-foreground/15 text-muted-foreground hover:bg-accent",
                  )}
                >
                  {foot ? DOMINANT_FOOT_LABEL[foot] : "Söylemem"}
                </button>
              )
            })}
          </div>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className="h-11 bg-user text-primary-foreground hover:bg-user/90" disabled={pending || dirty.length === 0}>
          {pending ? "Kaydediliyor…" : "Görünümü kaydet"}
        </Button>
        {dirty.length > 0 && !pending ? (
          <Button type="button" variant="ghost" className="h-11" onClick={() => setStyle(saved)}>
            Vazgeç
          </Button>
        ) : null}
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {dirty.length === 0 ? "Her şey kayıtlı." : `${dirty.length} kaydedilmemiş değişiklik.`}
        </p>
      </div>
    </form>
  )
}
