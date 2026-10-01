'use client';

/**
 * party-room.tsx — Watch party room (#/social/party/:id). Synchronized player
 * (host drives playback via realtime `party:control`, members follow with a
 * 1.5s drift tolerance), live chat with typing indicators, member presence
 * and a REST fallback for chat when the socket is down. Reuses the
 * player-view rendering approach (mp4 / m3u8 via hls.js, embeds without sync).
 */

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Crown,
  Loader2,
  LogIn,
  LogOut,
  MonitorPlay,
  RefreshCw,
  Send,
  Users,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/animaxia/api';
import { tokenStore, tryRefresh } from '@/lib/animaxia/platform';
import {
  createSocialSocket,
  social,
  type ChatMessage,
  type PartyState,
  type SocketMemberRow,
} from '@/lib/animaxia/social';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import type { PlayerSource } from '@/lib/animaxia/types';
import { useAuth } from '@/components/animaxia/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { Container } from '../section';
import { EmptyState, ErrorState, TypeBadge } from '../states';
import { UserAvatar, timeAgo } from './social-ui';
import { PartyVoteCard } from './party-vote'; // FAZA 34-c (WS4): vot „următoarea vizionare”
import { ChatQuickbar } from './chat-quickbar'; // FAZA 34-c (WS4): reacții rapide în chat
import type { Socket } from 'socket.io-client';

/* --------------------------------- helpers --------------------------------- */

interface PartyStateEvent {
  partyId: number;
  title: string;
  hostid: number;
  state: PartyState;
  members: SocketMemberRow[];
  degraded: boolean;
}

interface PartyControlEvent {
  partyId: number;
  action: 'play' | 'pause' | 'seek' | 'rate' | 'source';
  by: number;
  state: PartyState;
}

interface PartyChatEvent {
  partyId: number;
  message: ChatMessage;
  persisted?: boolean;
}

function isNotFound(message?: string | null): boolean {
  return Boolean(message && message.toLowerCase().includes('not found'));
}

function formatCode(code: string | undefined, masked: boolean): string {
  if (!code) return '······';
  return masked ? '••••••' : code.toUpperCase();
}

/* ---------------------------------- room ---------------------------------- */

