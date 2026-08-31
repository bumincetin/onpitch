/**
 * components/progress/index.tsx
 *
 * The progression kit. Import from `@/components/progress`, never from the individual files —
 * the barrel is the contract the screens are written against, the same convention
 * `components/ui` and `components/match` follow.
 */

export { AchievementCard } from './achievement-card'
export { ChallengeRow, type ChallengeRowProps } from './challenge-row'
export { LeaderboardRow, measureFor, type LeaderboardRowProps } from './leaderboard-row'
export { CounterRow, LevelPlate, type LevelPlateProps } from './level-plate'
export { Eyebrow, HairlineBar, Measure, Rule, SectionHead } from './primitives'
export { FormRow, StreakStrip } from './streak-strip'
export { XpRow } from './xp-row'
