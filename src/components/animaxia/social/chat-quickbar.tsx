'use client';

/**
 * chat-quickbar.tsx — FAZA 34 (PLAN 100X · WS4): reacții rapide pentru
 * chat-ul de vizionare în grup. 6 emoji-uri trimise printr-un singur click
 * prin ACELAȘI flux de trimitere ca și inputul de chat (onSend refolosește
 * sendChat din party-room). Pur prezentatională: zero stare, zero fetch.
 */

const QUICK_EMOJIS: { emoji: string; label: string }[] = [
  { emoji: '😂', label: 'Trimite râs' },
  { emoji: '❤️', label: 'Trimite inimioară' },
  { emoji: '😮', label: 'Trimite uimire' },
  { emoji: '👏', label: 'Trimite aplauze' },
  { emoji: '🔥', label: 'Trimite foc' },
  { emoji: '🎬', label: 'Trimite clapper' },
];

export function ChatQuickbar({
  onSend,
  disabled,
}: {
  onSend: (emoji: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1"
      role="group"
      aria-label="Reacții rapide în chat"
    >
      {QUICK_EMOJIS.map((quick) => (
        <button
          key={quick.emoji}
          type="button"
          aria-label={quick.label}
          title={quick.label}
          disabled={disabled}
          onClick={() => onSend(quick.emoji)}
          className="h-8 w-8 rounded-lg text-lg leading-none transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60 disabled:pointer-events-none disabled:opacity-50"
        >
          <span aria-hidden>{quick.emoji}</span>
        </button>
      ))}
    </div>
  );
}