export function PartyRoom({ partyId }: { partyId: number }) {
  const { user } = useAuth();
  const validId = Number.isInteger(partyId) && partyId > 0;

  const detail = useApi(`social-party-${partyId}`, () => social.partyDetail(partyId), { enabled: validId });
  const current = detail.data && detail.data.party.id === partyId ? detail.data : null;

  const [ended, setEnded] = useState(false);
  const [members, setMembers] = useState<SocketMemberRow[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typingUser, setTypingUser] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [lastPersisted, setLastPersisted] = useState<boolean | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [lastState, setLastState] = useState<PartyState | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingEmitRef = useRef(0);
  const lastStateRef = useRef<PartyState | null>(null);
  const seededRef = useRef(false);
  const isHostRef = useRef(false);

  const party = current?.party ?? null;
  const isHost = Boolean(user && party && party.host.id === user.id);
  const partyActive = Boolean(party && party.status === 'active') && !ended;

  /* Player sources — same client and rendering rules as player-view (with a
     source switcher: the host's switch broadcasts a `source` control). */
  const contentId = party?.content.id ?? 0;
  const player = useApi(`party-player-${contentId}`, () => api.player(contentId), { enabled: contentId > 0 });
  const playerData = player.data && player.data.content.id === contentId ? player.data : null;
  const [sourceIndex, setSourceIndex] = useState(0);
  const sources = playerData?.sources ?? [];
  const source: PlayerSource | null =
    sources.length > 0 ? sources[Math.min(sourceIndex, sources.length - 1)] : null;

  /* Reset the picked source when the underlying player payload changes. */
  useEffect(() => {
    setSourceIndex(0);
  }, [playerData]);

  /* TS2b: mini-fallback chain — on a native <video> error (or a 12s
     watchdog when the source never delivers data) advance LOCALLY to the
     next source; when the last one dies, an honest recovery card takes over
     below the player. Host sync/chat logic is untouched — the advance is
     local-only for every member (each client retries independently). */
  const [sourceFailed, setSourceFailed] = useState(false);

  useEffect(() => {
    setSourceFailed(false);
  }, [playerData, sourceIndex]);

  function advanceAfterFailure(reason: string): void {
    if (sourceIndex < sources.length - 1) {
      toast(`Sursa ${sourceIndex + 1} nu răspunde (${reason}) — trec la următoarea…`);
      setSourceIndex((i) => Math.min(i + 1, sources.length - 1));
    } else {
      setSourceFailed(true);
    }
  }

  /* 12s watchdog — fires only when a native source never reached
     readyState ≥ 2 (HAVE_CURRENT_DATA): a paused-but-loaded video passes. */
  useEffect(() => {
    if (!source || (source.type !== 'mp4' && source.type !== 'm3u8')) return undefined;
    const kind = source.type;
    const timer = setTimeout(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) {
        advanceAfterFailure(kind === 'mp4' ? 'fără date mp4' : 'fără date m3u8');
      }
    }, 12_000);
    return () => clearTimeout(timer);
  }, [source?.url, source?.type, sourceIndex, sources.length]);

  /* Sync isHost into a ref so socket handlers (registered once) stay fresh. */
  useEffect(() => {
    isHostRef.current = isHost;
  }, [isHost]);

  /* Seed local state from the REST detail (members / messages / state). */
  useEffect(() => {
    if (!current) return;
    setMembers(current.members.map((m) => ({ userid: m.userid, username: m.username, avatar: m.avatar, online: false })));
    setMessages(current.messages ?? []);
    setLastState(current.state);
    lastStateRef.current = current.state;
    seededRef.current = false;
  }, [current]);

  /* Apply a party state to the <video> element (seek + pause/play + rate). */
  function applyStateToVideo(state: PartyState): void {
    const v = videoRef.current;
    if (!v || !Number.isFinite(state.positionSec) || state.positionSec < 0) return;
    try {
      if (Math.abs(v.currentTime - state.positionSec) > 0.3 || v.readyState < 1) {
        v.currentTime = state.positionSec;
      }
    } catch {
      /* seeking before metadata is loaded — the loadedmetadata seed retries */
      return;
    }
    if (Number.isFinite(state.playbackRate) && state.playbackRate > 0) v.playbackRate = state.playbackRate;
    if (state.isPaused) v.pause();
    else v.play().catch(() => {});
  }

  /* Seed the video position once the join ack (or REST state) arrives. */
  function seedFromState(state: PartyState): void {
    lastStateRef.current = state;
    setLastState(state);
    if (seededRef.current) return;
    seededRef.current = true;
    if (state.positionSec <= 0.5 && state.isPaused) return; // nothing to seed
    applyStateToVideo(state);
  }

  /* Realtime socket — created for signed-in users while the party is active. */
  useEffect(() => {
    if (!user || !partyActive || !validId) return;

    /* Idempotent REST join (also keeps membership when the socket degrades). */
    social.partyJoin(partyId).catch(() => {
      /* silent — the socket join below retries membership too */
    });

    const socket = createSocialSocket();
    socketRef.current = socket;

    /* The realtime service finishes its per-connection bootstrap (an async
       profile fetch) before it registers the `party:join` handler — a join
       emitted the instant `connect` fires can land too early and be dropped.
       Join is idempotent server-side, so: emit immediately, re-emit on `hello`
       (server sends it right after bootstrap) and retry until the join ack
       (`party:state`) arrives. */
    let joinTimer: ReturnType<typeof setTimeout> | null = null;
    let joinAttempts = 0;
    let stateAcked = false;
    const emitJoin = (): void => {
      socket.emit('party:join', { partyId });
      joinAttempts += 1;
      if (!stateAcked && joinAttempts < 6 && !joinTimer) {
        joinTimer = setTimeout(() => {
          joinTimer = null;
          if (!stateAcked) emitJoin();
        }, 1500);
      }
    };

    socket.on('connect', () => {
      setSocketConnected(true);
      stateAcked = false;
      if (joinTimer) {
        clearTimeout(joinTimer);
        joinTimer = null;
      }
      joinAttempts = 0;
      emitJoin();
    });
    /* `hello` arrives after the server registered its handlers — a join sent
       here always reaches the listener (covers both first connect and any
       reconnect). */
    socket.on('hello', () => {
      if (!stateAcked) emitJoin();
    });
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('connect_error', (err: Error) => {
      setSocketConnected(false);
      /* Auth rejected (e.g. the access token expired mid-session): rotate
         once and re-arm the handshake for the next reconnection attempt. */
      if (!/token/i.test(err.message)) return;
      void (async () => {
        if (tokenStore.refresh) await tryRefresh().catch(() => {});
        socket.auth = tokenStore.access ? { token: tokenStore.access } : {};
      })();
    });

    socket.on('party:state', (d: PartyStateEvent) => {
      if (d.partyId !== partyId) return;
      stateAcked = true;
      if (joinTimer) {
        clearTimeout(joinTimer);
        joinTimer = null;
      }
      setMembers(d.members ?? []);
      seedFromState(d.state);
      if (d.degraded) toast('Serviciul realtime este în modul offline — este posibil ca mesajele să nu fie salvate');
    });

    socket.on('party:member-joined', (d: { partyId: number; user: SocketMemberRow }) => {
      if (d.partyId !== partyId) return;
      setMembers((prev) =>
        prev.some((m) => m.userid === d.user.userid)
          ? prev.map((m) => (m.userid === d.user.userid ? { ...m, online: true } : m))
          : [...prev, { ...d.user, online: true }],
      );
    });

    socket.on('party:member-left', (d: { partyId: number; user: { userid: number } }) => {
      if (d.partyId !== partyId) return;
      setMembers((prev) => prev.filter((m) => m.userid !== d.user.userid));
    });

    socket.on('party:control', (d: PartyControlEvent) => {
      if (d.partyId !== partyId) return;
      lastStateRef.current = d.state;
      setLastState(d.state);
      if (isHostRef.current) return; // the host drives — never loop back
      if (d.action === 'source' && Number.isInteger(d.state.sourceIndex) && d.state.sourceIndex >= 0) {
        setSourceIndex(d.state.sourceIndex);
      }
      const v = videoRef.current;
      if (!v) return;
      const drift = Number.isFinite(d.state.positionSec) ? Math.abs(v.currentTime - d.state.positionSec) : 0;
      if (d.action === 'seek' || d.action === 'source' || drift > 1.5) {
        try {
          v.currentTime = d.state.positionSec;
        } catch {
          /* not seekable yet */
        }
      }
      if (Number.isFinite(d.state.playbackRate) && d.state.playbackRate > 0 && d.state.playbackRate !== v.playbackRate) {
        v.playbackRate = d.state.playbackRate;
      }
      if (d.state.isPaused && !v.paused) v.pause();
      else if (!d.state.isPaused && v.paused) v.play().catch(() => {});
    });

    socket.on('party:chat', (d: PartyChatEvent) => {
      if (d.partyId !== partyId) return;
      setLastPersisted(d.persisted !== false);
      setTypingUser((current) => (current === d.message.user.username ? null : current));
      setMessages((prev) => {
        if (d.message.id != null && prev.some((m) => m.id === d.message.id)) return prev;
        const next = [...prev, d.message];
        return next.length > 200 ? next.slice(next.length - 200) : next;
      });
    });

    socket.on('party:typing', (d: { partyId: number; user: { userid: number; username: string } }) => {
      if (d.partyId !== partyId || !d.user) return;
      if (user && d.user.userid === user.id) return;
      setTypingUser(d.user.username);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => setTypingUser(null), 3000);
    });

    socket.on('party:error', (d: { code: string; message: string }) => {
      if (d.code === 'ended') {
        setEnded(true);
        toast('Această vizionare în grup s-a încheiat');
        return;
      }
      if (d.code === 'auth') return; // anon flow is handled by the sign-in prompt
      toast.error(d.message || 'Eroare de vizionare în grup');
    });

    return () => {
      if (joinTimer) clearTimeout(joinTimer);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setSocketConnected(false);
    };
  }, [user?.id, partyId, partyActive, validId, user]);
  /* NOTE: `user` is listed for identity freshness (same id, refreshed profile);
     the effect only ever creates one socket at a time. */

  /* Host: periodic state snapshot to the monolith (fire-and-forget, 10s). */
  useEffect(() => {
    if (!isHost || !partyActive) return;
    const timer = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      social
        .partySync(partyId, {
          positionSec: v.currentTime,
          isPaused: v.paused,
          playbackRate: Number.isFinite(v.playbackRate) && v.playbackRate > 0 ? v.playbackRate : 1,
          sourceIndex,
          updatedAt: new Date().toISOString(),
        })
        .then((res) => {
          lastStateRef.current = res.state;
        })
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, [isHost, partyActive, partyId, sourceIndex]);

  /* HLS (m3u8) sources — identical to player-view's dynamic hls.js attach. */
  useEffect(() => {
    const url = source?.url;
    const el = videoRef.current;
    if (source?.type !== 'm3u8' || !url || !el) return;
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('hls.js');
        const Hls = mod.default;
        if (cancelled) return;
        if (Hls.isSupported()) {
          const instance = new Hls({ enableWorker: true });
          instance.loadSource(url);
          instance.attachMedia(el);
          hls = instance;
        } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
          el.src = url;
        }
      } catch {
        /* hls failed to init */
      }
    })();
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [source?.type, source?.url]);

  /* Auto-scroll chat to the newest message. */
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, typingUser]);

  /* Clear the typing timer on unmount. */
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  /* ------------------------------ host controls ----------------------------- */

  function emitControl(action: 'play' | 'pause' | 'seek' | 'rate' | 'source', overrideIndex?: number): void {
    const socket = socketRef.current;
    const v = videoRef.current;
    if (!socket || !isHost) return;
    socket.emit('party:control', {
      partyId,
      action,
      positionSec: v?.currentTime ?? 0,
      playbackRate: v?.playbackRate ?? 1,
      sourceIndex: overrideIndex ?? sourceIndex,
    });
  }

  /** Host picks a different stream source — members follow via `source`. */
  function switchSource(nextIndex: number): void {
    setSourceIndex(nextIndex);
    if (isHost) emitControl('source', nextIndex);
  }

  /* --------------------------------- actions -------------------------------- */

  /* FAZA 34-c: parametru opțional — quickbar-ul de reacții trimite emoji-ul
     direct prin ACELAȘI flux (onSubmit-ul formularului apelează sendChat()
     fără argument → comportament byte-identic cu înainte). */
  function sendChat(bodyOverride?: string): void {
    const body = (bodyOverride ?? chatInput).trim();
    if (!body || !user) return;
    setChatInput('');
    const socket = socketRef.current;
    if (socket && socket.connected) {
      socket.emit('party:chat', { partyId, body });
      return;
    }
    /* REST fallback (socket down): optimistic append, replaced by the reply. */
    const temp: ChatMessage = {
      id: `tmp-${Date.now()}`,
      body,
      createdat: new Date().toISOString(),
      user: { id: user.id, username: user.username, avatar: user.avatar },
    };
    setMessages((prev) => [...prev, temp]);
    social
      .partySendMessage(partyId, body)
      .then((res) => {
        setLastPersisted(true);
        setMessages((prev) => prev.map((m) => (m.id === temp.id ? res.message : m)));
      })
      .catch((err) => {
        setMessages((prev) => prev.filter((m) => m.id !== temp.id));
        toast.error(err instanceof Error ? err.message : 'Nu am putut trimite mesajul');
      });
  }

  function handleChatInputChange(value: string): void {
    setChatInput(value);
    const socket = socketRef.current;
    const now = Date.now();
    if (socket && socket.connected && now - lastTypingEmitRef.current > 2000) {
      lastTypingEmitRef.current = now;
      socket.emit('party:typing', { partyId });
    }
  }

  async function copyInviteCode(): Promise<void> {
    if (!party?.code) return;
    try {
      await navigator.clipboard.writeText(party.code);
      setCopied(true);
      toast.success('Codul de invitație a fost copiat');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Clipboardul nu este disponibil în acest browser');
    }
  }

  async function leaveParty(): Promise<void> {
    if (leaving) return;
    setLeaving(true);
    try {
      socketRef.current?.emit('party:leave', { partyId });
      await social.partyLeave(partyId);
      if (isHost) toast('Vizionarea în grup s-a încheiat');
      else toast('Ai părăsit vizionarea în grup');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Nu am putut părăsi vizionarea în grup');
    } finally {
      navigate('/social');
    }
  }

  /* -------------------------------- rendering ------------------------------- */

  if (!validId) {
    return (
      <Container className="py-20">
        <EmptyState
          title="Vizionare în grup negăsită"
          message="URL-ului îi lipsește un id de vizionare valid."
          action={
            <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/social')}>
              Back to Social
            </Button>
          }
        />
      </Container>
    );
  }

  if (detail.loading && !current) {
    return (
      <Container className="py-8 sm:py-10">
        <div className="mx-auto w-full max-w-6xl space-y-5">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-6 w-72 max-w-full" />
              <Skeleton className="h-4 w-44" />
            </div>
            <Skeleton className="h-9 w-24 rounded-lg" />
          </div>
          <Skeleton className="aspect-video w-full rounded-2xl" />
          <div className="grid gap-5 lg:grid-cols-3">
            <Skeleton className="h-40 rounded-2xl lg:col-span-2" />
            <Skeleton className="h-64 rounded-2xl" />
          </div>
        </div>
      </Container>
    );
  }

  if (detail.error && !current) {
    if (isNotFound(detail.error)) {
      return (
        <Container className="py-20">
          <EmptyState
            title="Vizionare încheiată sau negăsită"
            message="Această vizionare în grup nu mai este activă."
            action={
              <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/social')}>
                <ArrowLeft aria-hidden /> Back to Social
              </Button>
            }
          />
        </Container>
      );
    }
    return (
      <Container className="py-20">
        <ErrorState message={detail.error} onRetry={detail.refetch} />
      </Container>
    );
  }

  if (!party) return null;

  if (ended || party.status !== 'active') {
    return (
      <Container className="py-20">
        <EmptyState
          icon={<Users className="h-6 w-6" aria-hidden />}
          title="Vizionare încheiată sau negăsită"
          message="This watch party has ended. Start a new one from the Social hub — or join another live party."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button className="bg-rose-600 font-bold hover:bg-rose-500" onClick={() => navigate('/social')}>
                <ArrowLeft aria-hidden /> Back to Social
              </Button>
              <Button variant="outline" className="border-white/15 bg-white/5 hover:bg-white/10" onClick={() => navigate(`/content/${party.content.id}`)}>
                Open {party.content.title}
              </Button>
            </div>
          }
        />
      </Container>
    );
  }

  const embedSource = source && (source.type === 'youtube' || source.type === 'iframe') ? source : null;

  return (
    <Container className="space-y-5 py-6 sm:py-8">
      {/* Header */}
      <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Button
              variant="outline"
              size="icon"
              aria-label="Înapoi la Social"
              onClick={() => navigate('/social')}
              className="shrink-0 border-white/15 bg-white/5 hover:bg-white/10"
            >
              <ArrowLeft aria-hidden />
            </Button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="min-w-0 truncate text-lg font-black tracking-tight text-white sm:text-xl">{party.title}</h1>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-bold text-rose-300">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-400" />
                  </span>
                  Live
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                <span className="inline-flex items-center gap-1.5">
                  <Crown className="h-3.5 w-3.5 text-amber-400" aria-hidden />
                  Host <span className="font-semibold text-zinc-200">{party.host.username}</span>
                </span>
                <button
                  type="button"
                  onClick={() => navigate(`/content/${party.content.id}`)}
                  className="font-semibold text-rose-300 underline decoration-rose-500/40 underline-offset-2 transition hover:text-rose-200"
                >
                  {party.content.title}
                </button>
                <TypeBadge type={party.content.type} />
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" aria-hidden /> {Math.max(members.length, party.members)}{' '}
                  {members.length === 1 ? 'member' : 'members'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Invite code: full for the host, masked for members */}
            <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-3 py-1.5" title="Cod de invitație">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Cod</span>
              <span className="font-mono text-sm font-bold tracking-[0.2em] text-zinc-100">
                {formatCode(party.code, !isHost)}
              </span>
            </div>
            {isHost && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyInviteCode()}
                className="border-white/15 bg-white/5 font-semibold hover:bg-white/10"
              >
                {copied ? <Check className="text-emerald-400" aria-hidden /> : <Copy aria-hidden />}
                Copiază codul de invitație
              </Button>
            )}
            {user && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void leaveParty()}
                disabled={leaving}
                className="border-rose-500/40 bg-rose-500/10 font-semibold text-rose-300 hover:bg-rose-500/20 hover:text-rose-200"
              >
                {leaving ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut aria-hidden />}
                Ieși
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        {/* Player + sync + members */}
        <div className="space-y-4 lg:col-span-2">
          {player.loading && !playerData ? (
            <Skeleton className="aspect-video w-full rounded-2xl" aria-busy="true" />
          ) : !source ? (
            <EmptyState
              icon={<MonitorPlay className="h-6 w-6" aria-hidden />}
              title="Nicio sursă de stream disponibilă"
              message="Acest titlu nu are încă un stream redabil — deschide pagina lui pentru a extrage o sursă, apoi revino."
              action={
                <Button
                  variant="outline"
                  className="border-white/15 bg-white/5 hover:bg-white/10"
                  onClick={() => navigate(`/content/${party.content.id}`)}
                >
                  Open title page
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              <div className="aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
                {source.type === 'mp4' && (
                  <video
                    ref={videoRef}
                    key={source.url}
                    controls
                    playsInline
                    className="h-full w-full"
                    src={source.url}
                    onPlay={() => emitControl('play')}
                    onPause={() => emitControl('pause')}
                    onSeeked={() => emitControl('seek')}
                    onRateChange={() => emitControl('rate')}
                    onError={() => advanceAfterFailure('eroare mp4')}
                    onLoadedMetadata={() => {
                      const st = lastStateRef.current;
                      if (!seededRef.current && st) {
                        seedFromState(st);
                      } else if (st && st.positionSec > 0.3) {
                        /* source switch: restore the party position */
                        try {
                          if (videoRef.current) videoRef.current.currentTime = st.positionSec;
                        } catch {
                          /* not seekable yet */
                        }
                      }
                    }}
                  />
                )}
                {source.type === 'm3u8' && (
                  <video
                    ref={videoRef}
                    controls
                    playsInline
                    className="h-full w-full"
                    onPlay={() => emitControl('play')}
                    onPause={() => emitControl('pause')}
                    onSeeked={() => emitControl('seek')}
                    onRateChange={() => emitControl('rate')}
                    onError={() => advanceAfterFailure('eroare m3u8')}
                    onLoadedMetadata={() => {
                      const st = lastStateRef.current;
                      if (!seededRef.current && st) {
                        seedFromState(st);
                      } else if (st && st.positionSec > 0.3) {
                        /* source switch: restore the party position */
                        try {
                          if (videoRef.current) videoRef.current.currentTime = st.positionSec;
                        } catch {
                          /* not seekable yet */
                        }
                      }
                    }}
                  />
                )}
                {source.type === 'youtube' && (
                  <iframe
                    key={source.url}
                    src={`${source.url}${source.url.includes('?') ? '&' : '?'}rel=0`}
                    title={party.content.title}
                    className="h-full w-full"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                )}
                {source.type === 'iframe' && (
                  <iframe
                    key={source.url}
                    src={source.url}
                    title="Player încorporat"
                    className="h-full w-full"
                    sandbox="allow-scripts; allow-same-origin; allow-presentation; allow-popups; allow-forms"
                    allowFullScreen
                    referrerPolicy="no-referrer"
                  />
                )}
              </div>

              {/* TS2b: honest recovery card — every listed source failed. */}
              {sourceFailed && (
                <div
                  role="alert"
                  className="rounded-xl border border-red-500/30 bg-red-500/[0.07] px-4 py-3 text-sm text-red-200"
                >
                  <p className="font-semibold">Sursa a picat — toate sursele listate au refuzat conexiunea.</p>
                  <p className="mt-1 text-xs leading-relaxed text-red-200/80">
                    Deschide titlul în playerul principal (lanțul complet de fallback FAZA 17 + watchdog) sau reîncearcă
                    sursele în party.
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => navigate(`/player/${party.content.id}`)}
                      className="h-8 bg-rose-600 text-xs font-bold hover:bg-rose-500"
                    >
                      Deschide în playerul principal
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setSourceIndex(0);
                        setSourceFailed(false);
                      }}
                      className="h-8 border-white/15 bg-white/5 text-xs font-semibold hover:bg-white/10"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reîncearcă sursele
                    </Button>
                  </div>
                </div>
              )}

              {embedSource && (
                <p className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-200/90">
                  Stream-urile încorporate nu pot fi sincronizate — gazda anunță redarea în chat.
                </p>
              )}

              {/* Source switcher — the host's pick broadcasts to the room */}
              {sources.length > 1 && (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Surse de stream">
                  {sources.map((s, i) => {
                    const isActive = source?.url === s.url && source?.type === s.type;
                    return (
                      <button
                        key={`${s.type}-${i}-${s.url}`}
                        type="button"
                        onClick={() => switchSource(i)}
                        aria-pressed={isActive}
                        className={cn(
                          'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
                          isActive
                            ? 'border-rose-500/60 bg-rose-600 text-white shadow-lg shadow-rose-900/30'
                            : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/25 hover:bg-white/10',
                        )}
                      >
                        {s.label || `${s.type} ${i + 1}`}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Sync bar */}
              <div className="flex flex-wrap items-center gap-2">
                {isHost ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-300">
                    <Crown className="h-3.5 w-3.5" aria-hidden />
                    Ești gazda — redarea ta îi sincronizează pe toți
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
                      Sincronizat cu gazda
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-zinc-400">
                      Gazdă: <span className="font-semibold text-zinc-200">{party.host.username}</span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => lastStateRef.current && applyStateToVideo(lastStateRef.current)}
                      disabled={!lastState}
                      className="h-7 border-white/15 bg-white/5 px-2.5 text-[11px] font-semibold hover:bg-white/10"
                    >
                      <RefreshCw aria-hidden /> Re-sincronizează acum
                    </Button>
                  </>
                )}
                {user && !socketConnected && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-300">
                    <WifiOff className="h-3.5 w-3.5" aria-hidden /> Se reconectează…
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Members */}
          <Card className="border-white/10 bg-white/[0.03]">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-zinc-400">
                <Users className="h-4 w-4 text-rose-400" aria-hidden />
                Membri ({Math.max(members.length, party.members)})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {members.length === 0 ? (
                <p className="text-sm text-zinc-500">Membrii apar aici pe măsură ce se conectează.</p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2" aria-label="Membrii vizionării">
                  {[...members]
                    .sort((a, b) => (a.userid === party.host.id ? -1 : b.userid === party.host.id ? 1 : a.username.localeCompare(b.username)))
                    .map((m) => (
                      <li
                        key={m.userid}
                        className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-black/20 px-3 py-2"
                      >
                        <span className="relative shrink-0">
                          <UserAvatar username={m.username} avatar={m.avatar} className="h-8 w-8" />
                          {m.online && (
                            <span
                              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0a0a10] bg-emerald-400"
                              title="Online"
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">{m.username}</span>
                        {m.userid === party.host.id && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">
                            <Crown className="h-3 w-3" aria-hidden /> Host
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* FAZA 34-c (WS4): coloana din dreapta — votul „următoarea vizionare”
            deasupra chat-ului. Wrapper pur aditiv (gridul rămâne 3 coloane,
            cardul de chat își păstrează clasele exact ca înainte). */}
        <div className="min-w-0 space-y-5">
          <PartyVoteCard partyId={partyId} contentId={contentId} isHost={isHost} onNavigate={(to) => navigate(to)} />

        {/* Chat */}
        <Card className="flex h-[480px] flex-col border-white/10 bg-white/[0.03] lg:h-[calc(100vh-16rem)] lg:min-h-[560px]">
          <CardHeader className="shrink-0 border-b border-white/10 pb-3">
            <CardTitle className="text-xs font-bold uppercase tracking-widest text-zinc-400">Chat-ul vizionării</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col gap-2 pt-3">
            <div
              ref={chatScrollRef}
              className="custom-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1"
              role="log"
              aria-label="Mesaje din chat-ul vizionării"
            >
              {messages.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-500">Încă niciun mesaj — salută camera.</p>
              ) : (
                messages.map((m, i) => {
                  const own = Boolean(user && m.user.id === user.id);
                  return (
                    <div key={m.id != null ? `m-${m.id}` : `i-${i}`} className={cn('flex flex-col', own ? 'items-end' : 'items-start')}>
                      <div className={cn('flex max-w-[85%] items-start gap-2', own && 'flex-row-reverse')}>
                        {!own && <UserAvatar username={m.user.username} avatar={m.user.avatar} className="h-7 w-7" />}
                        <div
                          className={cn(
                            'rounded-xl px-3 py-2 text-sm leading-relaxed break-words',
                            own ? 'bg-rose-600 text-white' : 'border border-white/10 bg-white/[0.05] text-zinc-200',
                          )}
                        >
                          {!own && <span className="mb-0.5 block text-[11px] font-bold text-zinc-400">{m.user.username}</span>}
                          {m.body}
                        </div>
                      </div>
                      <time className="mt-0.5 px-1 text-[10px] text-zinc-500" dateTime={m.createdat}>
                        {timeAgo(m.createdat)}
                      </time>
                    </div>
                  );
                })
              )}
              {typingUser && (
                <p className="px-1 text-xs italic text-zinc-500" aria-live="polite">
                  {typingUser} is typing…
                </p>
              )}
            </div>

            {user && lastPersisted === false && (
              <p className="shrink-0 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[11px] text-amber-200/90">
                Offline mode — message not saved
              </p>
            )}

            {/* FAZA 34-c: reacții rapide — refolosesc exact sendChat-ul inputului. */}
            <ChatQuickbar onSend={(emoji) => sendChat(emoji)} disabled={!user} />

            {user ? (
              <form
                className="flex shrink-0 items-center gap-2 pt-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendChat();
                }}
              >
                <label htmlFor="party-chat-input" className="sr-only">
                  Message the party
                </label>
                <Input
                  id="party-chat-input"
                  value={chatInput}
                  onChange={(e) => handleChatInputChange(e.target.value)}
                  placeholder={socketConnected ? 'Scrie grupului…' : 'Chat (offline — se trimite prin server)'}
                  maxLength={500}
                  autoComplete="off"
                  className="border-white/10 bg-black/40 text-sm text-zinc-100 placeholder:text-zinc-500"
                />
                <Button
                  type="submit"
                  size="icon"
                  aria-label="Trimite mesajul"
                  disabled={!chatInput.trim()}
                  className="shrink-0 bg-rose-600 font-bold text-white hover:bg-rose-500"
                >
                  <Send className="h-4 w-4" aria-hidden />
                </Button>
              </form>
            ) : (
              <div className="flex shrink-0 flex-col items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-center">
                <p className="text-sm text-zinc-400">Sign in to join the party and chat.</p>
                <Button
                  type="button"
                  size="sm"
                  className="bg-rose-600 font-bold text-white hover:bg-rose-500"
                  onClick={() => navigate('/auth')}
                >
                  <LogIn aria-hidden /> Sign in
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        </div>
      </div>
    </Container>
  );
}
