import Link from "next/link"
import { MapPinOff } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 px-4 text-center"
    >
      <div
        aria-hidden="true"
        className="inline-flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <MapPinOff className="size-6" />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">404</p>
        <h1 className="text-3xl font-bold tracking-tight">Bu sayfa sahada değil</h1>
        <p className="text-muted-foreground">
          Aradığın sayfa kaldırılmış, adresi değişmiş ya da hiç var olmamış olabilir.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button asChild>
          <Link href="/">Ana sayfaya dön</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/matches">Maçlarıma git</Link>
        </Button>
      </div>
    </main>
  )
}
