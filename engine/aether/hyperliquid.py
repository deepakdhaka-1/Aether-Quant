"""Hyperliquid adapter for one user's PERSONAL account, signed by that user's agent wallet.

Production-tested venue logic plus our builder code on every order. Venue notes:
  * HIP-3 builder dex (`xyz`) is how US equities and commodities trade (`xyz:NVDA`, `xyz:GOLD`);
    the SDK must be constructed with perp_dexs=["", dex] to resolve those names to asset ids;
  * standard perps and the xyz dex hold SEPARATE collateral on a classic account -- size each order
    against the pot it draws from; a unified account shares one pool;
  * prices: 5 significant figures and at most (6 - szDecimals) decimals, or the venue rejects;
  * entries are IOC with a slippage bound; closes are reduce-only so they can never flip.
"""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Optional

import requests

from . import config

log = logging.getLogger("aether.hyperliquid")
MIN_NOTIONAL_USD = 10.0
HIP3_OFFSET = 110000
ALIASES = {"XAU": "GOLD", "XAG": "SILVER", "WTI": "CL", "USOIL": "CL", "BRENT": "BRENTOIL"}


class BrokerError(RuntimeError):
    pass


@dataclass
class HLPosition:
    coin: str
    side: str                 # long | short
    qty: float
    entry_price: Optional[float]
    mark_price: Optional[float]
    unrealized_pnl: float


@dataclass
class HLAccount:
    equity: float
    pots: dict                # {"": perps, "xyz": xyz}; empty when unified (one shared pool)
    positions: list


def info(payload: dict, base_url: str | None = None):
    r = requests.post(f"{base_url or config.HYPERLIQUID_API_URL}/info", json=payload, timeout=15)
    r.raise_for_status()
    return r.json()


def approved_agents(user: str) -> list[str]:
    return [a["address"].lower() for a in (info({"type": "extraAgents", "user": user}) or [])]


def max_builder_fee(user: str, builder: str) -> int:
    """Approved builder fee for `builder`, tenths of a basis point (0 = not approved)."""
    return int(info({"type": "maxBuilderFee", "user": user, "builder": builder}) or 0)


