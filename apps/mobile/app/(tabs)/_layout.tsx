/**
 * app/(tabs)/_layout.tsx
 *
 * The signed-in shell: Matches, Book, Profile.
 *
 * It guards the group as well as decorating it. `app/index.tsx` handles the normal entry, but a
 * deep link — a push notification, an emailed booking confirmation — can land directly on a tab,
 * and this is the only thing standing between that link and a screen full of empty queries.
 *
 * The splash below is not redundant with the one in `app/_layout.tsx`. The root splash covers the
 * first read of the stored session; this one covers a re-check after the app is resumed from the
 * background with an expired token.
 *
 * THE FOUR TAB SCREENS LIVE IN SIBLING FILES: `progress.tsx` (Panel), `index.tsx` (Matches),
 * `book.tsx`, `profile.tsx`. Renaming one without updating the matching `Tabs.Screen` below
 * silently drops it from the bar.
 *
 * Panel is first because it is the screen with a reason to be opened when nothing else is
 * happening: a streak that is about to lapse, an objective one match from done, a badge two
 * goals away. Matches answers "what am I doing tonight", which is a question people arrive
 * already knowing the answer to.
 *
 * Icons are drawn from views rather than pulled from an icon font. It keeps the dependency list
 * to the pinned set, and three shapes tint correctly in both themes with no asset pipeline.
 *
 * THE UNREAD BADGE IS OWNED HERE, NOT BY THE PROFILE SCREEN. `lazy` defaults to true in
 * @react-navigation/bottom-tabs, so a tab's own component is not mounted until the tab is first
 * opened — a badge published from inside `profile.tsx` therefore never appears on a cold launch,
 * which is the one moment it matters. The count is a shared, reference-counted subscription (see
 * lib/hooks/use-notifications.ts), so the Profile screen asking for the same number costs one
 * channel between them, not two.
 */

import { Redirect, Tabs } from 'expo-router'
import * as React from 'react'
import { View, type ColorValue } from 'react-native'

import { Screen, Spinner } from '@/components/ui'
import { useUnreadNotifications } from '@/lib/hooks/use-notifications'
import { useUnreadConversations } from '@/lib/messaging'
import { useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

/** Past this the exact number stops being useful and "9+" is easier to read at badge size. */
const BADGE_CEILING = 9

export default function TabsLayout(): React.ReactElement {
  const { session, loading } = useSession()
  const theme = useTheme()
  // Before the early returns below: hooks cannot be called conditionally.
  const unread = useUnreadNotifications()
  const unreadThreads = useUnreadConversations()

  const badge =
    unread.count === 0
      ? undefined
      : unread.count > BADGE_CEILING
        ? `${BADGE_CEILING}+`
        : unread.count

  const messagesBadge =
    unreadThreads.count === 0
      ? undefined
      : unreadThreads.count > BADGE_CEILING
        ? `${BADGE_CEILING}+`
        : unreadThreads.count

  if (loading) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']}>
        <Spinner centred label="Oturumun kontrol ediliyor" />
      </Screen>
    )
  }

  if (!session) {
    return <Redirect href="/(auth)/sign-in" />
  }

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleStyle: { color: theme.colors.foreground, fontWeight: '600' },
        headerShadowVisible: false,
        tabBarActiveTintColor: theme.colors.user,
        tabBarInactiveTintColor: theme.colors.mutedForeground,
        tabBarStyle: {
          backgroundColor: theme.colors.card,
          borderTopColor: theme.colors.border,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Tabs.Screen
        name="progress"
        options={{
          title: 'Panel',
          tabBarIcon: ({ color, focused }) => <ChevronIcon color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Maçlar',
          tabBarIcon: ({ color, focused }) => <BallIcon color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="book"
        options={{
          title: 'Saha',
          tabBarIcon: ({ color, focused }) => <CalendarIcon color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: 'Mesajlar',
          tabBarIcon: ({ color, focused }) => <BubbleIcon color={color} focused={focused} />,
          tabBarBadge: messagesBadge,
          tabBarBadgeStyle: {
            backgroundColor: theme.colors.user,
            color: '#05070C',
            fontSize: 11,
          },
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profil',
          tabBarIcon: ({ color, focused }) => <PersonIcon color={color} focused={focused} />,
          tabBarBadge: badge,
          tabBarBadgeStyle: {
            backgroundColor: theme.colors.destructive,
            color: theme.colors.destructiveForeground,
            fontSize: 11,
          },
        }}
      />
    </Tabs>
  )
}

interface IconProps {
  color: ColorValue
  focused: boolean
}

/** A rising step: three marks of increasing height, the same shape the streak strip draws. */
function ChevronIcon({ color, focused }: IconProps): React.ReactElement {
  return (
    <View style={{ width: 22, height: 22, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
      {[8, 13, 18].map((height, i) => (
        <View
          key={height}
          style={{
            width: 4,
            height,
            borderWidth: 1.5,
            borderColor: color,
            backgroundColor: focused && i === 2 ? color : 'transparent',
          }}
        />
      ))}
    </View>
  )
}

/** A ball: an outlined circle with a filled panel when the tab is active. */
function BallIcon({ color, focused }: IconProps): React.ReactElement {
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          borderWidth: 1.5,
          borderColor: color,
          backgroundColor: focused ? color : 'transparent',
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  )
}

/** A calendar: a rounded frame with a header rule that fills when the tab is active. */
function CalendarIcon({ color, focused }: IconProps): React.ReactElement {
  return (
    <View style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: 20,
          height: 19,
          borderRadius: 4,
          borderWidth: 2,
          borderColor: color,
          overflow: 'hidden',
        }}
      >
        <View style={{ height: 5, backgroundColor: color, opacity: focused ? 1 : 0.45 }} />
      </View>
    </View>
  )
}

/** A speech bubble: a rounded frame with a tail, filled when the tab is active. */
function BubbleIcon({ color, focused }: IconProps): React.ReactElement {
  return (
    <View style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: 20,
          height: 15,
          borderRadius: 6,
          borderWidth: 2,
          borderColor: color,
          backgroundColor: focused ? color : 'transparent',
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: 1,
          left: 5,
          width: 6,
          height: 6,
          borderLeftWidth: 2,
          borderBottomWidth: 2,
          borderColor: color,
          backgroundColor: focused ? color : 'transparent',
          transform: [{ rotate: '-20deg' }],
        }}
      />
    </View>
  )
}

/** A person: head over shoulders, both filled when the tab is active. */
function PersonIcon({ color, focused }: IconProps): React.ReactElement {
  return (
    <View style={{ width: 22, height: 22, alignItems: 'center', justifyContent: 'flex-end' }}>
      <View
        style={{
          position: 'absolute',
          top: 1,
          width: 9,
          height: 9,
          borderRadius: 4.5,
          borderWidth: 2,
          borderColor: color,
          backgroundColor: focused ? color : 'transparent',
        }}
      />
      <View
        style={{
          width: 18,
          height: 9,
          borderTopLeftRadius: 9,
          borderTopRightRadius: 9,
          borderWidth: 2,
          borderBottomWidth: 0,
          borderColor: color,
          backgroundColor: focused ? color : 'transparent',
        }}
      />
    </View>
  )
}
