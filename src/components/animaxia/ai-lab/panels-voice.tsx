'use client';

/**
 * ai-lab/panels-voice.tsx — FAZA 35 (WS5): AI Voice.
 * (1) Căutare vocală — înregistrare MediaRecorder (audio/webm) → base64 →
 *     transcriere z-ai → navigare către #/search?q=<text>.
 * (2) Descriere audio — TTS cu 7 voci, viteză 0.5-2.0, redare <audio> WAV.
 * Erori 503 oneste + fallback elegant când MediaRecorder lipsește (Safari/Firefox).
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Play, Search, Square, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { api, ApiError } from '@/lib/animaxia/api';
import { useApi } from '@/lib/animaxia/hooks';
import { navigate } from '@/lib/animaxia/router';
import { cn } from '@/lib/utils';
import { LabCard, LabNote, LabProviderBadge } from './lab-ui';

/** Voci fallback (contractul înghețat) — /voice/status le confirmă live. */
const FALLBACK_VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'];
const FALLBACK_MAX_CHARS = 1024;

function friendlyVoiceError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 503) return 'Serviciul vocal nu este disponibil momentan (providerul z-ai nu răspunde) — încearcă din nou mai târziu.';
    if (e.status === 400) return e.message || 'Cerere invalidă — verifică textul, vocea și viteza.';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Serviciul vocal a eșuat';
}

/* ------------------------------ căutare vocală ------------------------------ */

function VoiceSearchCard() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const supported =
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== 'undefined';

  useEffect(() => {
    if (!recording) return undefined;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recording]);

  /* Curățare la demontare: oprim microfonul și înregistrarea (fără
   * transcriere — componenta nu mai există, setState-ar fi un leak). */
  useEffect(() => {
    return () => {
      try {
        const rec = recorderRef.current;
        if (rec && rec.state !== 'inactive') {
          rec.onstop = null;
          rec.stop();
        }
        rec?.stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* best-effort */
      }
      recorderRef.current = null;
    };
  }, []);

  const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error('Audio-ul nu a putut fi citit'));
      reader.readAsDataURL(blob);
    });

  const transcribe = async (blob: Blob) => {
    setProcessing(true);
    setError(null);
    try {
      const b64 = await blobToBase64(blob);
      const r = await api.aiLabVoiceAsr(b64);
      setText(r.text);
      setProvider(r.provider);
      toast.success('Transcriere gata', { description: `„${r.text.slice(0, 80)}${r.text.length > 80 ? '…' : ''}"` });
    } catch (e) {
      const msg = friendlyVoiceError(e);
      setError(msg);
      toast.error('Transcrierea vocală a eșuat', { description: msg });
    } finally {
      setProcessing(false);
    }
  };

  const start = async () => {
    setError(null);
    setText(null);
    setProvider(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        if (blob.size > 0) void transcribe(blob);
      };
      rec.start();
      recorderRef.current = rec;
      setSeconds(0);
      setRecording(true);
    } catch {
      setError('Microfonul nu a putut fi accesat — verifică permisiunile browserului.');
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  return (
    <LabCard title="🎤 Căutare vocală" hint="Vorbește liber — transcriem și căutăm în catalog">
      {!supported ? (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-3.5 text-sm leading-relaxed text-amber-100/90">
          🎙️ Browserul tău nu suportă înregistrarea audio (MediaRecorder). Încearcă Chrome/Edge sau folosește
          căutarea normală — restul AI Lab rămâne disponibil.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => (recording ? stop() : void start())}
              disabled={processing}
              className={cn(
                'h-11 font-bold',
                recording ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500',
              )}
              aria-label={recording ? 'Oprește înregistrarea' : 'Pornește înregistrarea vocală'}
            >
              {recording ? (
                <Square className="mr-1.5 h-4 w-4 fill-white" aria-hidden />
              ) : processing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Mic className="mr-1.5 h-4 w-4" aria-hidden />
              )}
              {recording ? `Oprește (${seconds}s)` : processing ? 'Se transcrie…' : 'Vorbește'}
            </Button>
            {recording ? (
              <span className="flex items-center gap-1.5 text-xs font-semibold text-rose-300" aria-live="polite">
                <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" aria-hidden />
                Se înregistrează… cronometru {seconds}s
              </span>
            ) : null}
          </div>
          {text != null ? (
            <div className="space-y-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-sm text-zinc-100">
                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-300/90">Transcriere: </span>
                  „{text}"
                </p>
                {provider ? <LabProviderBadge provider={provider} /> : null}
              </div>
              <Button
                onClick={() => navigate(`/search?q=${encodeURIComponent(text)}`)}
                className="h-11 bg-rose-600 font-bold hover:bg-rose-500"
              >
                <Search className="mr-1.5 h-4 w-4" aria-hidden />
                Caută „{text.length > 24 ? `${text.slice(0, 24)}…` : text}"
              </Button>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-rose-200">
              {error}
            </div>
          ) : null}
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Apasă „Vorbește", rostește titlul (ex. „thrillere coreene"), oprește — AI-ul transcrie audio-ul și
            pornește căutarea. Audio-ul e folosit doar pentru transcriere.
          </p>
        </div>
      )}
    </LabCard>
  );
}

