/**
 * feed/FeedList.tsx — Shared renderer for social activity items
 * (/api/social/feed/global | /personal).
 *
 * Activity card: avatar + username + verb + time-ago, content thumbnail +
 * title, preview line. Tap → /content/:id. Used by the Feed screen with
 * cursor-based infinite scroll handled by the parent (onEndReached).
 */

import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography, typeColor } from '../theme';
import type { Activity } from '../api/social';
import { Thumb } from '../components/content';

/* --------------------------------- helpers --------------------------------- */

const VERBS: Record<Activity['type'], string> = {
  comment: 'commented on',
  like: 'liked',
  content: 'added',
  user: 'joined Animaxia',
};

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const sec = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function Avatar({ uri, name }: { uri: string | null | undefined; name?: string }): React.JSX.Element {
  if (uri) {
    return <Thumb uri={uri} style={styles.avatar} iconSize={12} />;
  }
  return (
    <View style={[styles.avatar, styles.avatarFallback]}>
      <Text style={styles.avatarLetter}>{(name || '?').slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

/* --------------------------------- the list --------------------------------- */

export function FeedList({
  activities,
  onEndReached,
  loadingMore,
  hasMore,
}: {
  activities: Activity[];
  onEndReached?: () => void;
  loadingMore?: boolean;
  hasMore?: boolean;
}): React.JSX.Element {
  return (
    <FlatList
      data={activities}
      keyExtractor={(item, index) => `${item.type}-${item.id}-${index}`}
      onEndReached={hasMore ? onEndReached : undefined}
      onEndReachedThreshold={0.4}
      ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
      renderItem={({ item }) => {
        const contentId = item.content?.id;
        const pressable = item.type !== 'user' && contentId != null;
        return (
          <Pressable
            accessibilityRole={pressable ? 'button' : 'text'}
            accessibilityLabel={item.user ? `${item.user.username} ${VERBS[item.type]}` : VERBS[item.type]}
            disabled={!pressable}
            style={styles.card}
            onPress={() => pressable && router.navigate(`/content/${contentId}` as never)}
          >
            <View style={styles.topRow}>
              <Avatar uri={item.user?.avatar} name={item.user?.username} />
              <View style={styles.topText}>
                <Text style={styles.username} numberOfLines={1}>
                  {item.user?.username ?? 'Someone'}
                  <Text style={styles.verb}> {VERBS[item.type]}</Text>
                  {item.content?.title ? <Text style={styles.contentInline}> {item.content.title}</Text> : null}
                </Text>
                <Text style={styles.time}>{timeAgo(item.createdat)}</Text>
              </View>
              <View style={[styles.typeDot, { backgroundColor: typeColor[item.content?.type ?? 'mined'] ?? colors.zinc }]} />
            </View>

            {item.content ? (
              <View style={styles.contentRow}>
                <Thumb uri={item.content.thumbnail} style={styles.contentThumb} iconSize={14} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.contentTitle} numberOfLines={1}>
                    {item.content.title}
                  </Text>
                  {item.preview ? (
                    <Text style={styles.preview} numberOfLines={2}>
                      {item.preview}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : item.preview ? (
              <Text style={styles.preview} numberOfLines={2}>
                {item.preview}
              </Text>
            ) : null}
          </Pressable>
        );
      }}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.footer}>
            <Ionicons name="sync-outline" size={14} color={colors.textDim} />
            <Text style={styles.footerText}>loading more…</Text>
          </View>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: spacing.md,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 36, height: 36, borderRadius: 18 },
  avatarFallback: {
    backgroundColor: colors.roseDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { color: '#fff', fontWeight: '800', fontSize: typography.small },
  topText: { flex: 1, gap: 2 },
  username: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
  verb: { color: colors.textMuted, fontWeight: '500' },
  contentInline: { color: colors.roseSoft, fontWeight: '600' },
  time: { color: colors.textDim, fontSize: 10 },
  typeDot: { width: 8, height: 8, borderRadius: 4 },

  contentRow: { flexDirection: 'row', gap: spacing.md },
  contentThumb: { width: 78, height: 52, borderRadius: radii.sm },
  contentTitle: { color: colors.text, fontSize: typography.small, fontWeight: '700' },
  preview: { color: colors.textMuted, fontSize: typography.tiny, lineHeight: 16 },

  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: spacing.lg },
  footerText: { color: colors.textDim, fontSize: typography.tiny },
});

export default FeedList;
