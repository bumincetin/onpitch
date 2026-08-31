"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const toastVariants = cva(
  "pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border p-4 pr-10 shadow-lg transition-all",
  {
    variants: {
      variant: {
        default: "border-border bg-background text-foreground",
        destructive: "border-destructive bg-destructive text-destructive-foreground",
        success: "border-success bg-success text-success-foreground",
        warning: "border-warning bg-warning text-warning-foreground",
      },
      state: {
        open: "animate-toast-in",
        closed: "animate-toast-out",
      },
    },
    defaultVariants: {
      variant: "default",
      state: "open",
    },
  },
)

export interface ToastProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof toastVariants> {}

/**
 * One toast surface. Presentation only — lifecycle lives in @/lib/use-toast.
 *
 * NOT itself a live region. The region has to be in the accessibility tree BEFORE the text is
 * inserted into it, or most screen readers announce nothing at all — and a Toast element and its
 * message enter the DOM in the same commit. `role="status"` + `aria-live="polite"` therefore sit
 * on `ToastViewport`, which is mounted once for the whole app from `app/layout.tsx`; each Toast
 * is plain content inside it.
 */
const Toast = React.forwardRef<HTMLDivElement, ToastProps>(
  ({ className, variant, state, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(toastVariants({ variant, state }), className)}
      {...props}
    />
  ),
)
Toast.displayName = "Toast"

const ToastTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm font-semibold leading-tight", className)} {...props} />
  ),
)
ToastTitle.displayName = "ToastTitle"

const ToastDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm opacity-90", className)} {...props} />
  ),
)
ToastDescription.displayName = "ToastDescription"

const ToastClose = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-label="Bildirimi kapat"
      className={cn(
        "absolute right-2 top-2 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
      {...props}
    >
      <X className="size-4" />
    </button>
  ),
)
ToastClose.displayName = "ToastClose"

const ToastAction = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center rounded-md border border-current bg-transparent px-3 text-xs font-medium opacity-90 transition-colors",
      "hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
))
ToastAction.displayName = "ToastAction"

/**
 * Fixed-position stack, and the app's ONE toast live region.
 *
 * Mounted once from `app/layout.tsx` (via `<Toaster />`), so it is present and empty long before
 * any toast is pushed into it — which is the condition assistive technology needs in order to
 * announce an insertion at all. `role="status"` + `aria-live="polite"` announces without stealing
 * focus, which matters because most toasts fire while the user is mid-form. A destructive toast
 * is announced politely too: assertive interrupts the screen reader mid-word, and the error is
 * also rendered inline by the form itself.
 *
 * `pointer-events-none` on the viewport keeps the empty area click-through; each Toast re-enables
 * pointer events for itself.
 */
const ToastViewport = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4",
        "sm:inset-x-auto sm:bottom-0 sm:right-0 sm:top-auto sm:max-w-sm sm:flex-col-reverse",
        className,
      )}
      {...props}
    />
  ),
)
ToastViewport.displayName = "ToastViewport"

export {
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
  ToastViewport,
  toastVariants,
}
