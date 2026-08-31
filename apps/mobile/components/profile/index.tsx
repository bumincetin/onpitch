/**
 * components/profile/index.tsx
 *
 * The profile kit. Import from `@/components/profile`, not from the individual files — the barrel
 * is what the screens are written against, and it is what stays stable when one of these is
 * rewritten.
 */

export {
  ConsentBanner,
  type ConsentBannerProps,
} from './consent-banner'
export {
  FormStrip,
  MatchHistory,
  resultOf,
  type FormStripProps,
  type MatchHistoryEntry,
  type MatchHistoryProps,
  type MatchResult,
} from './match-history'
export {
  HISTORY_LIMIT,
  loadPlayerHistory,
  type PlayerHistory,
} from './player-history'
export { PrivacyToggle, type PrivacyToggleProps } from './privacy-toggle'
export { RatingCard, type PlayerRating, type RatingCardProps } from './rating-card'
export { ScreenHeader, type ScreenHeaderProps } from './screen-header'
export { StatsGrid, type StatsGridProps } from './stats-grid'
export {
  MU_PRIOR,
  SIGMA_FLOOR,
  SIGMA_PRIOR,
  UncertaintyBar,
  certaintyFromSigma,
  conservativeRating,
  directionOf,
  formatRating,
  formatSigma,
  formatSigned,
  type Direction,
  type UncertaintyBarProps,
} from './uncertainty-bar'
export {
  displayNameOf,
  myProfileSchema,
  useMyProfile,
  type MyProfile,
  type MyProfileState,
} from './use-my-profile'
