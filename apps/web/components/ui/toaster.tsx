"use client"

import * as React from "react"

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"
import { useToast } from "@/lib/use-toast"

/**
 * The single subscriber to the toast store. Mounted once in app/layout.tsx; anything that
 * needs to say something calls `toast()` from @/lib/use-toast and this renders it.
 */
export function Toaster(): React.JSX.Element {
  const { toasts, dismiss } = useToast()

  return (
    <ToastViewport>
      {toasts.map(({ id, title, description, action, variant, open }) => (
        <Toast key={id} variant={variant ?? "default"} state={open ? "open" : "closed"}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {title ? <ToastTitle>{title}</ToastTitle> : null}
            {description ? <ToastDescription>{description}</ToastDescription> : null}
          </div>
          {action}
          <ToastClose onClick={() => dismiss(id)} />
        </Toast>
      ))}
    </ToastViewport>
  )
}
