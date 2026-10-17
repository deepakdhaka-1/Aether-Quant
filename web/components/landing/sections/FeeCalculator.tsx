"use client";

import { useEffect, useRef, useState } from "react";
import { animate, stagger } from "animejs";
import { useReducedMotion, useScrollPresence } from "./useInView";

const STEPS = 60;
// Log-ish scale from $1,000 to $100,000, snapped to friendly round numbers.
function sizeAt(step: number) {
  const raw = 1000 * Math.pow(100, step / STEPS);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
  return Math.min(100000, Math.round(raw / (mag * 5)) * mag * 5);
}
const usd = (v: number, dp = 2) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: dp, maximumFractionDigits: dp });

const TILES = [
  ["Subscription", "No monthly plan"],
  ["Management fee", "Nothing charged on your balance"],
  ["Performance fee", "No cut of your profits"],
] as const;

export default function FeeCalculator() {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(30);
  const size = sizeAt(step);
  const fee = size * 0.0003;
  const cap = size * 0.0005;
  const feeEl = useRef<HTMLSpanElement>(null);
  const shown = useRef({ v: fee });
  const [announce, setAnnounce] = useState(`${usd(fee)} on a ${usd(size, 0)} trade`);

  // Smooth number tween for the visible fee; a debounced live region for screen readers.
  useEffect(() => {
    const paint = () => { if (feeEl.current) feeEl.current.textContent = usd(shown.current.v); };
    const a = animate(shown.current, { v: fee, duration: reduced ? 0 : 450, ease: "outCubic", onUpdate: paint, onComplete: paint });
    const t = setTimeout(() => setAnnounce(`${usd(fee)} on a ${usd(size, 0)} trade`), 450);
    return () => { a.pause(); clearTimeout(t); };
  }, [fee, size, reduced]);

  return (
    <div className="min-w-0">
      <div className="rounded-3xl border border-[#E3E8EA] bg-[#FBFCFC] p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="fee-size" className="text-[14px] font-medium text-[#0C1A26]">Trade size</label>
          <output htmlFor="fee-size" className="font-[family-name:var(--aq-mono)] text-[15px] text-[#0C1A26]">{usd(size, 0)}</output>
        </div>
        <input
          id="fee-size"
          type="range"
          min={0}
          max={STEPS}
          step={1}
          value={step}
          onChange={(e) => setStep(Number(e.target.value))}
          aria-valuetext={`${usd(size, 0)} trade`}
          className="mt-4 block w-full cursor-pointer accent-[#1E6B62] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#1E6B62]"
        />
        <div className="mt-1.5 flex justify-between font-[family-name:var(--aq-mono)] text-[11px] text-[#8A97A1]" aria-hidden>
          <span>$1,000</span><span>$10,000</span><span>$100,000</span>
        </div>

        <div className="mt-6 flex flex-wrap items-end gap-x-4 gap-y-2 border-t border-[#E3E8EA] pt-5">
          <p className="font-[family-name:var(--aq-mono)] text-[15px] text-[#1E6B62]">0.03% =</p>
          <p className="text-[clamp(2rem,4.5vw,2.75rem)] font-semibold leading-none tracking-[-0.04em] tabular-nums text-[#0C1A26]">
            <span ref={feeEl} aria-hidden>{usd(fee)}</span>
          </p>
          <p className="pb-1 text-[14px] text-[#5A6874]">our fee on this trade</p>
          <p className="sr-only" aria-live="polite">Our fee: {announce}</p>
        </div>
        <p className="mt-5 rounded-2xl bg-white px-4 py-3 text-[14px] leading-relaxed text-[#3E4C58]">
          In your own wallet you approve a <span className="font-medium text-[#0C1A26]">0.05% maximum</span>, so the fee on
          this trade can never exceed <span className="font-[family-name:var(--aq-mono)] tabular-nums text-[#0C1A26]">{usd(cap)}</span>.
          Exchange trading fees are separate.
        </p>
      </div>

    </div>
  );
}

/** Compact "$0" list for the left column; rows settle in with a stagger on first view. */
export function ZeroFees() {
  const reduced = useReducedMotion();
  const list = useRef<HTMLUListElement>(null);
  const played = useRef(false);

  useEffect(() => {
    const el = list.current;
    if (!el || reduced) return;
    played.current = false;
    const items = el.querySelectorAll<HTMLElement>("[data-tile]");
    items.forEach((i) => { i.style.opacity = "0"; i.style.transform = "translateX(-14px)"; });
    return () => items.forEach((i) => { i.style.opacity = ""; i.style.transform = ""; });
  }, [reduced]);

  useScrollPresence(list, {
    onEnter: () => {
      if (reduced || played.current || !list.current) return;
      played.current = true;
      animate(list.current.querySelectorAll("[data-tile]"), { opacity: [0, 1], translateX: [-14, 0], duration: 650, delay: stagger(130), ease: "outQuart" });
      animate(list.current.querySelectorAll("[data-zero]"), { scale: [1.3, 1], duration: 600, delay: stagger(130, { start: 160 }), ease: "outBack(2)" });
    },
  }, [reduced]);

  return (
    <ul ref={list} className="mt-8 divide-y divide-[#E3E8EA] border-y border-[#E3E8EA]">
      {TILES.map(([k, d]) => (
        <li key={k} data-tile className="grid grid-cols-[4.5rem_1fr] items-baseline gap-3 py-3.5">
          <span data-zero className="inline-block origin-left text-[1.6rem] font-semibold leading-none tracking-[-0.04em] text-[#0C1A26]">$0</span>
          <span className="text-[15px] text-[#3E4C58]"><span className="font-medium text-[#0C1A26]">{k}</span> · {d}</span>
        </li>
      ))}
    </ul>
  );
}
