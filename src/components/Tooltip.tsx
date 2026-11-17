import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Delay before a tooltip appears on hover. Keyboard focus shows it at once. */
export const TOOLTIP_DELAY_MS = 250;
const GAP = 6;
const EDGE = 8;

interface TooltipProps {
  label: string;
  children: React.ReactElement;
}

/**
 * A small TE-styled label for icon-only buttons. It shows on mouse hover and keyboard focus, wraps
 * the button so a disabled button still explains why, and renders into <body> so the scrolling FX
 * card can't clip it. Touch taps don't open it; the button's aria-label covers screen readers.
 */
export const Tooltip: React.FC<TooltipProps> = ({ label, children }) => {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  // Above the button, centred; below it when there is no room above; kept inside the viewport.
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const above = a.top - GAP - t.height;
    const top = above >= EDGE ? above : a.bottom + GAP;
    const left = Math.min(Math.max(a.left + a.width / 2 - t.width / 2, EDGE), window.innerWidth - t.width - EDGE);
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [open, label]);

  return (
    <span
      ref={anchorRef}
      className="inline-flex"
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch') return;
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOpen(true), TOOLTIP_DELAY_MS);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        if ((e.target as HTMLElement).matches?.(':focus-visible')) setOpen(true);
      }}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            data-testid="tooltip"
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="fixed z-50 pointer-events-none whitespace-nowrap px-1.5 py-[3px] border border-te-edge bg-te-ink text-white font-te-bold text-te-xs tracking-wider uppercase leading-none shadow-[2px_2px_0_0_rgb(var(--te-edge)/0.35)]"
          >
            {label}
          </div>,
          document.body
        )}
    </span>
  );
};
