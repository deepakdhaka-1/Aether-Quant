# Transformation prototypes — shared brief

Goal: one scroll-scrubbed transformation that shows a non-trader how Aether Quant goes from raw
price data to a selected trading strategy. Ten different visual takes on the SAME story; the
founder picks one, which is then ported into the Next.js site.

## The story (must be one continuous, connected transformation — each stage built from the previous stage's actual elements; no slideshow cuts)

1. **One candle.** A single NVIDIA 1-hour candle, large and centred.
2. **Anatomy.** It breaks apart into Open, High, Low, Close, body, wicks and a Volume bar. Each part
   gets one plain-English line ("Close: the last price in that hour").
3. **Many candles.** The parts snap back; the candle multiplies into a price series that has a
   clear rally AND a clear sell-off (we profit in both directions).
4. **100+ indicators.** The series feeds an indicator layer: many formulas compute at once
   (moving averages, RSI, MACD, ATR, Bollinger bands, volume flow, …). Show the scale — a dense
   grid/stream of 100+ indicator values updating per candle, with a few highlighted and drawn on
   the chart (e.g. three EMAs of different lengths).
5. **Research engine explores.** An automated research engine analyses the indicators and tries
   many different rule formulations: fragments ("EMA 9 crosses above EMA 21", "RSI < 70",
   "price below EMA 50 → short") combine into many candidate rules, long AND short.
   Do NOT label this "AI". Call it "research engine" or show it as a process
   ("testing 1,240 combinations…").
6. **Backtest and select the best.** Each candidate gets a quick backtest (tiny equity curves);
   most fail and fall away; the best one or two survive the checks (tested on unseen data,
   Sharpe ≥ 0.5, drawdown no worse than −35%, 15+ trades, fees included).
7. **Live.** The selected strategy emits a signal on the newest candle and becomes an order with a
   stop-loss on the user's own account (mention the exchange at most once, small).

Copy: very short, plain English for non-native readers. One caption at a time.
Label numbers as illustrative once, discreetly.

## Hard requirements
- Single self-contained `index.html` per variant (inline CSS/JS) in `prototypes/vNN/`.
- anime.js v4 from CDN, exact version: `https://cdn.jsdelivr.net/npm/animejs@4.5.0/+esm`
  (or the UMD build `.../animejs@4.5.0/dist/bundles/anime.umd.min.js`). Motion tied to scroll
  progress; scrolling back reverses. Add light lerp smoothing and a little ambient idle motion.
  SHORT and brisk (founder: shorten it): the WHOLE story from candle to order fits in ~300–350vh
  of scroll total (~40–50vh per stage); merge or compress stages rather than letting it drag. Expressive easing + stagger, like animejs.com.
- The transformation is the whole focus: full-viewport pinned stage, no side text column.
- Typography: ONE family only — Geist (Google Fonts: `Geist` and `Geist Mono` for figures).
- Do not mention "Hyperliquid" more than once; never use the word "AI" as a label.
- No glow halo around the candle. Clean, premium, readable.
- Colours are free — do not reuse the current site palette by default. Each variant must have a
  distinct palette/mood. Light backgrounds are welcome (founder preferred white over the blue).
  Up and down / long and short must both be clearly legible.
- `?p=0.42` query param jumps to that progress (for review screenshots).
- Works at 1440×900; degrades to a readable stacked version under 900px wide.
- No mention of other companies except the one exchange mention and the traded assets themselves.
