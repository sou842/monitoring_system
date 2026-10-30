'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from './bits';
import { Field, PasswordField } from './fields';

export interface DialogOptions {
  title: string;
  message?: string;
  confirmText?: string;
  danger?: boolean;
  /** Asks for a value (e.g. a password or a name to type); the dialog then resolves with it. */
  input?: { label: string; type?: 'text' | 'password'; autocomplete?: string; placeholder?: string } | null;
  /**
   * Runs on confirm. The dialog stays open, busy, while it runs, and shows its
   * error (e.g. a wrong password) instead of closing if it throws.
   */
  onConfirm?: ((value: string) => Promise<unknown>) | null;
}

/** Without `input`: true (confirmed) or false. With `input`: the typed value, or null when cancelled. */
type OpenDialog = {
  (options: DialogOptions & { input: NonNullable<DialogOptions['input']> }): Promise<string | null>;
  (options: DialogOptions): Promise<boolean>;
};

const DialogContext = createContext<OpenDialog | null>(null);

interface Pending {
  options: DialogOptions;
  resolve: (value: boolean | string | null) => void;
}

/** Hosts the modal dialog; wrap the app in it once. */
export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const open = useCallback(
    (options: DialogOptions) => new Promise<boolean | string | null>((resolve) => setPending({ options, resolve })),
    [],
  ) as OpenDialog;

  return (
    <DialogContext.Provider value={open}>
      {children}
      {pending ? (
        <ModalDialog
          key={pending.options.title}
          options={pending.options}
          onDone={(value) => {
            pending.resolve(value);
            setPending(null);
          }}
        />
      ) : null}
    </DialogContext.Provider>
  );
}

function ModalDialog({ options, onDone }: { options: DialogOptions; onDone: (value: boolean | string | null) => void }) {
  const { title, message, confirmText = 'Confirm', danger = false, input = null, onConfirm = null } = options;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = input ? null : false;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    (input ? inputRef.current : cancelRef.current)?.focus();
  }, [input]);

  const finish = (result: boolean | string | null) => {
    dialogRef.current?.close();
    onDone(result);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (input && value.trim() === '') {
      setError('This field is required');
      inputRef.current?.focus();
      return;
    }
    const result = input ? value : true;
    if (!onConfirm) {
      finish(result);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(value);
      finish(result);
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : 'Something went wrong');
      inputRef.current?.select();
    }
  }

  const fieldProps = {
    label: input?.label ?? '',
    value,
    onValue: (v: string) => {
      setValue(v);
      setError(null);
    },
    error: input ? error : null,
    autoComplete: input?.autocomplete || 'off',
    placeholder: input?.placeholder || '',
    ref: inputRef,
  };

  return (
    <dialog
      ref={dialogRef}
      className={`modal${danger ? ' modal-danger' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) finish(cancelled);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) finish(cancelled);
      }}
    >
      <form className="modal-body" noValidate onSubmit={submit}>
        <h2 className="modal-title">{title}</h2>
        {message ? <p className="modal-text">{message}</p> : null}
        {input ? (input.type === 'password' ? <PasswordField {...fieldProps} /> : <Field {...fieldProps} type="text" />) : null}
        {!input && error ? <p className="notice error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" disabled={busy} onClick={() => finish(cancelled)}>Cancel</button>
          <Button type="submit" className={danger ? 'danger solid' : 'primary'} busy={busy}>{confirmText}</Button>
        </div>
      </form>
    </dialog>
  );
}

/** `openDialog()` from the nearest DialogProvider. */
export function useDialog(): OpenDialog {
  const open = useContext(DialogContext);
  if (open === null) throw new Error('useDialog() needs a <DialogProvider> above it');
  return open;
}
