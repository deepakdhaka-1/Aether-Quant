"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

type Asset = {
  name: string;
  ticker: string;
  group: "Equities" | "Index" | "Commodities";
  color: string;
  logo: string;
  logoSource?: "app";
};
const ASSETS: Asset[] = [
  { name: "NVIDIA", ticker: "NVDA", group: "Equities", logo: "nvidia-green.svg", logoSource: "app", color: "#76B900" },
  { name: "Tesla", ticker: "TSLA", group: "Equities", logo: "tesla-red.svg", logoSource: "app", color: "#CC0000" },
  { name: "Apple", ticker: "AAPL", group: "Equities", logo: "apple.svg", logoSource: "app", color: "#111111" },
  { name: "Microsoft", ticker: "MSFT", group: "Equities", logo: "microsoft.svg", logoSource: "app", color: "#1F2328" },
  { name: "Amazon", ticker: "AMZN", group: "Equities", logo: "AMZN.png", color: "#1F2328" },
  { name: "Google Inc", ticker: "GOOGL", group: "Equities", logo: "google.svg", logoSource: "app", color: "#4285F4" },
  { name: "Meta", ticker: "META", group: "Equities", logo: "meta-blue.svg", logoSource: "app", color: "#0467DF" },
  { name: "US Tech 100", ticker: "XYZ100", group: "Index", logo: "XYZ100.png", color: "#4B4FD8" },
  { name: "Gold", ticker: "GOLD", group: "Commodities", logo: "GOLD.png", color: "#B8892B" },
  { name: "Silver", ticker: "SILVER", group: "Commodities", logo: "silver.svg", logoSource: "app", color: "#7D8794" },
  { name: "WTI crude", ticker: "CL", group: "Commodities", logo: "crude.svg", logoSource: "app", color: "#343434" },
  { name: "Natural gas", ticker: "NATGAS", group: "Commodities", logo: "natural-gas.svg", logoSource: "app", color: "#2F7DE1" },
  { name: "Copper", ticker: "COPPER", group: "Commodities", logo: "COPPER.png", color: "#B06A3B" },
];
type DailyCandle = { time: number; open: number; high: number; low: number; close: number };
type MarketQuote = { price: number };
const marketCache = new Map<string, { data: MarketQuote; fetchedAt: number }>();
const RINGS = [
  { group: "Index", radius: 0.2, speed: 0.1 },
  { group: "Commodities", radius: 0.335, speed: -0.065 },
  { group: "Equities", radius: 0.47, speed: 0.045 },
];

function Logo({ asset, size = 30 }: { asset: Asset; size?: number }) {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const src = asset.logoSource === "app" || !baseUrl
    ? `/assets/market-logos/${asset.logo}`
    : `${baseUrl}/storage/v1/object/public/asset-icons/${asset.logo}`;
  return <img aria-hidden="true" alt="" src={src} className="block shrink-0 object-contain" style={{ width: size, height: size }} />;
}

