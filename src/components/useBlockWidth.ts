import { useLayoutEffect, useRef, useState } from 'react';

/** Desktop face width of the top blocks: 10 grid cells of 25px (+1px so both borders sit on grid lines). */
export const BLOCK_FACE_W = 251;
/** Depth of the 45° bevels on the right and bottom of every block. */
export const BLOCK_BEVEL = 5;

/**
 * Face width of a beveled block whose wrapper carries `pr-[5px]` for the bevel. The blocks are a fixed
 * 251px on wider screens and stretch to the FX card's width on phones, so their SVG bevels are drawn
 * from the measured width rather than a constant.
 */
export function useBlockWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(BLOCK_FACE_W);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.clientWidth - BLOCK_BEVEL);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/** Bottom bevel under the face from x0 to x1 (face coordinates), H tall face. */
export const bottomBevelPoints = (x0: number, x1: number, h = 76) =>
  `${x0 + 0.5},${h - 0.5} ${x1 + 0.5},${h - 0.5} ${x1 + 5.5},${h + 4.5} ${x0 + 5.5},${h + 4.5}`;

/** Right bevel beside the face from y0 to y1, for a face W wide. */
export const rightBevelPoints = (w: number, y0: number, y1: number) =>
  `${w - 0.5},${y0 + 0.5} ${w + 4.5},${y0 + 5.5} ${w + 4.5},${y1 + 5.5} ${w - 0.5},${y1 + 0.5}`;
