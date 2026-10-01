/**
 * auth/useAuth.ts — Session hook. Throws when used outside <AuthProvider>.
 */

import { useContext } from 'react';
import { AuthContext } from './AuthContext';
import type { AuthState } from './AuthContext';

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export default useAuth;