class HyperliquidAccount:
    def __init__(self, wallet_address: str, agent_private_key: str, base_url: str | None = None):
        from eth_account import Account
        from hyperliquid.exchange import Exchange
        from hyperliquid.info import Info

        self.base_url = (base_url or config.HYPERLIQUID_API_URL).rstrip("/")
        self.user = wallet_address
        self.dex = config.HIP3_DEX
        agent = Account.from_key(agent_private_key)
        if agent.address.lower() == wallet_address.lower():
            # A master key can withdraw. We only ever hold agent keys. Checked before any I/O.
            raise BrokerError("refusing to use a master wallet key as an agent key")
        self.info = Info(self.base_url, skip_ws=True)
        try:
            self.exchange = Exchange(agent, self.base_url, account_address=wallet_address,
                                     perp_dexs=["", self.dex])
        except Exception as e:
            log.warning("HIP-3 dex '%s' unavailable at init (%s); standard perps only", self.dex, e)
            self.exchange = Exchange(agent, self.base_url, account_address=wallet_address)

        self.sz_decimals: dict[str, int] = {}
        self.max_lev: dict[str, int] = {}
        meta = self.info.meta()
        for a in meta["universe"]:
            self.sz_decimals[a["name"]] = int(a["szDecimals"])
            self.max_lev[a["name"]] = int(a.get("maxLeverage") or 0)
        try:
            m = self.info.post("/info", {"type": "meta", "dex": self.dex})
            for a in (m or {}).get("universe", []):
                self.sz_decimals[a["name"]] = int(a["szDecimals"])
                self.max_lev[a["name"]] = int(a.get("maxLeverage") or 0)
        except Exception as e:
            log.warning("HIP-3 meta unavailable: %s", e)

    # ---- symbols & prices ----
    def to_coin(self, symbol: str) -> str:
        if ":" in symbol:
            d, c = symbol.split(":", 1)
            name = f"{d.lower()}:{c.upper()}"
            if name in self.sz_decimals:
                return name
        base = symbol.upper()
        if base in self.sz_decimals:
            return base
        name = f"{self.dex}:{ALIASES.get(base, base)}"
        if name in self.sz_decimals:
            return name
        raise BrokerError(f"'{symbol}' is not listed on Hyperliquid perps or HIP-3 '{self.dex}'")

    def listed(self) -> set[str]:
        return set(self.sz_decimals)

    def mid(self, coin: str) -> float:
        mids = (self.info.post("/info", {"type": "allMids", "dex": coin.split(":")[0]})
                if ":" in coin else self.info.all_mids())
        px = mids.get(coin)
        if not px:
            raise BrokerError(f"no mid price for {coin}")
        return float(px)

    def _px(self, coin: str, raw: float) -> float:
        return round(float(f"{raw:.5g}"), max(0, 6 - self.sz_decimals.get(coin, 4)))

    def _sz(self, coin: str, qty: float) -> float:
        return round(qty, self.sz_decimals.get(coin, 4))

    # ---- account ----
    def _state(self, dex: str = "") -> dict:
        body = {"type": "clearinghouseState", "user": self.user}
        if dex:
            body["dex"] = dex
        return self.info.post("/info", body) or {}

    def account(self) -> HLAccount:
        perp_state, xyz_state = self._state(), self._state(self.dex)
        if not xyz_state:
            # A partial read would look like a drawdown and could trip the risk halt.
            raise BrokerError(f"HIP-3 '{self.dex}' clearinghouse read failed")
        perp = float(perp_state["marginSummary"]["accountValue"])
        xyz = float((xyz_state.get("marginSummary") or {}).get("accountValue") or 0)
        positions = self._parse(perp_state) + self._parse(xyz_state)
        equity, pots = perp + xyz, {"": perp, self.dex: xyz}
        try:
            if self.info.post("/info", {"type": "userAbstraction", "user": self.user}) == "unifiedAccount":
                spot = self.info.post("/info", {"type": "spotClearinghouseState", "user": self.user}) or {}
                usdc = sum(float(b["total"]) for b in spot.get("balances", []) if b.get("coin") == "USDC")
                equity, pots = usdc + sum(p.unrealized_pnl for p in positions), {}
        except Exception as e:
            log.warning("abstraction read failed for %s: %s (using per-dex sum)", self.user, e)
        return HLAccount(equity=equity, pots=pots, positions=positions)

    def sizing_equity(self, acct: HLAccount, coin: str) -> float:
        if not acct.pots:
            return acct.equity
        return float(acct.pots.get(coin.split(":")[0] if ":" in coin else "", 0.0))

    @staticmethod
    def _parse(st: dict) -> list[HLPosition]:
        out = []
        for ap in st.get("assetPositions") or []:
            p = ap.get("position") or {}
            szi = float(p.get("szi") or 0)
            if not szi:
                continue
            qty = abs(szi)
            out.append(HLPosition(coin=p.get("coin", ""), side="long" if szi > 0 else "short", qty=qty,
                                  entry_price=float(p.get("entryPx") or 0) or None,
                                  mark_price=float(p.get("positionValue") or 0) / qty,
                                  unrealized_pnl=float(p.get("unrealizedPnl") or 0)))
        return out

    # ---- orders ----
    def _require_live(self):
        if config.DRY_RUN or not config.LIVE_CONFIRMED:
            raise BrokerError("live gates closed (DRY_RUN / HYPERLIQUID_LIVE_CONFIRMED)")

    def _cloid(self, coin: str, tag: str):
        from hyperliquid.utils.types import Cloid
        raw = f"{self.user}|{coin}|{tag}|{int(time.time() // 60)}"
        return Cloid.from_str("0x" + hashlib.md5(raw.encode()).hexdigest())

    def builder(self) -> Optional[dict]:
        if not config.BUILDER_ADDRESS:
            return None
        return {"b": config.BUILDER_ADDRESS, "f": config.BUILDER_FEE_BPS10}

    def set_leverage(self, coin: str, leverage: float):
        lev = max(1, int(leverage))
        cap = self.max_lev.get(coin) or lev
        lev = min(lev, cap)
        resp = self.exchange.update_leverage(lev, coin, is_cross=False)
        if isinstance(resp, dict) and resp.get("status") not in ("ok", None):
            raise BrokerError(f"update_leverage {coin} rejected: {str(resp)[:200]}")
        return lev

    def market_order(self, coin: str, is_buy: bool, qty: float, reduce_only: bool = False,
                     leverage: Optional[float] = None) -> dict:
        self._require_live()
        sz = self._sz(coin, qty)
        if sz <= 0:
            raise BrokerError(f"{coin}: size rounds to 0")
        px = self.mid(coin)
        if sz * px < MIN_NOTIONAL_USD and not reduce_only:
            raise BrokerError(f"{coin}: notional ${sz * px:.2f} is below the $10 venue minimum")
        if not reduce_only:
            if leverage is None:
                raise BrokerError(f"{coin}: refusing an entry without explicit leverage")
            self.set_leverage(coin, leverage)
        limit = self._px(coin, px * (1 + config.SLIPPAGE if is_buy else 1 - config.SLIPPAGE))
        resp = self.exchange.order(coin, is_buy, sz, limit, {"limit": {"tif": "Ioc"}},
                                   reduce_only=reduce_only,
                                   cloid=self._cloid(coin, "close" if reduce_only else f"open-{is_buy}"),
                                   builder=self.builder())
        if not isinstance(resp, dict) or resp.get("status") != "ok":
            raise BrokerError(f"order rejected: {str(resp)[:300]}")
        s0 = resp["response"]["data"]["statuses"][0]
        if "error" in s0:
            raise BrokerError(f"order error: {s0['error']}")
        fill = s0.get("filled") or {}
        filled = float(fill.get("totalSz") or 0)
        if filled <= 0:
            raise BrokerError(f"{coin}: IOC got no fill")
        return {"oid": str(fill.get("oid") or ""), "filled": filled, "avg_px": float(fill.get("avgPx") or 0),
                "status": "filled" if filled >= sz * 0.999 else "partial", "requested": sz}

    def place_stop(self, coin: str, pos_side: str, qty: float, trigger_px: float) -> str:
        """Venue-resident reduce-only stop-market: protects the user even if our workers are down."""
        self._require_live()
        is_buy = pos_side == "short"
        trigger = self._px(coin, trigger_px)
        limit = self._px(coin, trigger * (1.05 if is_buy else 0.95))
        resp = self.exchange.order(coin, is_buy, self._sz(coin, qty), limit,
                                   {"trigger": {"triggerPx": trigger, "isMarket": True, "tpsl": "sl"}},
                                   reduce_only=True, cloid=self._cloid(coin, f"stop-{pos_side}"),
                                   builder=self.builder())
        if not isinstance(resp, dict) or resp.get("status") != "ok":
            raise BrokerError(f"stop rejected: {str(resp)[:300]}")
        s0 = resp["response"]["data"]["statuses"][0]
        if "error" in s0:
            raise BrokerError(f"stop error: {s0['error']}")
        return str((s0.get("resting") or s0.get("filled") or {}).get("oid") or "")

    def cancel_stops(self, coin: str) -> int:
        self._require_live()
        rows = []
        for dex in ("", self.dex):
            body = {"type": "frontendOpenOrders", "user": self.user}
            if dex:
                body["dex"] = dex
            rows += self.info.post("/info", body) or []
        n = 0
        for r in rows:
            if r.get("coin") == coin and r.get("reduceOnly") and r.get("triggerPx"):
                resp = self.exchange.cancel(coin, int(r["oid"]))
                n += int(isinstance(resp, dict) and resp.get("status") == "ok")
        return n
