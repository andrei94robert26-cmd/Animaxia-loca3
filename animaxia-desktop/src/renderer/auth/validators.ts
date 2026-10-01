/**
 * auth/validators.ts — Form validators shared by the auth screens
 * (login / register / forgot password). Same rules the backend enforces
 * (modules/users/auth.js): email shape, username 3-24 [a-zA-Z0-9._-],
 * password ≥ 8 chars, 6-digit reset code.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,24}$/;
const CODE_RE = /^\d{6}$/;

export function validateEmail(email: string): string | null {
  const value = email.trim();
  if (!value) return 'Email is required';
  if (!EMAIL_RE.test(value)) return 'Enter a valid email address';
  return null;
}

export function validateUsername(username: string): string | null {
  const value = username.trim();
  if (!value) return 'Username is required';
  if (!USERNAME_RE.test(value)) return '3-24 characters: letters, numbers, . _ -';
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Password is required';
  if (password.length < 8) return 'At least 8 characters';
  return null;
}

export function validateResetCode(code: string): string | null {
  const value = code.trim();
  if (!value) return 'Enter the 6-digit code';
  if (!CODE_RE.test(value)) return 'The code has 6 digits';
  return null;
}
