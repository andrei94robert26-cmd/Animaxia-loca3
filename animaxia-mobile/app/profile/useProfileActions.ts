/**
 * app/profile/useProfileActions.ts — Profile domain actions (Phase 6).
 *
 * Everything the Profile screen DOES (vs. displays) lives here, so the
 * app/profile/ folder owns real account-domain logic:
 *
 *   • pickAvatar      expo-image-picker → base64 data-URL (≤512KB decoded) →
 *                     POST /api/users/me/avatar → useAuth.updateUser sync
 *   • savePreferences PUT /api/users/me/preferences + GET /api/users/me so
 *                     the session user snapshot stays in sync
 *   • refreshProfile  re-run the profile query (stats · history · watchlist)
 *
 * The hook is presentation-free: mutations surface through `busy`/`error`
 * and the screen decides how to render failures. Errors clear automatically
 * at the start of the next action.
 */

import { useCallback, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { errorMessage } from '../api/client';
import * as usersApi from '../api/users';
import { useAuth } from '../hooks/useAuth';

/** Taste draft persisted via PUT /api/users/me/preferences. */
export interface PreferencesDraft {
  types?: string[];
  genres?: string[];
}

export interface ProfileActions {
  /** true while an avatar upload or a preferences save is in flight. */
  busy: boolean;
  /** Last failure message; null while clean. Cleared by the next action. */
  error: string | null;
  /** Dismiss the current error. */
  clearError: () => void;
  /** Open the gallery, upload the picked avatar, sync the session user. */
  pickAvatar: () => Promise<boolean>;
  /** Persist the taste draft, then re-sync the session user snapshot. */
  savePreferences: (draft: PreferencesDraft) => Promise<boolean>;
  /** Re-run the profile fetch (stats · recent history · watchlist count). */
  refreshProfile: () => void;
}

/**
 * @param refetchProfile bump for the screen's profile query (useApi.refetch);
 *                       invoked after every successful mutation.
 */
export function useProfileActions(refetchProfile?: () => void): ProfileActions {
  const { updateUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const refreshProfile = useCallback(() => {
    refetchProfile?.();
  }, [refetchProfile]);

  const pickAvatar = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
        base64: true,
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset?.base64) return false; // picker dismissed
      const updated = await usersApi.uploadAvatar(`data:image/jpeg;base64,${asset.base64}`);
      updateUser(updated);
      refetchProfile?.();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [updateUser, refetchProfile]);

  const savePreferences = useCallback(async (draft: PreferencesDraft): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await usersApi.putPreferences(draft);
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
  }, [updateUser, refetchProfile]);

  return { busy, error, clearError, pickAvatar, savePreferences, refreshProfile };
}

export default useProfileActions;
