"use client";

import { useEffect, useState, type RefObject } from "react";
import { onScroll } from "animejs";

/** True when the visitor asked the OS for reduced motion. Updates live. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const set = () => setReduced(mq.matches);
    set();
    mq.addEventListener("change", set);
    return () => mq.removeEventListener("change", set);
  }, []);
  return reduced;
}

/**
 * anime.js scroll observer for one element. `onEnter` fires every time the element
 * comes ~20% into the viewport, `onLeave` when it is fully gone. Reverted on unmount.
 */
export function useScrollPresence(
  ref: RefObject<Element | null>,
  handlers: { onEnter?: () => void; onLeave?: () => void },
  deps: unknown[] = [],
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = onScroll({
      target: el as HTMLElement,
      enter: { target: "top", container: "bottom-=20%" },
      leave: { target: "bottom", container: "top" },
      repeat: true,
      onEnter: () => handlers.onEnter?.(),
      onLeave: () => handlers.onLeave?.(),
    });
    return () => { obs.revert(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
