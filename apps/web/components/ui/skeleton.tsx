import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Loading placeholder. It is aria-hidden because assistive tech should hear the surrounding
 * live region ("Yukleniyor"), not a run of a dozen nameless empty boxes.
 */
const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  ),
)
Skeleton.displayName = "Skeleton"

export { Skeleton }
