import { Measure, SectionHead } from "@/components/dashboard/night-band"
import { loadVenueScorecard } from "@/lib/progress"
import { cn } from "@/lib/utils"
import { formatMinor } from "@halisaha/shared/domain"
import { TIER_COLORS, TIER_LABELS } from "@halisaha/shared/gamification"

/**
 * The venue owner's standing.
 *
 * Facility owners are users too and the retention problem is the same one players have: give
 * them a number that moves when they do the right thing, and say plainly what moves it.
 *
 * The score is deliberately legible rather than clever — ten points a paid booking, five a
 * distinct customer, minus fifteen for a cancellation and forty for a dispute. An owner can
 * work out their own arithmetic from the row of measures underneath, which is the difference
 * between a target and a mystery.
 *
 * Everything is derived from bookings that already exist. There is no second write path, no
 * table to keep in sync, and nothing to backfill.
 */

export interface VenueScorecardSectionProps {
  venueId: string
  currency?: string
  /** Rolling window, in days. Matches the range picker above it when one is in play. */
  days?: number
  n?: string
  className?: string
}

export async function VenueScorecardSection({
  venueId,
  currency = "try",
  days = 90,
  n = "03",
  className,
}: VenueScorecardSectionProps) {
  const card = await loadVenueScorecard(venueId, days)

  // Null means the RPC refused the caller or failed. Neither is worth an error banner on an
  // overview page that has already rendered the numbers that matter.
  if (!card) return null

  const tint = TIER_COLORS[card.tier]
  const toNextTier = card.nextTierAt === null ? null : Math.max(0, card.nextTierAt - card.score)

  return (
    <section className={cn(className)}>
      <SectionHead
        n={n}
        title="İşletme sıralaması"
        aside={
          <span
            className="font-mono text-[0.625rem] uppercase tracking-[0.12em]"
            style={{ color: tint }}
          >
            {TIER_LABELS[card.tier]}
          </span>
        }
      />

      <div className="mt-6 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <div className="flex items-baseline gap-3">
            <span className="nums text-5xl font-light leading-none" style={{ color: tint }}>
              {card.score}
            </span>
            <span className="label-eyebrow">puan</span>
          </div>

          {card.nextTierAt !== null ? (
            <>
              <div
                className="mt-5 h-px w-full bg-foreground/15"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={card.nextTierAt}
                aria-valuenow={card.score}
                aria-label="Sonraki seviyeye ilerleme"
              >
                <div
                  className="h-px"
                  style={{
                    width: `${Math.min(100, (card.score / card.nextTierAt) * 100)}%`,
                    backgroundColor: tint,
                  }}
                />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Bir üst seviyeye {toNextTier} puan kaldı. Ödenmiş rezervasyon 10, ilk kez gelen
                müşteri 5 puan; iptal 15, itiraz 40 puan götürür.
              </p>
            </>
          ) : (
            <p className="mt-5 text-sm text-muted-foreground">
              Son {card.windowDays} günün en üst seviyesi. Elde tutmak için iptalleri düşük tut.
            </p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:col-span-7 lg:col-start-6">
          <Measure label="Ödenmiş rezervasyon" value={card.paidBookings} />
          <Measure label="Tamamlandı" value={card.completedBookings} tone="teal" />
          <Measure label="Müşteri" value={card.distinctCustomers} />
          <Measure
            label="İptal edildi"
            value={card.cancelledBookings}
            tone={card.cancelledBookings > 0 ? "vermilion" : "default"}
          />
          <Measure
            label="İtirazlı"
            value={card.disputedBookings}
            tone={card.disputedBookings > 0 ? "vermilion" : "default"}
          />
          <Measure
            label="Net hakediş"
            value={formatMinor(card.netMinor, currency, "tr-TR")}
            tone="gold"
            hint={`Son ${card.windowDays} gün, platform komisyonu ve iadeler düşülmüş`}
          />
        </dl>
      </div>
    </section>
  )
}
