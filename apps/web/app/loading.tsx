import { Skeleton } from "@/components/ui/skeleton"

/**
 * Root loading UI. Announced politely so a screen-reader user is told the page is working
 * instead of hearing a dozen unlabelled placeholder boxes (the Skeletons are aria-hidden).
 */
export default function Loading() {
  return (
    <main
      id="main"
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6"
    >
      <span className="sr-only">Yükleniyor</span>

      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div key={index} className="flex flex-col gap-3 rounded-lg border p-6">
            <Skeleton className="size-10 rounded-lg" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ))}
      </div>
    </main>
  )
}
