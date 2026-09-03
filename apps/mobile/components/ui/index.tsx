/**
 * components/ui/index.tsx
 *
 * The primitive kit. Import from `@/components/ui`, never from the individual files — the barrel
 * is the contract the screens are written against, and it is the thing that stays stable when one
 * of these components is rewritten.
 *
 * Everything here reads its colours from `useTheme()`, so all of it follows the OS light/dark
 * setting without a prop.
 */

export { Avatar, initialsOf, type AvatarProps, type AvatarSize } from './avatar'
export { Badge, type BadgeProps, type BadgeTone } from './badge'
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './button'
export { Card, type CardProps } from './card'
export { EmptyState, type EmptyStateProps } from './empty-state'
export { Field, type FieldProps } from './field'
export { NightBand, type NightBandProps } from './night-band'
export { Notice, NoticeBullet, type NoticeProps, type NoticeTone } from './notice'
export { Screen, type ScreenProps } from './screen'
export { Separator, type SeparatorProps } from './separator'
export { Sheet, type SheetProps } from './sheet'
export { Spinner, type SpinnerProps } from './spinner'
export { Heading, Text, toneColor, type TextProps, type TextTone } from './text'
export { Toggle, type ToggleProps } from './toggle'
