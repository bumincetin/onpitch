import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge Tailwind class names.
 *
 * `clsx` resolves the conditional/array/object forms; `twMerge` then drops earlier classes
 * that a later one overrides in the same Tailwind group, so a caller's `className="px-8"`
 * actually beats a component's built-in `px-4` instead of losing to source order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
