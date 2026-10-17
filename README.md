# Aether Quant

Rule-based trading strategies for US equities and commodities, executed automatically on each
user's own Hyperliquid account (HIP-3 `xyz` markets). Users keep custody: we trade through an
agent key that can place orders but can never withdraw. Revenue is a Hyperliquid builder fee
(0.03% per order, capped by the user's own approval at 0.05%).

```
 OHLCV (CoinGlass / Hyperliquid) ─► indicators (~145 per candle) ─► indicator DB
        ─► strategies (rules) ─► backtest + out-of-sample gates ─► published
        ─► signal on every closed candle ─► order on the user's account (+ venue stop-loss)
```

## Repository map

| Path | What it is |
|---|---|
| `web/` | Next.js 15 site and app: landing page (scroll story), login, dashboard, broker connect, legal pages |
| `supabase/functions/` | **Live runtime** (Deno Edge Functions on pg_cron): ingest, signals, execute, fees, monitor, market-candles |
| `supabase/migrations/` | Database schema, RLS, indicator tables, cron schedules |
| `engine/` | **Research toolkit** (Python): data, indicator engine, backtester, strategy import/generation |
| `deploy/` | Optional container / scheduler setups for running the Python tools |
| `docs/` | Specs and runbooks (below) |

## Docs

| Doc | Read it for |
|---|---|
| [docs/EDGE_RUNTIME.md](docs/EDGE_RUNTIME.md) | How the live runtime works: functions, schedules, secrets, deploy, going live |
| [docs/PUSHING_STRATEGIES.md](docs/PUSHING_STRATEGIES.md) | Adding strategies straight into Supabase; rule syntax; lifecycle |
| [docs/INDICATOR_TABLES.md](docs/INDICATOR_TABLES.md) | Indicator database tables and columns |
| [docs/EXECUTION_SPEC.md](docs/EXECUTION_SPEC.md) | Exact execution behaviour (reconcile, gates, brackets, risk) |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Runbook: halting, kill switch, key rotation, alerts |
| [supabase/README.md](supabase/README.md) | Database contract, admin promotion, types |
| [docs/brand-kit.md](docs/brand-kit.md) | Brand: font (BDO Grotesk, OFL), colours, logo |

## Run locally

```bash
# website  (port 3001; needs web/.env.local)
cd web && npm install && npx next dev -p 3001

# research engine (needs engine/.env)
cd engine && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m pytest tests                     # 112 tests
.venv/Scripts/python -m aether.cli ingest NVDA 1h        # fill indicator tables
.venv/Scripts/python -m aether.cli backtest-csv data.csv rules.json --timeframe 1h
.venv/Scripts/python -m uvicorn aether.api:app --port 8000   # optional research API
```

`.env` files are git-ignored. Templates: `web/.env.example`, `engine/.env.example`.

## Safety defaults

Real orders require **both** `DRY_RUN=false` and `HYPERLIQUID_LIVE_CONFIRMED=true` (Edge secrets).
Closes are reduce-only; master wallet keys are refused; every position gets a stop-loss resting on
the exchange. See [docs/EDGE_RUNTIME.md](docs/EDGE_RUNTIME.md#going-live).
