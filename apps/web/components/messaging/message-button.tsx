/**
 * components/messaging/message-button.tsx
 *
 * "Mesaj gönder", as a plain link to `/messages/with/[id]`. That route opens or finds the
 * thread and redirects into it, so this needs no JavaScript and works from any server
 * component — a profile header, a roster line, a booking, a venue page.
 *
 * Render it only when the server has already asked `can_message()`; showing a button that lands
 * on a refusal is worse than no button. The route asks again anyway.
 */

import Link from "next/link"
import { MessageCircle } from "lucide-react"

import { cn } from "@/lib/utils"

export interface MessageButtonProps {
  userId: string
  label?: string
  variant?: "primary" | "outline" | "ghost" | "icon"
  className?: string
}

const VARIANT: Record<NonNullable<MessageButtonProps["variant"]>, string> = {
  primary: "h-11 gap-2 bg-user px-4 text-sm font-medium text-primary-foreground hover:brightness-110",
  outline: "h-11 gap-2 border border-foreground/20 px-4 text-sm font-medium hover:border-user hover:text-user",
  ghost: "h-11 gap-2 px-3 text-sm text-muted-foreground hover:text-foreground",
  icon: "size-11 text-muted-foreground hover:text-user",
}

export function MessageButton({ userId, label = "Mesaj gönder", variant = "outline", className }: MessageButtonProps) {
  return (
    <Link
      href={`/messages/with/${userId}`}
      aria-label={variant === "icon" ? label : undefined}
      title={variant === "icon" ? label : undefined}
      className={cn(
        "inline-flex items-center justify-center rounded-md transition-[color,border-color,filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        VARIANT[variant],
        className,
      )}
    >
      <MessageCircle className="size-4 shrink-0" aria-hidden="true" />
      {variant === "icon" ? null : label}
    </Link>
  )
}
