"use client"

/**
 * components/account/avatar-upload.tsx
 *
 * Picks a photo, puts it in Supabase Storage, then hands the resulting public URL to
 * `PATCH /api/account`.
 *
 * The file goes straight from the browser to Storage rather than through a Next route: a 2 MB
 * multipart body through a serverless function buys nothing and costs a cold start. What the
 * server does get is the URL, and it re-derives everything it needs from that — origin, bucket,
 * owner folder, content type, byte length. The checks below are a fast "no" for the obvious
 * cases, not the boundary; see the header of `app/api/account/route.ts`.
 *
 * The object key is `<user id>/<random>.<ext>`. The user id prefix is what the storage policies
 * in `0002_rls.sql` §5.18 scope on — `(storage.foldername(name))[1] = (select auth.uid())::text`
 * on INSERT, UPDATE and DELETE — and it is what the API route checks the URL against. Nothing
 * server-side sees this key before the object exists, so those policies are the boundary, not
 * the code below. The random name means re-uploading never has to overwrite (so `upsert` stays
 * false and a CDN never serves the previous photo from cache).
 */

import { useCallback, useId, useRef, useState } from "react"
import { useRouter } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@halisaha/shared/domain"

/** Mirrors the ceiling enforced in `app/api/account/route.ts`. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const BUCKET = "avatars"

const ACCEPTED: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

const ACCEPT_ATTRIBUTE = Object.keys(ACCEPTED).join(",")

export interface AvatarUploadProps {
  userId: string
  /** Current `profiles.avatar_url`, or null. */
  avatarUrl: string | null
  /** Used for the initials placeholder and the image alt text. */
  displayName: string
  className?: string
}

interface AccountPatchResult {
  profile: { avatarUrl: string | null }
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? "?"
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : ""
  return `${first}${second}`.toUpperCase()
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AvatarUpload({ userId, avatarUrl, displayName, className }: AvatarUploadProps) {
  const router = useRouter()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const [preview, setPreview] = useState<string | null>(avatarUrl)
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const savePhotoUrl = useCallback(async (nextUrl: string | null): Promise<boolean> => {
    const response = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ avatarUrl: nextUrl }),
    })

    const payload = (await response.json()) as ApiResponse<AccountPatchResult>
    if (!isApiOk(payload)) {
      setError(payload.error.message)
      return false
    }

    setPreview(payload.data.profile.avatarUrl)
    return true
  }, [])

  const onFile = useCallback(
    async (file: File) => {
      setError(null)

      const extension = ACCEPTED[file.type]
      if (!extension) {
        setError("Choose a JPEG, PNG or WebP image.")
        return
      }
      if (file.size > MAX_AVATAR_BYTES) {
        setError(
          `That image is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_AVATAR_BYTES)}.`,
        )
        return
      }

      setBusy("upload")
      try {
        const supabase = createClient()
        const objectKey = `${userId}/${crypto.randomUUID()}.${extension}`

        const upload = await supabase.storage.from(BUCKET).upload(objectKey, file, {
          contentType: file.type,
          cacheControl: "3600",
          upsert: false,
        })

        if (upload.error) {
          // The most common cause in a fresh environment is a missing bucket, which is a
          // deployment problem rather than something the user did wrong. Say so.
          setError(
            /bucket/i.test(upload.error.message)
              ? "Bu kurulumda fotoğraf depolama henüz kurulmamış."
              : "The upload did not finish. Check your connection and try again.",
          )
          return
        }

        const {
          data: { publicUrl },
        } = supabase.storage.from(BUCKET).getPublicUrl(objectKey)

        const saved = await savePhotoUrl(publicUrl)
        if (saved) {
          toast({ title: "Fotoğraf updated", variant: "success" })
          // The header and the player page read `avatar_url` on the server.
          router.refresh()
        }
      } catch {
        setError("Something went wrong while uploading. Please try again.")
      } finally {
        setBusy(null)
        if (inputRef.current) inputRef.current.value = ""
      }
    },
    [router, savePhotoUrl, userId],
  )

  const onRemove = useCallback(async () => {
    setError(null)
    setBusy("remove")
    try {
      const saved = await savePhotoUrl(null)
      if (saved) {
        toast({ title: "Fotoğraf removed" })
        router.refresh()
      }
    } catch {
      setError("Could not reach the server. Please try again.")
    } finally {
      setBusy(null)
    }
  }, [router, savePhotoUrl])

  const pending = busy !== null

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          {preview ? (
            /* A plain <img>: an avatar_url can point at any origin the account has ever used —
               Supabase Storage today, an OAuth provider on an older row — and next/image
               hard-fails on a host that is not listed in next.config's remotePatterns. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={`${displayName} profile photo`}
              width={80}
              height={80}
              className="size-20 shrink-0 rounded-full border object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="grid size-20 shrink-0 place-items-center rounded-full border bg-muted text-lg font-semibold text-muted-foreground"
            >
              {initialsOf(displayName)}
            </span>
          )}

          <div className="space-y-1">
            <p className="text-sm font-medium">Profil fotoğrafı</p>
            <p className="text-xs text-muted-foreground">
              JPEG, PNG or WebP, up to {formatBytes(MAX_AVATAR_BYTES)}. Teammates see it on match
              rosters.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={ACCEPT_ATTRIBUTE}
            className="sr-only"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void onFile(file)
            }}
          />
          <Button
            asChild
            variant="outline"
            size="sm"
            className={cn(pending && "pointer-events-none opacity-50")}
          >
            <label htmlFor={inputId}>
              {busy === "upload" ? "Uploading…" : preview ? "Change photo" : "Upload photo"}
            </label>
          </Button>

          {preview ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => void onRemove()}>
              {busy === "remove" ? "Removing…" : "Remove"}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Bu fotoğraf yüklenemedi</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