/* ------------------------------ descriere audio ----------------------------- */

function TtsCard() {
  const statusRes = useApi('ai-lab-voice-status', () => api.aiLabVoiceStatus());
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<string>('tongtong');
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(false);
  const [audio, setAudio] = useState<{ src: string; bytes: number; provider: string; format: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const voices = statusRes.data?.tts.voices ?? FALLBACK_VOICES;
  const maxChars = statusRes.data?.tts.maxChars ?? FALLBACK_MAX_CHARS;
  const tooLong = text.length > maxChars;

  const speak = async () => {
    if (!text.trim() || loading || tooLong) return;
    setLoading(true);
    setError(null);
    setAudio(null);
    try {
      const r = await api.aiLabVoiceTts(text.trim(), voice, speed);
      setAudio({ src: `data:audio/${r.format};base64,${r.audioBase64}`, bytes: r.bytes, provider: r.provider, format: r.format });
      toast.success('Audio generat', { description: `${(r.bytes / 1024).toFixed(0)} KB · vocea ${voice} · ${speed.toFixed(1)}×` });
      requestAnimationFrame(() => {
        void audioRef.current?.play().catch(() => undefined);
      });
    } catch (e) {
      const msg = friendlyVoiceError(e);
      setError(msg);
      toast.error('Generarea audio a eșuat', { description: msg });
    } finally {
      setLoading(false);
    }
  };

  return (
    <LabCard title="🔊 Descriere audio (TTS)" hint="Transformă orice text în voce — 7 voci, viteză reglabilă">
      {statusRes.loading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-11 rounded-xl" />
        </div>
      ) : statusRes.error ? (
        <p className="text-sm text-zinc-500">Starea serviciului vocal nu a putut fi citită — folosim valorile implicite.</p>
      ) : null}
      <div className="space-y-3">
        <div>
          <label htmlFor="tts-text" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
            Text de citit
          </label>
          <textarea
            id="tts-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="ex. Pe scurt: un detectiv din Seul investighează un caz de dispariții care îi schimbă viața…"
            rows={4}
            maxLength={1200}
            className="flex min-h-24 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-rose-500/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30"
            aria-label="Text pentru descrierea audio"
          />
          <p className={cn('mt-1 text-right text-[11px] tabular-nums', tooLong ? 'font-bold text-rose-300' : 'text-zinc-500')}>
            {text.length}/{maxChars}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="tts-voice" className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
              Voce ({voices.length} disponibile)
            </label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger id="tts-voice" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="tts-speed" className="mb-1.5 flex items-baseline justify-between text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-500">
              Viteză
              <span className="font-mono text-[11px] text-zinc-300">{speed.toFixed(1)}×</span>
            </label>
            <Slider
              id="tts-speed"
              value={[speed]}
              min={0.5}
              max={2}
              step={0.1}
              onValueChange={(vals) => setSpeed(vals[0] ?? 1)}
              className="py-3.5"
              aria-label="Viteza de citire"
            />
          </div>
        </div>
        <Button
          onClick={() => void speak()}
          disabled={!text.trim() || tooLong || loading}
          className="h-11 bg-emerald-600 font-bold hover:bg-emerald-500"
        >
          {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Volume2 className="mr-1.5 h-4 w-4" aria-hidden />}
          {loading ? 'Se sintetizează vocea…' : 'Ascultă'}
        </Button>
        {audio ? (
          <div className="space-y-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-zinc-400">
                WAV · {(audio.bytes / 1024).toFixed(0)} KB · vocea {voice} · {speed.toFixed(1)}×
              </p>
              <LabProviderBadge provider={audio.provider} />
            </div>
            {/* Audio generat din textul vizibil deasupra — nu are nevoie de caption. */}
            <audio ref={audioRef} controls src={audio.src} className="h-11 w-full" preload="auto" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void audioRef.current?.play().catch(() => undefined)}
              className="h-9 border-white/15 bg-white/5 text-xs font-semibold text-zinc-200 hover:bg-white/10"
            >
              <Play className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Redă din nou
            </Button>
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-rose-200">
            {error}
          </div>
        ) : null}
      </div>
    </LabCard>
  );
}

export function VoicePanel() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <VoiceSearchCard />
        </div>
        <div className="min-w-0">
          <TtsCard />
        </div>
      </div>
      <LabNote>
        🎤 AI Voice folosește serviciul vocal z-ai real: transcrierea (ASR) și sinteza vocală (TTS) rulează pe
        server — erorile 503 sunt raportate onest, fără fallback fals.
      </LabNote>
    </div>
  );
}
