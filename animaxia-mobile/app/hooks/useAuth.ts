/**
 * app/hooks/useAuth.ts — Session hook (Phase 6 location).
 * The provider lives in app/context/AuthContext.tsx; the hook itself is
 * defined here so every screen imports it from ../hooks/useAuth.
 * Throws when used outside <AuthProvider>.
 */

import { useContext } from 'react';

import AuthContext from '../context/AuthContext';
import type { AuthState } from '../context/AuthContext';

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export default useAuth;
