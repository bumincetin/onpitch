/**
 * app/(dashboard)/achievements/page.tsx
 *
 * The whole badge cabinet, grouped by tier.
 *
 * Grouping by tier rather than by progress is deliberate here, and the opposite of what the
 * dashboard slice does. On the dashboard the useful order is "what is nearly done"; on this
 * page the useful order is "what is there", because somebody who opens it is browsing rather
 * than checking.
 *
 * Nothing is hidden behind a spoiler. A badge whose criterion is secret is a badge nobody
 * pursues, and this product has no reason to run a treasure hunt.
 */

import type { Metadata } from "next"

import { NightBand, Measure, SectionHead } from "@/components/dashboard/night-band"
import { AchievementGrid } from "@/components/progress/achievement-grid"
import { loadMyProgress } from "@/lib/progress"
import {
  ACHIEVEMENT_TIERS,
  TIER_LABELS,
  formatXp,
  type AchievementTier,
} from "@onpitch/shared/gamification"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Rozetler",
  description: "Kazanılan ve kazanılabilecek tüm rozetler.",
}

const TIER_NUMBER: Record<AchievementTier, string> = {
  bronze: "01",
  silver: "02",
  gold: "03",
  platinum: "04",
}

export default async function AchievementsPage() {
  const progress = await loadMyProgress()

  if (!progress) {
    return (
      <div className="space-y-8 pb-10">
        <NightBand
          shot="goalmouth"
          eyebrow="Rozetler"
          title="Rozetler yüklenemedi"
          lede="Bir şeyler ters gitti. Sayfayı yenilemeyi dene."
        />
      </div>
    )
  }

  const unlocked = progress.achievements.filter((a) => a.unlockedAt !== null)
  const earnedXp = unlocked.reduce((sum, a) => sum + a.xpReward, 0)
  const availableXp = progress.achievements.reduce((sum, a) => sum + a.xpReward, 0)

  return (
    <div className="space-y-14 pb-10">
      <NightBand
        shot="goalmouth"
        eyebrow="Koleksiyon"
        title="Rozetler"
        lede="Her rozetin şartı açık yazılı. Kazandığında puanı otomatik işlenir; ayrıca bir şey yapman gerekmez."
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Measure label="Kazanılan" value={`${unlocked.length} / ${progress.achievements.length}`} />
          <Measure label="Rozetlerden XP" value={formatXp(earnedXp)} tone="gold" />
          <Measure label="Kalan XP" value={formatXp(Math.max(0, availableXp - earnedXp))} />
          <Measure label="Seviye" value={progress.level} />
        </dl>
      </NightBand>

      {ACHIEVEMENT_TIERS.map((tier) => {
        const inTier = progress.achievements.filter((a) => a.tier === tier)
        if (inTier.length === 0) return null

        const done = inTier.filter((a) => a.unlockedAt !== null).length

        return (
          <section key={tier}>
            <SectionHead
              n={TIER_NUMBER[tier]}
              title={TIER_LABELS[tier]}
              aside={
                <span className="label-eyebrow nums">
                  {done} / {inTier.length}
                </span>
              }
            />
            <div className="mt-6">
              <AchievementGrid achievements={inTier} />
            </div>
          </section>
        )
      })}
    </div>
  )
}
