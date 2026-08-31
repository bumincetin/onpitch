"use client"

import * as React from "react"

/**
 * Minimal toast store — reducer + subscription, no external dependency.
 *
 * The state lives in a module-level store rather than a React context on purpose: siblings
 * call `toast({ title: "..." })` from event handlers, `useEffect`s and catch blocks that are
 * nowhere near a provider, and threading a context through all of them buys nothing. The
 * <Toaster /> mounted in app/layout.tsx subscribes to this store and is the only renderer.
 *
 * A toast is dismissed in two steps — `open: false` first, removal from the array after the
 * exit animation — so the leaving toast can animate instead of vanishing mid-transition.
 */

export type ToastVariant = "default" | "destructive" | "success" | "warning"

export interface ToastOptions {
  title?: React.ReactNode
  description?: React.ReactNode
  /** Usually a <ToastAction>; rendered on the trailing edge. */
  action?: React.ReactNode
  variant?: ToastVariant
  /** Auto-dismiss delay in ms. Pass `Infinity` for a toast the user must close. */
  duration?: number
}

export interface ToasterToast extends ToastOptions {
  id: string
  open: boolean
}

/** How many toasts may be on screen at once; older ones are pushed out. */
const TOAST_LIMIT = 3
/** Matches the exit animation in components/ui/toast.tsx. */
const TOAST_REMOVE_DELAY_MS = 200
const DEFAULT_DURATION_MS = 5000

type Action =
  | { type: "ADD_TOAST"; toast: ToasterToast }
  | { type: "UPDATE_TOAST"; id: string; toast: Partial<ToastOptions> }
  | { type: "DISMISS_TOAST"; id?: string }
  | { type: "REMOVE_TOAST"; id?: string }

export interface ToastState {
  toasts: ToasterToast[]
}

export function toastReducer(state: ToastState, action: Action): ToastState {
  switch (action.type) {
    case "ADD_TOAST":
      return { toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT) }

    case "UPDATE_TOAST":
      return {
        toasts: state.toasts.map((entry) =>
          entry.id === action.id ? { ...entry, ...action.toast } : entry,
        ),
      }

    case "DISMISS_TOAST":
      return {
        toasts: state.toasts.map((entry) =>
          action.id === undefined || entry.id === action.id ? { ...entry, open: false } : entry,
        ),
      }

    case "REMOVE_TOAST":
      if (action.id === undefined) return { toasts: [] }
      return { toasts: state.toasts.filter((entry) => entry.id !== action.id) }

    default:
      return state
  }
}

let memoryState: ToastState = { toasts: [] }
const listeners = new Set<(state: ToastState) => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function dispatch(action: Action): void {
  memoryState = toastReducer(memoryState, action)
  for (const listener of listeners) listener(memoryState)
}

function clearTimer(id: string): void {
  const handle = timers.get(id)
  if (handle !== undefined) {
    clearTimeout(handle)
    timers.delete(id)
  }
}

function scheduleRemoval(id: string): void {
  clearTimer(id)
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      dispatch({ type: "REMOVE_TOAST", id })
    }, TOAST_REMOVE_DELAY_MS),
  )
}

let counter = 0
function nextId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER
  return `toast-${counter}`
}

export interface ToastHandle {
  id: string
  dismiss: () => void
  update: (options: Partial<ToastOptions>) => void
}

/**
 * Show a toast. Safe to call from anywhere in the browser; on the server it is a no-op that
 * still returns a handle, so a shared helper does not have to branch on the runtime.
 */
export function toast(options: ToastOptions): ToastHandle {
  const id = nextId()

  const dismiss = (): void => {
    dispatch({ type: "DISMISS_TOAST", id })
    scheduleRemoval(id)
  }

  const update = (next: Partial<ToastOptions>): void => {
    dispatch({ type: "UPDATE_TOAST", id, toast: next })
  }

  if (typeof window === "undefined") {
    return { id, dismiss, update }
  }

  dispatch({ type: "ADD_TOAST", toast: { ...options, id, open: true } })

  const duration = options.duration ?? DEFAULT_DURATION_MS
  if (Number.isFinite(duration) && duration > 0) {
    setTimeout(dismiss, duration)
  }

  return { id, dismiss, update }
}

/** Dismiss one toast, or every toast when no id is given. */
export function dismissToast(id?: string): void {
  dispatch({ type: "DISMISS_TOAST", id })
  if (id === undefined) {
    for (const entry of memoryState.toasts) scheduleRemoval(entry.id)
  } else {
    scheduleRemoval(id)
  }
}

export interface UseToastResult extends ToastState {
  toast: typeof toast
  dismiss: (id?: string) => void
}

/**
 * Subscribe a component to the toast store. Only <Toaster /> needs the `toasts` array;
 * everything else can import `toast` directly and skip the subscription.
 */
export function useToast(): UseToastResult {
  const [state, setState] = React.useState<ToastState>(memoryState)

  React.useEffect(() => {
    listeners.add(setState)
    // A toast fired between render and effect would otherwise be missed.
    setState(memoryState)
    return () => {
      listeners.delete(setState)
    }
  }, [])

  return { ...state, toast, dismiss: dismissToast }
}