function PriceSparkline({ candles, ticker }: { candles: DailyCandle[]; ticker: string }) {
  if (!candles.length) return null;
  const closes = candles.map((candle) => candle.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const y = (price: number) => 44 - ((price - min) / span) * 34;
  const path = closes.map((price, index) => `${index === 0 ? "M" : "L"}${(index / Math.max(1, closes.length - 1) * 220).toFixed(1)},${y(price).toFixed(1)}`).join(" ");
  const lineColor: Record<string, string> = { GOLD: "#B8892B", SILVER: "#7D8794", CL: "#343434", NATGAS: "#2F7DE1", COPPER: "#B06A3B" };

  return (
    <svg className="block h-14 w-full" viewBox="0 0 220 52" preserveAspectRatio="none" role="img" aria-label={`${candles.length} daily closing prices`}>
      <path d={path} fill="none" stroke={lineColor[ticker] ?? "#4B4FD8"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function MarketOrbit() {
  const [active, setActive] = useState<Asset | null>(null);
  const activeRef = useRef<Asset | null>(null);
  const motion = useRef({ speed: 1, rotation: 0 });
  const orbElements = useRef(new Map<string, HTMLButtonElement>());
  const [size, setSize] = useState({ width: 900, height: 486 });
  const [reduced, setReduced] = useState(false);
  const [marketData, setMarketData] = useState<Record<string, MarketQuote>>({});
  const [dailyCandles, setDailyCandles] = useState<Record<string, DailyCandle[]>>({});
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [candlesError, setCandlesError] = useState(false);
  const [errorTicker, setErrorTicker] = useState<string | null>(null);
  const assets = useMemo(() => ASSETS.map((asset, i) => ({ asset, ring: RINGS.find((r) => r.group === asset.group)!, index: ASSETS.slice(0, i).filter((a) => a.group === asset.group).length, count: ASSETS.filter((a) => a.group === asset.group).length })), []);
  const width = size.width, height = size.height, cx = width / 2, cy = height / 2, squash = width < 640 ? 0.62 : 0.38;
  const selected = active;
  const selectedCandles = selected ? dailyCandles[selected.ticker] ?? [] : [];
  const selectedQuote = selected ? marketData[selected.ticker] : undefined;
  const previousClose = selectedCandles.at(-1)?.close;
  const dailyChangePct = selectedQuote && previousClose ? ((selectedQuote.price - previousClose) / previousClose) * 100 : null;
  const setSelection = (asset: Asset | null) => {
    if (activeRef.current?.ticker === asset?.ticker) return;
    activeRef.current = asset;
    setActive(asset);
  };

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateReduced = () => setReduced(media.matches);
    updateReduced(); media.addEventListener("change", updateReduced);
    const el = document.getElementById("market-stage");
    if (!el) return () => media.removeEventListener("change", updateReduced);
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => { observer.disconnect(); media.removeEventListener("change", updateReduced); };
  }, []);

  useEffect(() => {
    if (reduced) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(50, now - last) / 1000;
      last = now;
      const m = motion.current;
      // Pause only while an asset is selected under the pointer. Orb positions
      // no longer receive cursor parallax, so hovering empty ring space stays smooth.
      m.speed += ((activeRef.current ? 0 : 1) - m.speed) * Math.min(1, dt * 4);
      m.rotation += dt * m.speed;
      for (const { asset, ring, index, count } of assets) {
        const element = orbElements.current.get(asset.ticker);
        if (!element) continue;
        const ringIndex = RINGS.indexOf(ring);
        const angle = (index / count) * Math.PI * 2 + ringIndex * 0.7 + m.rotation * ring.speed * 6;
        const sin = Math.sin(angle);
        const depth = (sin + 1) / 2;
        const radius = ring.radius * width;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + sin * radius * squash;
        const isActive = activeRef.current?.ticker === asset.ticker;
        const scale = isActive ? 1.15 : 0.72 + depth * 0.38;
        // Keep the element's origin fixed and let the animation loop own its
        // transform, matching the prototype. React must not compete with RAF
        // for the same transform while hover state causes a rerender.
        element.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
        element.style.opacity = activeRef.current ? (isActive ? "1" : "0.35") : String(0.55 + depth * 0.45);
        element.style.zIndex = String(isActive ? 80 : (sin > 0 ? 55 : 10) + Math.round(depth * 20));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [assets, cx, cy, reduced, squash, width]);

  useEffect(() => {
    const outside = () => setSelection(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelection(null);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("click", outside); document.removeEventListener("keydown", escape); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadCandles = async () => {
      try {
        const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
        const { data, error } = await supabaseBrowser()
          .from("market_candles")
          .select("ticker,candle_time,open,high,low,close")
          .eq("interval", "1d")
          .gte("candle_time", since)
          .order("candle_time", { ascending: true });
        if (error) throw error;
        const grouped: Record<string, DailyCandle[]> = {};
        for (const row of data ?? []) {
          const ticker = String(row.ticker);
          (grouped[ticker] ??= []).push({
            time: Date.parse(String(row.candle_time)),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
          });
        }
        if (!cancelled) setDailyCandles(grouped);
      } catch {
        if (!cancelled) setCandlesError(true);
      } finally {
        if (!cancelled) setCandlesLoading(false);
      }
    };
    void loadCandles();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    const ticker = selected.ticker;
    const cached = marketCache.get(ticker);
    if (cached && Date.now() - cached.fetchedAt < 30_000) {
      setMarketData((current) => ({ ...current, [ticker]: cached.data }));
      setErrorTicker(null);
      return;
    }

    const controller = new AbortController();
    setErrorTicker(null);
    fetch(`/api/market-data?ticker=${encodeURIComponent(ticker)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Market data unavailable");
        return response.json() as Promise<MarketQuote>;
      })
      .then((data) => {
        marketCache.set(ticker, { data, fetchedAt: Date.now() });
        setMarketData((current) => ({ ...current, [ticker]: data }));
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setErrorTicker(ticker);
        }
      });
    return () => controller.abort();
  }, [selected]);
  return (
    <section id="markets" aria-labelledby="markets-h" className="scroll-mt-16 overflow-hidden bg-[#FBFBFA] text-[#111214]">
      <div className="mx-auto max-w-[1240px] px-4 pb-12 pt-20 sm:px-8 lg:pb-12 lg:pt-24">
        <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="font-[family-name:var(--aq-mono)] text-xs uppercase tracking-[.14em] text-[#6B6F76]">Coverage / 13 markets</p>
            <h2 id="markets-h" className="mt-3 text-[clamp(2rem,4.6vw,3.5rem)] font-semibold leading-[1.02] tracking-[-0.035em]">Every market,<br />one systematic core.</h2>
          </div>
          <div>
            <p className="max-w-[52ch] text-[1.05rem] leading-relaxed text-[#6B6F76]">Aether runs the same rules-based engine across US mega-cap equities, the US Tech 100 and five global commodities. Long and short.</p>
            <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-2">
              {[['Equities', 'border-dashed', '#DCDCD7'], ['Index', 'border-solid', '#C4C6F2'], ['Commodities', 'border-dotted', '#DCDCD7']].map(([label, style, color]) => <span key={label} className="mr-2 inline-flex items-center gap-2 font-[family-name:var(--aq-mono)] text-xs text-[#6B6F76]"><i className={`w-[22px] shrink-0 border-t ${style}`} style={{ borderColor: color }} />{label}</span>)}
            </div>
          </div>
        </div>
        <div id="market-stage" className={`relative mx-auto mt-10 aspect-[1.85] w-full max-w-[1040px] touch-pan-y max-sm:aspect-[1.05] ${reduced ? "hidden" : ""}`} onPointerLeave={() => setSelection(null)}>
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {RINGS.map((ring, i) => <ellipse key={ring.group} cx={cx} cy={cy} rx={ring.radius * width} ry={ring.radius * width * squash} fill="none" stroke={ring.group === "Index" ? "#C4C6F2" : "#DCDCD7"} strokeDasharray={ring.group === "Equities" ? "4 6" : ring.group === "Index" ? "2 6" : undefined} style={{ animation: `marketOrbitRingsIn 900ms ease-out ${i * 150}ms both` }} />)}
          </svg>
          <div className={`absolute left-1/2 top-1/2 z-20 grid aspect-square -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[radial-gradient(circle_at_35%_30%,#F8FAFF,#D9DCFF)] text-center text-[#10172D] shadow-[0_20px_70px_-20px_rgba(108,115,220,.6)] transition-[opacity,transform] duration-[450ms] ${selected ? "opacity-0" : "opacity-100"}`} style={{ width: width * (width < 640 ? 0.22 : 0.15), transform: `translate(-50%,-50%) scale(${selected ? .8 : 1})` }}>
            <span aria-hidden="true" className="pointer-events-none absolute -inset-[14px] rounded-full border border-[#4B4FD8]/20" style={{ animation: "marketOrbitPulse 3.2s ease-out infinite" }} />
            <div><b className="block font-semibold leading-none tracking-tight" style={{ fontSize: width * (width < 640 ? 0.22 : 0.15) * 0.16 }}>Aether</b><span className="font-[family-name:var(--aq-mono)] text-[10px] uppercase tracking-[.14em] text-[#5A6874]">Quant core</span></div>
          </div>
          {assets.map(({ asset }) => {
            const isActive = selected?.ticker === asset.ticker;
            const diameter = width < 640 ? 40 : 66;
            return <button key={asset.ticker} ref={(element) => { if (element) orbElements.current.set(asset.ticker, element); else orbElements.current.delete(asset.ticker); }} type="button" aria-label={`${asset.name}, ${asset.ticker}, ${asset.group}`} aria-pressed={isActive} onPointerEnter={(event) => { if (event.pointerType === "mouse") setSelection(asset); }} onPointerLeave={(event) => { if (event.pointerType === "mouse") setSelection(null); }} onFocus={() => setSelection(asset)} onBlur={() => setSelection(null)} onClick={(event) => { event.stopPropagation(); setSelection(isActive ? null : asset); }} className="absolute left-0 top-0 z-10 grid place-items-center border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4B4FD8]" style={{ width: diameter, height: diameter, marginLeft: -diameter / 2, marginTop: -diameter / 2, opacity: selected ? (isActive ? 1 : 0.35) : undefined, zIndex: isActive ? 80 : undefined }}><span className={`grid h-full w-full place-items-center rounded-full bg-white shadow-[0_10px_24px_-10px_rgba(0,0,0,.32)] transition-[transform,box-shadow] duration-300 ${isActive ? "ring-2 ring-[#4B4FD8]" : ""}`} style={{ transform: `scale(${isActive ? 1.35 : 1})` }}><Logo asset={asset} size={width < 640 ? 22 : 30} /></span><span className={`pointer-events-none absolute top-full mt-3 whitespace-nowrap font-[family-name:var(--aq-mono)] text-[10px] ${isActive ? "text-[#111214]" : "sr-only"}`}>{asset.ticker}</span></button>;
          })}
          {selected && <div role="status" aria-live="polite" className="pointer-events-none absolute left-1/2 top-1/2 z-40 w-[min(260px,58%)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#E7E7E4] bg-white/95 p-4 text-[#111214] shadow-[0_30px_70px_-24px_rgba(20,20,60,.35)] backdrop-blur-md animate-[marketOrbitCardIn_450ms_cubic-bezier(.2,.8,.2,1)_both]">
            <div className="flex items-center gap-3"><Logo asset={selected} size={48} /><div><p className="text-[17px] font-semibold">{selected.name}</p><p className="font-[family-name:var(--aq-mono)] text-[11px] text-[#6B6F76]">{selected.ticker} · {selected.group === "Commodities" ? "Commodity" : selected.group === "Equities" ? "US equity" : selected.group}</p></div></div>
            <div className="my-2">
              {selectedCandles.length ? <PriceSparkline candles={selectedCandles} ticker={selected.ticker} /> : <div className="grid h-14 place-items-center font-[family-name:var(--aq-mono)] text-[10px] text-[#6B6F76]">{candlesLoading ? "Loading 30-day chart…" : candlesError ? "Daily chart data unavailable" : "Waiting for daily OHLCV sync"}</div>}
            </div>
            {selectedQuote ? <>
              <p className="flex items-baseline justify-between gap-2 font-[family-name:var(--aq-mono)]">
                <span className="text-[17px]">{selectedQuote.price.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>
                {dailyChangePct !== null && <span className={`text-[13px] ${dailyChangePct >= 0 ? "text-[#16804A]" : "text-[#C23B3B]"}`}>{dailyChangePct >= 0 ? "+" : ""}{dailyChangePct.toFixed(2)}%</span>}
                <span className="ml-auto text-[10px] uppercase tracking-wider text-[#6B6F76]">Live</span>
              </p>
            </> : <p className="flex items-baseline justify-between font-[family-name:var(--aq-mono)] text-[10px] uppercase tracking-wider text-[#6B6F76]"><span>{errorTicker === selected.ticker ? "Live data unavailable" : "Loading live data…"}</span><span>Illustrative</span></p>}
            <div className="mt-3 flex gap-1.5 font-[family-name:var(--aq-mono)] text-[10px] text-[#3A3D44]"><span className="rounded-full bg-[#F1F1EE] px-2 py-1">Long</span><span className="rounded-full bg-[#F1F1EE] px-2 py-1">Short</span><span className="rounded-full bg-[#F1F1EE] px-2 py-1">Systematic</span></div>
          </div>}
        </div>
        <div className={`mt-8 grid grid-cols-2 gap-2 sm:grid-cols-4 ${reduced ? "" : "lg:hidden"}`}>
          {ASSETS.map((asset) => <div key={asset.ticker} className="flex items-center gap-2 rounded-xl border border-[#E7E7E4] bg-white p-3"><Logo asset={asset} size={28} /><div><p className="text-sm">{asset.name}</p><p className="font-[family-name:var(--aq-mono)] text-[10px] text-[#6B6F76]">{asset.ticker}</p></div></div>)}
        </div>      </div>
    </section>
  );
}
