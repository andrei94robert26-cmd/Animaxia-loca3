/**
 * types/global.d.ts — window.animaxia bridge types (the preload contract) +
 * Vite env typing. Every renderer access to Electron goes through this
 * interface; there is no other path to IPC.
 */

type ThemeSetting = 'system' | 'dark' | 'light';
type ResolvedTheme = 'dark' | 'light';

interface MiniPlayerPayload {
  contentId: number;
  title: string;
  thumbnail: string | null;
  source: { type: string; url: string; label: string };
  /** Resume position (seconds) + known duration (seconds). */
  position: number;
  duration: number;
}

interface PlaybackRecord {
  position: number;
  duration: number;
  updatedAt: number;
}

interface NotificationSettings {
  dailyPicks: boolean;
  weeklyRecap: boolean;
  newContent: boolean;
  premiumRenewal: boolean;
}

interface UpdaterStatus {
  event:
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'progress'
    | 'downloaded'
    | 'error'
    | 'dev-noop';
  info: {
    version?: string;
    message?: string;
    percent?: number;
    bytesPerSecond?: number;
    transferred?: number;
    total?: number;
  } | null;
}

interface AnimaxiaBridge {
  /** Menu / tray / deep-link / notification / mini-expand navigations. */
  onNavigate(callback: (route: string) => void): () => void;
  getInitialRoute(): Promise<string | null>;
  theme: {
    get(): Promise<{ setting: ThemeSetting; resolved: ResolvedTheme }>;
    set(setting: ThemeSetting): Promise<{ setting: ThemeSetting; resolved: ResolvedTheme }>;
    onChanged(callback: (payload: { setting: ThemeSetting; resolved: ResolvedTheme }) => void): () => void;
  };
  settings: {
    get(): Promise<Record<string, unknown>>;
    patch(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  miniPlayer: {
    open(payload: MiniPlayerPayload): void;
    getData(): Promise<MiniPlayerPayload | null>;
    reportProgress(progress: { position: number; duration: number }): void;
    onReplaced(callback: (payload: MiniPlayerPayload) => void): () => void;
    onClosed(callback: () => void): () => void;
    close(): void;
    expand(position: number): void;
  };
  playback: {
    get(contentId: number | string): Promise<PlaybackRecord | null>;
    save(payload: { contentId: number | string; position: number; duration: number }): void;
  };
  updater: {
    check(): void;
    install(): void;
    onStatus(callback: (status: UpdaterStatus) => void): () => void;
  };
  notifications: {
    getSettings(): Promise<NotificationSettings>;
    saveSettings(settings: Partial<NotificationSettings>): Promise<NotificationSettings>;
    setPremium(context: { plan: string | null; planExpiresAt: string | null }): void;
    newContent(note: { title: string; body: string; route?: string }): void;
    test(note?: { title?: string; body?: string; route?: string }): void;
  };
  app: {
    getInfo(): Promise<{ version: string; platform: string; isPackaged: boolean; userDataPath: string }>;
  };
}

interface Window {
  animaxia: AnimaxiaBridge;
}

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
