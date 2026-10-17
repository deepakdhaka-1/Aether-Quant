"""All engine configuration comes from the environment (see .env.example)."""
import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=Path(__file__).resolve().parents[2] / ".env")
except ImportError:
    pass


def _bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() in {"1", "true", "yes", "on"}


SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# Equity OHLCV source (CoinGlass). Commodities use Hyperliquid candles.
COINGLASS_BASE_URL = os.getenv("COINGLASS_BASE_URL", "https://fapi.coinglass.com")
COINGLASS_API_KEY = os.getenv("COINGLASS_API_KEY", "")   # optional; the kline endpoint is keyless today

# 32-byte key, base64. Must match API_ENCRYPTION_KEY on the web and executor.
ENCRYPTION_KEY = os.getenv("API_ENCRYPTION_KEY") or os.getenv("AETHER_ENCRYPTION_KEY", "")

HYPERLIQUID_API_URL = os.getenv("HYPERLIQUID_API_URL", "https://api.hyperliquid.xyz")
HIP3_DEX = os.getenv("HIP3_DEX", "xyz")
SLIPPAGE = float(os.getenv("HYPERLIQUID_SLIPPAGE", "0.005"))

# Revenue: builder code attached to every order.
BUILDER_ADDRESS = os.getenv("BUILDER_ADDRESS", "").lower()
BUILDER_FEE_BPS10 = int(os.getenv("BUILDER_FEE_BPS10", "30"))   # tenths of a bp: 30 = 0.03%

# Two independent gates, both must be flipped to send real orders.
DRY_RUN = _bool("DRY_RUN", True)
LIVE_CONFIRMED = _bool("HYPERLIQUID_LIVE_CONFIRMED", False)

# Offline model (any OpenAI-compatible local server: Ollama, LM Studio, llama.cpp, vLLM).
OFFLINE_MODEL_URL = os.getenv("OFFLINE_MODEL_URL", "http://localhost:11434/v1")
OFFLINE_MODEL_NAME = os.getenv("OFFLINE_MODEL_NAME", "qwen2.5:14b")

# Entry market gate (aether/execution/market_gate.py). Closes are never gated.
MARKET_GATE_MAX_AGE_S = float(os.getenv("MARKET_GATE_MAX_AGE_S", "5"))
MARKET_GATE_SPREAD_BP = float(os.getenv("MARKET_GATE_SPREAD_BP", "10"))          # equity/commodity/index
MARKET_GATE_SPREAD_CRYPTO_BP = float(os.getenv("MARKET_GATE_SPREAD_CRYPTO_BP", "15"))
MARKET_GATE_DEPTH_BP = float(os.getenv("MARKET_GATE_DEPTH_BP", "10"))
MARKET_GATE_DEPTH_MULT = float(os.getenv("MARKET_GATE_DEPTH_MULT", "10"))
MARKET_GATE_BASIS_MAX_BP = float(os.getenv("MARKET_GATE_BASIS_MAX_BP", "25"))
MARKET_GATE_CHASE_FRAC = float(os.getenv("MARKET_GATE_CHASE_FRAC", "0.5"))
SIGNAL_ANCHOR_MIN_AGE_S = int(os.getenv("SIGNAL_ANCHOR_MIN_AGE_S", "3600"))
