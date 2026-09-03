"use client"

import * as React from "react"
import Link from "next/link"
import { AlertTriangle } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

/**
 * Root error boundary.
 *
 * `error.digest` is the only detail rendered on purpose. Next replaces a server-side error's
 * message with an opaque digest in production precisely so stack traces and query fragments do
 * not reach the browser; echoing `error.message` here would hand that back to an attacker on
 * any route that failed while touching user data. The digest is enough to find the real trace
 * in the server logs.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  React.useEffect(() => {
    // Server-side errors are already logged by the runtime; this catches the client half.
    console.error("[onpitch] unhandled error", error.digest ?? error.message)
  }, [error])

  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 px-4 text-center"
    >
      <div
        aria-hidden="true"
        className="inline-flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive"
      >
        <AlertTriangle className="size-6" />
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Bir şeyler ters gitti</h1>
        <p className="text-muted-foreground">
          Islem tamamlanamadi. Tekrar denemek genelde yeterli oluyor; sorun surerse birkac dakika
          sonra yeniden dene.
        </p>
      </div>

      {error.digest ? (
        <Alert variant="destructive" className="text-left">
          <AlertTitle>Destek referansı</AlertTitle>
          <AlertDescription>
            <code className="font-mono text-xs">{error.digest}</code>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button onClick={reset}>Tekrar dene</Button>
        <Button variant="outline" asChild>
          <Link href="/">Ana sayfaya dön</Link>
        </Button>
      </div>
    </main>
  )
}
