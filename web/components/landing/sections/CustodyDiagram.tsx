"use client";

import { useEffect, useRef, useState } from "react";
import { animate, createTimeline, stagger, type Timeline } from "animejs";
import { useReducedMotion, useScrollPresence } from "./useInView";

const GREEN = "#1E6B62";
const RED = "#C74747";
const INK = "#0C1A26";
const MUTED = "#5A6874";
const LINE = "#C9D2D7";

// Layout grid (viewBox 600 x 430): 24px outer padding, three equal 132px columns, 78px wires.
const VW = 600;
const VH = 430;
const NW = 132;
const NH = 76;
const COL = [24, 234, 444];
const R = 14;
const SERVER = { x: COL[1], y: 24, w: NW, h: 58 };
const KEY = { x: COL[1], y: 168, w: NW, h: NH };
const WALLET = { x: COL[0], y: KEY.y, w: NW, h: NH };
const EX = { x: COL[2], y: 120, w: NW, h: 188 };
const WD = { x: COL[1], y: 350, w: NW, h: 56 };
const KX = KEY.x + NW / 2;
const KY = KEY.y + NH / 2;
const SHIELD_Y = 298;

// Mini position rows inside the exchange box: price scale with entry and stop markers.
const TRACK = { x1: EX.x + 14, x2: EX.x + NW - 14 };
const ROWS = [
  { id: "nvda", label: "NVDA long", color: GREEN, y: EX.y + 66, stop: TRACK.x1 + 10, entry: TRACK.x1 + 58, price: TRACK.x1 + 78 },
  { id: "gold", label: "GOLD short", color: RED, y: EX.y + 126, stop: TRACK.x2 - 10, entry: TRACK.x2 - 52, price: TRACK.x2 - 76 },
] as const;

function Node({ b, title, sub, dim, accent, fill = "#fff" }: { b: { x: number; y: number; w: number; h: number }; title: string; sub: string; dim?: boolean; accent?: string; fill?: string }) {
  return (
    <g opacity={dim ? 0.4 : 1} style={{ transition: "opacity .4s" }}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={R} fill={fill} stroke={accent ?? LINE} strokeWidth={accent ? 1.6 : 1.2} style={{ transition: "fill .4s" }} />
      <text x={b.x + b.w / 2} y={b.y + b.h / 2 - 3} textAnchor="middle" fontSize="13.5" fontWeight="600" fill={INK}>{title}</text>
      <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 15} textAnchor="middle" fontSize="11" fill={MUTED}>{sub}</text>
    </g>
  );
}

const WireLabel = ({ x, y, children, color = MUTED }: { x: number; y: number; children: string; color?: string }) => (
  <text x={x} y={y} textAnchor="middle" fontSize="10.5" fill={color} className="font-[family-name:var(--aq-mono)]">{children}</text>
);

