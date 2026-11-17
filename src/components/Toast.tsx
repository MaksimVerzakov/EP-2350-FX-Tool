import React, { useCallback, useEffect, useRef, useState } from 'react';

export type ToastKind = 'success' | 'error';

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  title: string;
  text: string;
}

/** How long a success message stays up. Errors stay until closed, so they can be read and copied. */
export const TOAST_SUCCESS_MS = 4000;

/** State for the in-app messages that replace the browser's alert() dialogs. */
export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const nextId = useRef(1);

  const show = useCallback((kind: ToastKind, title: string, text: string) => {
    setToast({ id: nextId.current++, kind, title, text });
  }, []);
  const dismiss = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!toast || toast.kind !== 'success') return;
    const timer = window.setTimeout(() => setToast((t) => (t?.id === toast.id ? null : t)), TOAST_SUCCESS_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return { toast, show, dismiss };
}

interface ToastProps {
  toast: ToastMessage | null;
  onDismiss: () => void;
}

/**
 * A small beveled module pinned to the bottom of the screen: an orange header for errors, an ink
 * header for confirmations. It never blocks the page the way alert() does.
 */
export const Toast: React.FC<ToastProps> = ({ toast, onDismiss }) => {
  useEffect(() => {
    if (!toast) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, onDismiss]);

  if (!toast) return null;
  const isError = toast.kind === 'error';

  return (
    <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 pointer-events-none">
      <div
        key={toast.id}
        role={isError ? 'alert' : 'status'}
        aria-live={isError ? 'assertive' : 'polite'}
        data-testid="toast"
        data-kind={toast.kind}
        className="pointer-events-auto relative w-full max-w-[400px] pr-[5px] pb-[5px]"
      >
        {/* 45° right and bottom bevels, as on the other blocks */}
        <div
          aria-hidden="true"
          className="absolute top-0 right-0 bottom-[5px] w-[5px] origin-top-left skew-y-[45deg] flex flex-col border-t border-r border-b border-te-edge"
        >
          <div className={`h-[24px] border-b border-te-edge ${isError ? 'bg-te-accent-deep' : 'bg-te-ink-deep'}`} />
          <div className="flex-1 bg-te-bevel" />
        </div>
        <div
          aria-hidden="true"
          className="absolute left-0 right-[5px] bottom-0 h-[5px] origin-top-left skew-x-[45deg] border-l border-b border-r border-te-edge bg-te-bevel"
        />

        <div className="relative z-10 border border-te-edge bg-te-surface text-te-ink">
          <div
            className={`h-[24px] border-b border-te-edge flex items-center justify-between pl-3 pr-1 ${
              isError ? 'bg-te-accent' : 'bg-te-ink'
            }`}
          >
            <span className="font-te-bold text-te-sm tracking-wider uppercase text-white leading-none">
              {toast.title}
            </span>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Close message"
              title="Close"
              className="w-[18px] h-[18px] flex items-center justify-center text-white hover:bg-white/20 cursor-pointer text-te-sm leading-none"
            >
              ✕
            </button>
          </div>
          <p className="px-3 py-2.5 font-mono text-te-md leading-snug break-words select-text">{toast.text}</p>
        </div>
      </div>
    </div>
  );
};
