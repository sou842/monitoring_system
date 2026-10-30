'use client';

import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';

/** Mirrors the server's rules (server/constants.ts); the server re-checks everything. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>;

export interface FieldProps extends InputProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  value: string;
  onValue: (value: string) => void;
  /** Extra content under the input (e.g. a strength meter). */
  after?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** Labelled input with hint and inline error. */
export function Field({ label, hint, error, value, onValue, after, ref, ...props }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        {...props}
        ref={ref}
        id={id}
        value={value}
        onChange={(e) => onValue(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {hint ? <p className="field-hint">{hint}</p> : null}
      {error ? <p className="field-error" id={errorId}>{error}</p> : null}
      {after}
    </div>
  );
}

/** A password field with a Show/Hide button inside it. */
export function PasswordField({ label, hint, error, value, onValue, after, ref, ...props }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const [reveal, setReveal] = useState(false);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="input-wrap">
        <input
          maxLength={MAX_PASSWORD_LENGTH}
          {...props}
          ref={ref}
          id={id}
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        <button
          type="button"
          className="input-addon"
          aria-label={reveal ? 'Hide password' : 'Show password'}
          aria-pressed={reveal}
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint ? <p className="field-hint">{hint}</p> : null}
      {error ? <p className="field-error" id={errorId}>{error}</p> : null}
      {after}
    </div>
  );
}

/** Labelled textarea with a hint, for one-entry-per-line settings. */
export function TextareaField({ label, hint, value, onValue, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { label: string; hint: string; value: string; onValue: (value: string) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <textarea {...props} id={id} value={value} spellCheck={false} autoCapitalize="off" onChange={(e) => onValue(e.target.value)} />
      <p className="field-hint">{hint}</p>
    </div>
  );
}

const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

/** 0 (too short) to 4 (strong): length, mixed case, digits and symbols. */
export function passwordScore(password: string): number {
  if (password.length < MIN_PASSWORD_LENGTH) return 0;
  let score = 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  return score;
}

/** Four-segment strength bar for a password being typed. */
export function StrengthMeter({ password }: { password: string }) {
  if (password.length === 0) return null;
  const score = passwordScore(password);
  return (
    <div className="strength" data-score={score} aria-live="polite">
      <div className="strength-bars">
        {[0, 1, 2, 3].map((i) => <i key={i} className={i < score ? 'on' : ''} />)}
      </div>
      <span className="strength-label">{STRENGTH_LABELS[score]}</span>
    </div>
  );
}

/** Client-side check of a new password; the server applies the same rules. */
export function newPasswordProblem(password: string, email = ''): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.trim() === '') return 'Password cannot be only spaces';
  if (email && password.toLowerCase() === email.trim().toLowerCase()) return 'Password cannot be your email address';
  return null;
}