export default function CustodyDiagram() {
  const reduced = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const caption = useRef<HTMLParagraphElement>(null);
  const loop = useRef<Timeline | null>(null);
  const [offline, setOffline] = useState(false);
  const [killed, setKilled] = useState(false);
  const [stopHit, setStopHit] = useState(false);
  const flowing = !offline && !killed;

  // Ambient loop: signal -> key -> order -> exchange, then a blocked withdrawal attempt.
  useEffect(() => {
    const el = svg.current;
    if (!el || reduced) return;
    const $ = (s: string) => el.querySelectorAll(s);
    const blink = (hold: number) => [{ to: 1, duration: 80 }, { to: 1, duration: hold }, { to: 0, duration: 100 }];
    const t = createTimeline({ autoplay: false, loop: true, defaults: { ease: "inOutQuad" } });
    t.add($("[data-p='sig']"), { cy: [SERVER.y + SERVER.h, KEY.y], opacity: blink(340), duration: 520 }, 0)
      .add($("[data-p='ord']"), { cx: [KEY.x + NW, EX.x], opacity: blink(340), duration: 520 }, 580)
      .add($("[data-flash='ex']"), { opacity: [0, 0.07, 0], duration: 700 }, 1100)
      .add($("[data-p='wd']"), { cy: [KEY.y + NH, SHIELD_Y - 18], opacity: blink(500), duration: 700, ease: "inQuad" }, 1750)
      .add($("[data-shield]"), { scale: [1, 1.18, 1], duration: 420, ease: "outBack(3)" }, 2420)
      .add($("[data-blocked]"), { opacity: blink(1300) }, 2420)
      .add({}, { duration: 600 }, 3900);
    loop.current = t;
    return () => { t.revert(); loop.current = null; };
  }, [reduced]);

  useScrollPresence(root, {
    onEnter: () => loop.current?.play(),
    onLeave: () => loop.current?.pause(),
  }, [reduced]);

  // Offline demo: NVDA's price falls to the stop that rests on the exchange, which fills on its own.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const d = reduced ? 0 : 1;
    const dot = el.querySelector("[data-price='nvda']");
    const row = el.querySelector("[data-row='nvda']");
    const hit = el.querySelectorAll("[data-stop-hit]");
    const anims: { pause: () => void }[] = [];
    setStopHit(false);
    if (offline) {
      anims.push(animate(dot!, { cx: ROWS[0].stop, duration: 1700 * d, delay: 400 * d, ease: "inQuad", onComplete: () => setStopHit(true) }));
      anims.push(animate(hit, { opacity: 1, duration: 300 * d, delay: 2100 * d }));
      anims.push(animate(row!, { opacity: 0.45, duration: 400 * d, delay: 2300 * d }));
    } else {
      anims.push(animate(dot!, { cx: ROWS[0].price, duration: 500 * d }));
      anims.push(animate(hit, { opacity: 0, duration: 200 * d }));
      if (!killed) anims.push(animate(row!, { opacity: 1, duration: 300 * d }));
    }
    return () => anims.forEach((a) => a.pause());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline, reduced]);

  // Kill switch: every open position closes to flat.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const d = reduced ? 0 : 1;
    const rows = el.querySelectorAll(killed ? "[data-row]" : offline ? "[data-row='gold']" : "[data-row]");
    const a = animate(rows, { opacity: killed ? 0.3 : 1, duration: 500 * d, delay: (killed ? 300 : 0) * d });
    if (killed) animate(el.querySelectorAll("[data-stop-hit]"), { opacity: 0, duration: 200 * d });
    else if (offline) animate(el.querySelectorAll("[data-stop-hit]"), { opacity: 1, duration: 200 * d });
    const f = animate(el.querySelectorAll("[data-flat]"), { opacity: killed ? 1 : 0, duration: 400 * d, delay: (killed ? 700 : 0) * d });
    const c = killed ? animate(el.querySelectorAll("[data-p='close']"), { cx: [KEY.x + NW, EX.x], opacity: [{ to: 1, duration: 60 }, { to: 1, duration: 300 }, { to: 0, duration: 80 }], duration: 440 * d, delay: stagger(160 * d) }) : null;
    return () => { a.pause(); f.pause(); c?.pause(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [killed, reduced]);

  const status = killed
    ? "Kill switch on: every position is closed and the account is flat."
    : offline
      ? stopHit
        ? "Aether is offline. NVDA fell to its stop, and the exchange closed the position on its own."
        : "Aether is offline. The stop-loss keeps resting on the exchange."
      : "Normal operation: orders go out through the trade-only key. Withdrawals are blocked.";

  // Caption fades in each time the state changes.
  useEffect(() => {
    if (!caption.current || reduced) return;
    const a = animate(caption.current, { opacity: [0, 1], translateY: [4, 0], duration: 320, ease: "outQuad" });
    return () => { a.pause(); };
  }, [status, reduced]);

  const toggle = (on: boolean) =>
    `inline-flex items-center gap-2.5 rounded-full border px-3.5 py-2 text-[13.5px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E6B62] ${
      on ? "border-[#0C1A26] bg-[#0C1A26] text-white" : "border-[#C9D2D7] bg-white text-[#0C1A26] hover:border-[#0C1A26]"
    }`;
  const knob = (on: boolean) => (
    <span aria-hidden className={`relative h-4 w-7 rounded-full transition-colors ${on ? "bg-[#6CC3AC]" : "bg-[#D5DDE0]"}`}>
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left] ${on ? "left-3.5" : "left-0.5"}`} />
    </span>
  );
  const mono = "font-[family-name:var(--aq-mono)]";

  return (
    <div ref={root} className="min-w-0 overflow-hidden rounded-3xl border border-[#E3E8EA] bg-white">
      <svg ref={svg} viewBox={`0 0 ${VW} ${VH}`} className="block h-auto w-full" role="img"
        aria-label="Permission diagram. Your wallet holds the funds and approves a trade-only key. The key can send orders to the exchange. A path from the key to withdraw or transfer funds is blocked by the exchange.">
        <defs>
          <pattern id="cd-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="#F0F3F4" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={VW} height={VH} fill="url(#cd-grid)" />

        {/* wires, labels sit above each wire */}
        <line x1={KX} x2={KX} y1={SERVER.y + SERVER.h} y2={KEY.y} stroke={offline ? "#E3E8EA" : LINE} strokeWidth="1.4" strokeDasharray={offline ? "3 4" : undefined} />
        <WireLabel x={KX + 34} y={(SERVER.y + SERVER.h + KEY.y) / 2 + 4}>signals</WireLabel>
        <line x1={WALLET.x + NW} x2={KEY.x} y1={KY} y2={KY} stroke={GREEN} strokeWidth="1.4" strokeDasharray="4 4" />
        <WireLabel x={(WALLET.x + NW + KEY.x) / 2} y={KY - 9} color={GREEN}>approves</WireLabel>
        <line x1={KEY.x + NW} x2={EX.x} y1={KY} y2={KY} stroke={killed ? "#E3E8EA" : INK} strokeWidth="1.4" />
        <WireLabel x={(KEY.x + NW + EX.x) / 2} y={KY - 9}>orders</WireLabel>
        <line x1={KX} x2={KX} y1={KEY.y + NH} y2={SHIELD_Y - 17} stroke={RED} strokeWidth="1.3" strokeDasharray="3 4" opacity="0.7" />
        <line x1={KX} x2={KX} y1={SHIELD_Y + 17} y2={WD.y} stroke={RED} strokeWidth="1.1" strokeDasharray="3 4" opacity="0.25" />

        {/* nodes */}
        <g>
          <rect x={SERVER.x} y={SERVER.y} width={NW} height={SERVER.h} rx={R} fill={offline ? "#F3F5F6" : "#fff"} stroke={LINE} strokeWidth="1.2" style={{ transition: "fill .4s" }} />
          <circle cx={SERVER.x + 16} cy={SERVER.y + 23} r="4" fill={offline ? "#B9C4C9" : GREEN} />
          <text x={KX + 6} y={SERVER.y + 27} textAnchor="middle" fontSize="13.5" fontWeight="600" fill={offline ? "#8A97A1" : INK}>Aether server</text>
          <text x={KX} y={SERVER.y + 44} textAnchor="middle" fontSize="10.5" fill={offline ? RED : MUTED} className={mono}>{offline ? "offline" : "runs the rules"}</text>
        </g>
        <Node b={WALLET} title="Your wallet" sub="funds stay here" accent={GREEN} />
        <Node b={KEY} title="Trade-only key" sub="orders, nothing else" dim={killed} />

        {/* exchange with two mini position rows */}
        <rect x={EX.x} y={EX.y} width={NW} height={EX.h} rx={R} fill="#fff" stroke={INK} strokeWidth="1.4" />
        <rect data-flash="ex" x={EX.x} y={EX.y} width={NW} height={EX.h} rx={R} fill={GREEN} opacity="0" />
        <text x={EX.x + 14} y={EX.y + 24} fontSize="13.5" fontWeight="600" fill={INK}>Hyperliquid</text>
        <text x={EX.x + 14} y={EX.y + 40} fontSize="10.5" fill={MUTED} className={mono}>your account</text>
        <line x1={EX.x} x2={EX.x + NW} y1={EX.y + 50} y2={EX.y + 50} stroke="#EEF2F3" />
        {ROWS.map((p) => (
          <g key={p.id}>
            <g data-row={p.id}>
              <text x={TRACK.x1} y={p.y} fontSize="11" fontWeight="500" fill={INK}>{p.label}</text>
              <line x1={TRACK.x1} x2={TRACK.x2} y1={p.y + 14} y2={p.y + 14} stroke="#E3E8EA" strokeWidth="3" strokeLinecap="round" />
              <line x1={Math.min(p.entry, p.price)} x2={Math.max(p.entry, p.price)} y1={p.y + 14} y2={p.y + 14} stroke={p.color} strokeWidth="3" strokeLinecap="round" opacity="0.55" />
              <line x1={p.stop} x2={p.stop} y1={p.y + 7} y2={p.y + 21} stroke={RED} strokeWidth="1.6" />
              <line x1={p.entry} x2={p.entry} y1={p.y + 8} y2={p.y + 20} stroke={INK} strokeWidth="1.2" />
              <text x={p.stop} y={p.y + 31} textAnchor="middle" fontSize="8.5" fill={RED} className={mono}>stop</text>
              <text x={p.entry} y={p.y + 31} textAnchor="middle" fontSize="8.5" fill={MUTED} className={mono}>entry</text>
              <circle data-price={p.id} cx={p.price} cy={p.y + 14} r="4.5" fill={p.color} stroke="#fff" strokeWidth="1.5" />
            </g>
            <text data-flat opacity="0" x={TRACK.x2} y={p.y + 44} textAnchor="end" fontSize="10.5" fontWeight="600" fill={INK} className={mono}>flat</text>
          </g>
        ))}
        <text data-stop-hit opacity="0" x={TRACK.x2} y={ROWS[0].y + 44} textAnchor="end" fontSize="10" fontWeight="600" fill={RED} className={mono}>stop filled</text>

        {/* blocked withdrawal */}
        <g data-shield style={{ transformBox: "fill-box", transformOrigin: "center" }}>
          <path d={`M${KX} ${SHIELD_Y - 16} l13 5 v8 c0 9 -6 15 -13 19 c-7 -4 -13 -10 -13 -19 v-8 z`} fill={RED} />
          <path d={`M${KX - 5} ${SHIELD_Y - 2} l10 0`} stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </g>
        <text data-blocked opacity={reduced ? 1 : 0} x={KX + 24} y={SHIELD_Y + 2} fontSize="11" fontWeight="600" fill={RED} className={mono}>not permitted</text>
        <text x={KX - 24} y={SHIELD_Y + 2} textAnchor="end" fontSize="10.5" fill={MUTED} className={mono}>exchange enforced</text>
        <rect x={WD.x} y={WD.y} width={NW} height={WD.h} rx={R} fill="#FBF3F3" stroke={RED} strokeOpacity="0.35" strokeDasharray="4 3" />
        <text x={KX} y={WD.y + 24} textAnchor="middle" fontSize="13" fontWeight="600" fill={RED}>Withdraw</text>
        <text x={KX} y={WD.y + 40} textAnchor="middle" fontSize="10.5" fill={MUTED}>or transfer funds</text>

        {/* pulses */}
        <g opacity={flowing ? 1 : 0} style={{ transition: "opacity .3s" }}>
          <circle data-p="sig" cx={KX} cy={SERVER.y + SERVER.h} r="4" fill={GREEN} opacity="0" />
          <circle data-p="ord" cx={KEY.x + NW} cy={KY} r="4.5" fill={INK} opacity="0" />
          <circle data-p="wd" cx={KX} cy={KEY.y + NH} r="4" fill={RED} opacity="0" />
        </g>
        <circle data-p="close" cx={KEY.x + NW} cy={KY} r="4.5" fill={INK} opacity="0" />
        <circle data-p="close" cx={KEY.x + NW} cy={KY} r="4.5" fill={INK} opacity="0" />
      </svg>

      <div className="border-t border-[#E3E8EA] bg-[#FBFCFC] px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[12.5px] text-[#5A6874]">Try it:</span>
          <button type="button" aria-pressed={offline} onClick={() => setOffline((v) => !v)} className={toggle(offline)}>
            {knob(offline)} Aether offline
          </button>
          <button type="button" aria-pressed={killed} onClick={() => setKilled((v) => !v)} className={toggle(killed)}>
            {knob(killed)} Kill switch
          </button>
        </div>
        <p ref={caption} aria-live="polite" className="mt-3 min-h-[2.75rem] text-[14px] leading-relaxed text-[#3E4C58]">{status}</p>
        <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12.5px] text-[#5A6874] sm:grid-cols-2">
          <li className="flex items-center gap-2 whitespace-nowrap"><span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1E6B62]" />Revoke the key anytime</li>
          <li className="flex items-center gap-2 whitespace-nowrap"><span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#1E6B62]" />Set your own loss limits</li>
        </ul>
      </div>
    </div>
  );
}
