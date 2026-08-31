/**
 * components/match/index.tsx
 *
 * The match kit. Import from `@/components/match`, never from the individual files — the barrel is
 * what the screens are written against, and it is what stays stable when one of these is rewritten.
 *
 * Everything here is presentational: it reads the theme, and takes its data as props. The queries,
 * the writes and the realtime subscription live in the screens under `app/match/`.
 */

export {
  ConsensusCard,
  CanonicalizationError,
  canonicalizeJsonb,
  computeLocalDigest,
  parseConsensusPayload,
  sha256Hex,
  utf8Length,
  type ConsensusCardProps,
  type ConsensusPayloadShape,
  type ConsensusRoundState,
  type LocalDigest,
} from './consensus-card'
export {
  ErrorNotice,
  describeError,
  describeErrorText,
  type ErrorNoticeProps,
  type PlainError,
} from './error-notice'
export {
  MATCH_FORMAT_LABEL,
  MATCH_STATUS_META,
  MatchCard,
  hasScore,
  teamSizeFor,
  type MatchCardMatch,
  type MatchCardProps,
  type MatchStatusMeta,
} from './match-card'
export {
  RatingDelta,
  UncertaintyBar,
  certaintyFromSigma,
  type RatingDeltaProps,
  type RatingPoint,
  type UncertaintyBarProps,
} from './rating-delta'
export { RosterList, type RosterListProps, type RosterPlayer } from './roster-list'
export { Scoreboard, type ScoreboardProps } from './scoreboard'
export { ScoreStepper, type ScoreStepperProps } from './score-stepper'
