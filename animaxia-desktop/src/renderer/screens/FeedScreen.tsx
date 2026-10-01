/**
 * screens/FeedScreen.tsx — The Animaxia feed (route /feed).
 *
 *   Global        public community activity — comments, likes, new titles
 *                 (GET /api/social/feed/global, cursor pagination)
 *   Personal (AI) the AI Cloud re-ranked stream with per-card "why" lines and
 *                 the weekly recap (GET /api/ai/personal/feed — auth, gates
 *                 itself with a SignInCard)
 *
 * The active tab lives in component state; the Global list is public, the
 * Personal tab shows the sign-in card until a session exists.
 */

import React, { useState } from 'react';
import { Tabs } from '@/components/primitives';
import { FeedList } from '@/feed/FeedList';
import { PersonalFeed } from '@/feed/PersonalFeed';

type FeedTab = 'global' | 'personal';

const TABS: { value: FeedTab; label: string }[] = [
  { value: 'global', label: 'Global' },
  { value: 'personal', label: 'Personal (AI)' },
];

export default function FeedScreen(): React.JSX.Element {
  const [tab, setTab] = useState<FeedTab>('global');

  return (
    <div className="stack" style={{ gap: 18 }}>
      <header className="row row--wrap">
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: 0.2 }}>Feed</h1>
          <p className="dim" style={{ margin: '2px 0 0', fontSize: 12.5 }}>
            Community activity on Animaxia — and your own stream, ranked by the AI Cloud.
          </p>
        </div>
      </header>

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'global' ? <FeedList /> : <PersonalFeed />}
    </div>
  );
}
