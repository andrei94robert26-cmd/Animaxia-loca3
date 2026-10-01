/**
 * components/content.tsx — Content building blocks shared by every screen:
 *
 *   ContentCard    poster card (2:3) with rating badge — tap → /content/:id
 *   ContentRow     titled horizontal FlatList of ContentCards
 *   HeroCarousel   paging hero with overlay title/overview + Play/Details
 *   Thumb          image-or-fallback square
 *
 * All shapes follow the mobile BFF compact item { id, title, type, thumbnail,
 * rating, year } — see api/mobile.ts.
 */

import React, { useRef, useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, spacing, typography, typeColor } from '../theme';
import type { MobileItem } from '../api/mobile';
import { SectionHeader } from './Screen';

/* ---------------------------------- Thumb ---------------------------------- */

export function Thumb({
  uri,
  style,
  iconSize = 22,
}: {
  uri: string | null | undefined;
  style?: object | number | Array<object | number | undefined>;
  iconSize?: number;
}): React.JSX.Element {
  if (uri) {
    return <Image source={{ uri }} style={style as never} resizeMode="cover" />;
  }
  return (
    <View style={[style as never, styles.fallback]}>
      <Ionicons name="film-outline" size={iconSize} color={colors.roseSoft} />
    </View>
  );
}

/* -------------------------------- ContentCard ------------------------------- */

export function ContentCard({
  item,
  width = 108,
  reason,
}: {
  item: MobileItem;
  width?: number;
  reason?: string;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      style={[styles.card, { width }]}
      onPress={() => router.navigate(`/content/${item.id}` as never)}
    >
      <View style={[styles.posterWrap, { width }]}>
        <Thumb uri={item.thumbnail} style={styles.poster} iconSize={20} />
        {item.rating != null ? (
          <View style={styles.ratingBadge}>
            <Ionicons name="star" size={9} color={colors.amber} />
            <Text style={styles.ratingText}>{Number(item.rating).toFixed(1)}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {item.title}
      </Text>
      {reason ? (
        <Text style={styles.cardReason} numberOfLines={2}>
          {reason}
        </Text>
      ) : null}
    </Pressable>
  );
}

/* -------------------------------- ContentRow -------------------------------- */

export function ContentRow({ title, items }: { title: string; items: MobileItem[] }): React.JSX.Element | null {
  if (!items || items.length === 0) return null;
  return (
    <View>
      <SectionHeader title={title} />
      <FlatList
        data={items}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => String(item.id)}
        ItemSeparatorComponent={RowSeparator}
        renderItem={({ item }) => <ContentCard item={item} />}
      />
    </View>
  );
}

function RowSeparator(): React.JSX.Element {
  return <View style={{ width: spacing.md }} />;
}

/* ------------------------------- HeroCarousel ------------------------------- */

export function HeroCarousel({ items }: { items: MobileItem[] }): React.JSX.Element | null {
  const [page, setPage] = useState(0);
  const viewability = useRef({ viewAreaCoveragePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef((info: { viewableItems: ViewToken[] }) => {
    const first = info.viewableItems[0];
    if (first && typeof first.index === 'number') setPage(first.index);
  }).current;

  if (!items || items.length === 0) return null;

  return (
    <View>
      <FlatList
        data={items.slice(0, 5)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => String(item.id)}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewability}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title}`}
            style={styles.heroPage}
            onPress={() => router.navigate(`/content/${item.id}` as never)}
          >
            <Thumb uri={item.backdrop ?? item.thumbnail} style={styles.heroImage} iconSize={40} />
            <View style={styles.heroOverlay} />
            <View style={styles.heroTextWrap}>
              {item.type ? (
                <View style={[styles.typeChip, { backgroundColor: (typeColor[item.type] ?? colors.zinc) + '33' }]}>
                  <Text style={[styles.typeChipText, { color: typeColor[item.type] ?? colors.zinc }]}>
                    {String(item.type).toUpperCase()}
                  </Text>
                </View>
              ) : null}
              <Text style={styles.heroTitle} numberOfLines={2}>
                {item.title}
              </Text>
              {item.overview ? (
                <Text style={styles.heroOverview} numberOfLines={2}>
                  {item.overview}
                </Text>
              ) : null}
              <View style={styles.heroActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Play ${item.title}`}
                  style={styles.playButton}
                  onPress={() => router.navigate(`/player/${item.id}` as never)}
                >
                  <Ionicons name="play" size={14} color="#fff" />
                  <Text style={styles.playButtonText}>Play</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Details for ${item.title}`}
                  style={styles.detailsButton}
                  onPress={() => router.navigate(`/content/${item.id}` as never)}
                >
                  <Ionicons name="information-circle-outline" size={14} color={colors.text} />
                  <Text style={styles.detailsButtonText}>Details</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        )}
      />
      <View style={styles.dots}>
        {items.slice(0, 5).map((item, index) => (
          <View key={String(item.id)} style={[styles.dot, index === page && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

/* ---------------------------------- styles ---------------------------------- */

const styles = StyleSheet.create({
  fallback: { backgroundColor: colors.cardSoft, alignItems: 'center', justifyContent: 'center' },

  card: { gap: 6 },
  posterWrap: { position: 'relative' },
  poster: { width: '100%' as never, aspectRatio: 2 / 3, borderRadius: radii.md, backgroundColor: colors.cardSoft },
  ratingBadge: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: radii.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  ratingText: { color: colors.amber, fontSize: 10, fontWeight: '700' },
  cardTitle: { color: colors.text, fontSize: typography.small, fontWeight: '600' },
  cardReason: { color: colors.textDim, fontSize: typography.tiny, marginTop: -2 },

  heroPage: { width: '100%' as never, aspectRatio: 16 / 10, borderRadius: radii.lg, overflow: 'hidden' },
  heroImage: { width: '100%' as never, height: '100%' as never, backgroundColor: colors.cardSoft },
  heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5,5,10,0.62)' },
  heroTextWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    gap: 6,
  },
  typeChip: {
    alignSelf: 'flex-start',
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  typeChipText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  heroTitle: { color: '#fff', fontSize: 24, fontWeight: '800' },
  heroOverview: { color: 'rgba(244,244,245,0.85)', fontSize: typography.small },
  heroActions: { flexDirection: 'row', gap: spacing.sm, marginTop: 4 },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.rose,
    borderRadius: radii.pill,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  playButtonText: { color: '#fff', fontSize: typography.small, fontWeight: '700' },
  detailsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: radii.pill,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  detailsButtonText: { color: colors.text, fontSize: typography.small, fontWeight: '700' },

  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: spacing.md },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border },
  dotActive: { backgroundColor: colors.rose, width: 18 },
});
