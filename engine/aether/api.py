"""Engine HTTP API used by the web app's admin Strategy Lab (server-to-server only).

    uvicorn aether.api:app --port 8000

Every request must carry `Authorization: Bearer $ENGINE_API_TOKEN`. The web app only forwards
requests from users whose profile role is 'admin'.
"""
from __future__ import annotations

import hmac
import io
import os
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import data, indicators
from .backtest import StrategySpec, run_backtest
from .db import client
from .generator import generate
from .rules import RuleError

app = FastAPI(title="Aether Quant engine")


def auth(authorization: str = Header(default="")):
    token = os.getenv("ENGINE_API_TOKEN", "")
    if not token or not hmac.compare_digest(authorization, f"Bearer {token}"):
        raise HTTPException(401, "unauthorized")


class Rules(BaseModel):
    entry_long: Optional[str] = None
    exit_long: Optional[str] = None
    entry_short: Optional[str] = None
    exit_short: Optional[str] = None
    direction: str = "both"
    stop_loss_pct: Optional[float] = None
    take_profit_pct: Optional[float] = None
    leverage: float = 1.0


class BacktestReq(BaseModel):
    symbol: str
    timeframe: str = "1h"
    rules: Rules


class GenerateReq(BaseModel):
    symbol: str
    timeframe: str = "1h"
    n: int = 5
    candidates: Optional[list[dict]] = None
    keep_failed: bool = False


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/indicators", dependencies=[Depends(auth)])
async def compute_indicators(file: UploadFile = File(...), timeframe: str = Form("1h")):
    """Upload OHLCV CSV -> CSV with every indicator column appended."""
    try:
        df = indicators.compute(data.from_csv(await file.read()), timeframe)
    except ValueError as e:
        raise HTTPException(400, str(e))
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=indicators.csv"})


@app.post("/backtest", dependencies=[Depends(auth)])
def backtest(req: BacktestReq):
    market = client().table("markets").select("symbol, asset_class, hl_coin").eq("symbol", req.symbol).single().execute().data
    df = indicators.compute(data.ohlcv(req.symbol, req.timeframe, bars=5000, market=market), req.timeframe)
    spec = StrategySpec(**req.rules.model_dump(), timeframe=req.timeframe)
    try:
        return run_backtest(df, spec)
    except RuleError as e:
        raise HTTPException(400, str(e))


@app.post("/generate", dependencies=[Depends(auth)])
def gen(req: GenerateReq):
    try:
        return generate(client(), req.symbol, req.timeframe, n=req.n,
                        candidates=req.candidates, keep_failed=req.keep_failed)
    except Exception as e:
        raise HTTPException(502, f"generation failed: {e}")
