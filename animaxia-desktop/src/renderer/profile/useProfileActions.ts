/**
 * profile/useProfileActions.ts — Profile domain actions (desktop port of the
 * FAZA 6 mobile hook; presentation-free).
 *
 * Everything the Profile screen DOES (vs. displays) lives here, so the
 * profile/ folder owns real account-domain logic:
 *
 *   • pickAvatar      hidden file input → FileReader → base64 data-URL
 *                     (≤ 512KB, friendly rejection above) →
 *                     POST /api/users/me/avatar → useAuth.updateUser sync
 *   • savePreferences PUT /api/users/me/preferences + GET /api/users/me so
 *                     the session user snapshot stays in sync
 *
 * The hook never renders: mutations surface through `busy`/`error` and the
 * screen decides how to present failures. Errors clear automatically at the
 * start of the next action.
 */

import { useCallback, useState } from 'react';
import { errorMessage } from '@/api/client';
import * as usersApi from '@/api/users';
import type { Preferences } from '@/api/users';
import { useAuth } from '@/auth/AuthContext';
import type { SessionUser } from '@/auth/tokenStore';

/** Decoded avatar cap — the backend rejects anything above 512KB. */
export const MAX_AVATAR_BYTES = 512 * 1024;

export interface ProfileActions {
  /** true while an avatar upload or a preferences save is in flight. */
  busy: boolean;
  /** Last failure message; null while clean. Cleared by the next action. */
  error: string | null;
  /** Dismiss the current error. */
  clearError: () => void;
  /**
   * Read the picked image, upload it, sync the session user.
   * @returns the updated user, or null when the file was rejected / the
   *          upload failed (see `error`).
   */
  pickAvatar: (file: File) => Promise<SessionUser | null>;
  /** Persist the taste draft, then re-sync the session user snapshot. */
  savePreferences: (prefs: Preferences) => Promise<boolean>;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read the selected image'));
    };
    reader.onerror = () => reject(new Error('Could not read the selected image'));
    reader.readAsDataURL(file);
  });
}

/**
 * @param refetchProfile bump for the screen's profile query (useApi.refetch);
 *                       invoked after every successful mutation so the cached
 *                       mobile:profile card stays fresh.
 */
export function useProfileActions(refetchProfile?: () => void): ProfileActions {
  const { updateUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const pickAvatar = useCallback(
    async (file: File): Promise<SessionUser | null> => {
      setError(null);
      if (file.size > MAX_AVATAR_BYTES) {
        setError(
          `That image is ${(file.size / 1024).toFixed(0)} KB — pick one under ${MAX_AVATAR_BYTES / 1024} KB.`,
        );
        return null;
      }
      if (file.type && !file.type.startsWith('image/')) {
        setError('Pick an image file (PNG, JPEG or WebP).');
        return null;
      }
      setBusy(true);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const updated = await usersApi.uploadAvatar(dataUrl);
        updateUser(updated);
        refetchProfile?.();
        return updated;
      } catch (err) {
        setError(errorMessage(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [updateUser, refetchProfile],
  );

  const savePreferences = useCallback(
    async (prefs: Preferences): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await usersApi.putPreferences(prefs);
        // Re-sync the session snapshot so preferences travel across devices.
        const me = await usersApi.getMe();
        updateUser(me.user);
        refetchProfile?.();
        return true;
      } catch (err) {
        setError(errorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [updateUser, refetchProfile],
  );

  return { busy, error, clearError, pickAvatar, savePreferences };
}

export default useProfileActions;
