/**
 * components/booking/booking-status-badge.tsx
 *
 * One vocabulary for `public.booking_status` and `public.payment_status`, so the list, the
 * detail page and the receipt cannot describe the same row three different ways.
 *
 * No `'use client'`: these are pure functions of their props and render on the server with the
 * page that uses them.
 *
 * The two enums answer different questions and are shown as two badges rather than merged into
 * one. `status` is where the RESERVATION stands (does it hold the slot?), `payment_status` is
 * where the MONEY stands. They come apart routinely — a cancelled booking whose refund is still
 * processing is both `cancelled` and `partially_refunded` — and flattening them would hide the
 * half the customer is actually asking about.
 */

import { Badge, type BadgeProps } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Enums } from "@halisaha/shared/database"

type BadgeVariant = NonNullable<BadgeProps["variant"]>

export interface StatusMeta {
  label: string
  /** One sentence a customer can act on. Used as the badge's title and in detail panels. */
  description: string
  variant: BadgeVariant
}

/** Reservation state. */
export const BOOKING_STATUS_META: Readonly<Record<Enums<"booking_status">, StatusMeta>> = {
  pending: {
    label: "Tutuluyor",
    description: "Ödeme tamamlanana kadar saat sana ayrılır.",
    variant: "warning",
  },
  awaiting_payment: {
    label: "Ödeme bekleniyor",
    description: "Ödeme yapana kadar saat tutulur. Ödemezsen kendiliğinden serbest bırakılır.",
    variant: "warning",
  },
  confirmed: {
    label: "Onaylandı",
    description: "Ödendi ve rezerve edildi. Bu saat aralığında saha senin.",
    variant: "success",
  },
  completed: {
    label: "Oynadığı",
    description: "Bu rezervasyon geçmişte kaldı.",
    variant: "secondary",
  },
  cancelled: {
    label: "İptal edildi",
    description: "Saat serbest bırakıldı ve yeniden satışta.",
    variant: "outline",
  },
  refunded: {
    label: "İade edildi",
    description: "İptal edildi ve para kartına iade edildi.",
    variant: "secondary",
  },
  disputed: {
    label: "İtirazlı",
    description: "Bu rezervasyonda açık bir ödeme itirazı var. Destek ekibi seninle iletişime geçecek.",
    variant: "destructive",
  },
}

/** Money state. */
export const PAYMENT_STATUS_META: Readonly<Record<Enums<"payment_status">, StatusMeta>> = {
  requires_payment: {
    label: "Ödenmedi",
    description: "Henüz hiçbir karttan çekim yapılmadı.",
    variant: "warning",
  },
  processing: {
    label: "İşleniyor",
    description: "Bankan ödemeyi hâlâ onaylıyor. Bu genelde hızlı olur.",
    variant: "warning",
  },
  succeeded: {
    label: "Ödendi",
    description: "Ödeme tamamlandı.",
    variant: "success",
  },
  failed: {
    label: "Ödeme başarısız",
    description: "Çekim gerçekleşmedi, hiçbir tutar alınmadı.",
    variant: "destructive",
  },
  refunded: {
    label: "Tamamı iade edildi",
    description: "Tutarın tamamı ödemenin yapıldığı karta iade edildi.",
    variant: "secondary",
  },
  partially_refunded: {
    label: "Kısmen iade edildi",
    description: "Tutarın bir kısmı ödemenin yapıldığı karta iade edildi.",
    variant: "secondary",
  },
}

export interface BookingStatusBadgeProps {
  status: Enums<"booking_status">
  className?: string
}

export function BookingStatusBadge({ status, className }: BookingStatusBadgeProps) {
  const meta = BOOKING_STATUS_META[status]
  return (
    <Badge variant={meta.variant} className={cn("whitespace-nowrap", className)} title={meta.description}>
      {meta.label}
    </Badge>
  )
}

export interface PaymentStatusBadgeProps {
  status: Enums<"payment_status">
  className?: string
}

export function PaymentStatusBadge({ status, className }: PaymentStatusBadgeProps) {
  const meta = PAYMENT_STATUS_META[status]
  return (
    <Badge variant={meta.variant} className={cn("whitespace-nowrap", className)} title={meta.description}>
      {meta.label}
    </Badge>
  )
}
