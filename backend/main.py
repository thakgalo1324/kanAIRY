"""KanAIRY Trading API.

Serves the web app and a JSON API in front of a broker gateway (MetaRPC or
MetaApi, chosen by BROKER_PROVIDER) plus public market data, news and the
economic calendar. Every account/trading route requires a signed session token.
"""
import asyncio
import logging
import mimetypes
import os
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv  # noqa: E402

load_dotenv()
logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")

from fastapi import Depends, FastAPI, Header, Query, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

import auth  # noqa: E402
from broker_manager import ApiError, BrokerManager, explain_error  # noqa: E402
from bridge_manager import BridgeManager  # noqa: E402
from mrpc_manager import BUILD as MRPC_BUILD, DIAG as MRPC_DIAG, INSTANCE as MRPC_INSTANCE, MrpcManager  # noqa: E402
from models import ClosePositionRequest, ConnectRequest, ModifyRequest, OrderRequest  # noqa: E402
from public_data import BY_SYMBOL, CATALOG, PublicData, PublicError  # noqa: E402

# Some systems (notably Windows with odd registry entries) serve .js as text/plain, and browsers refuse
# to run ES modules with that type: the page then loads but stays blank. Pin the types explicitly.
for _ext, _type in ((".js", "application/javascript"), (".mjs", "application/javascript"), (".css", "text/css"),
                    (".svg", "image/svg+xml"), (".json", "application/json"), (".webmanifest", "application/manifest+json")):
    mimetypes.add_type(_type, _ext)

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

app = FastAPI(title="KanAIRY Trading API", version="3.0.0", docs_url="/api/docs", redoc_url=None)

allowed = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed or [],          # same-origin by default; set ALLOWED_ORIGINS to open it up
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

# Behind a hosting proxy (Pxxl, Render...) every request seems to come from the proxy's address, so the rate limiter
# would treat all visitors as one person. Trust X-Forwarded-For when told to (TRUST_PROXY=1, or on Pxxl).
if os.getenv("TRUST_PROXY", "").strip().lower() in ("1", "true", "yes") or os.getenv("PXXL_ENV"):
    try:
        from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")
    except Exception:  # noqa: BLE001 - never stop the app from starting over this
        logging.getLogger("kanairy").warning("could not enable proxy headers")

public = PublicData()
manager: Optional[BrokerManager] = None
_metaapi_token = os.getenv("METAAPI_TOKEN", "").strip()
_mrpc_key = os.getenv("MRPC_API_KEY", "").strip()
_bridge_url = os.getenv("BRIDGE_URL", "").strip()
_bridge_key = os.getenv("BRIDGE_API_KEY", "").strip()
_bridge_pw = os.getenv("BRIDGE_ACCESS_PASSWORD", "").strip()
# BROKER_PROVIDER picks the gateway: metarpc, metaapi or bridge. Unset: bridge if BRIDGE_URL is set, else MetaRPC when
# its key is set, else MetaApi.
PROVIDER = (os.getenv("BROKER_PROVIDER") or ("bridge" if _bridge_url else "metarpc" if _mrpc_key else "metaapi")).strip().lower()
IDLE_SECONDS = int(os.getenv("MRPC_IDLE_SECONDS", "600") or 600)


async def _catalog_symbols():
    """Symbol list for MetaRPC mode: MetaRPC has no cheap 'list all symbols' call, so use the app's own catalogue."""
    return [{"symbol": c["symbol"], "description": c["name"], "category": c["cat"], "digits": c["digits"], "path": ""} for c in CATALOG]


def get_manager() -> BrokerManager:
    global manager
    if manager is None:
        if PROVIDER == "bridge":
            if not (_bridge_url and _bridge_key):
                raise ApiError(503, "Broker access is not configured. Set BRIDGE_URL and BRIDGE_API_KEY on the server.", "not_configured")
            if len(_bridge_pw) < 12:
                raise ApiError(503, "Set BRIDGE_ACCESS_PASSWORD (12+ characters) on the server: it decides who may use this app.", "not_configured")
            manager = BridgeManager(_bridge_url, _bridge_key, _bridge_pw)
        elif PROVIDER == "metarpc":
            if not _mrpc_key:
                raise ApiError(503, "Broker access is not configured. Set MRPC_API_KEY on the server.", "not_configured")
            manager = MrpcManager(_mrpc_key, idle_seconds=IDLE_SECONDS, fallback_candles=public.candles,
                                  fallback_symbols=_catalog_symbols)
        else:
            if not _metaapi_token:
                raise ApiError(503, "Broker access is not configured. Set METAAPI_TOKEN on the server.", "not_configured")
            manager = BrokerManager(_metaapi_token)
    return manager


# ---------- errors ----------
@app.exception_handler(ApiError)
async def _api_error(_: Request, exc: ApiError):
    return JSONResponse({"error": exc.message, "code": exc.code}, status_code=exc.status)


@app.exception_handler(PublicError)
async def _public_error(_: Request, exc: PublicError):
    return JSONResponse({"error": exc.message, "code": "public_feed"}, status_code=exc.status)


@app.exception_handler(Exception)
async def _unhandled(_: Request, exc: Exception):
    err = explain_error(exc)
    return JSONResponse({"error": err.message, "code": err.code}, status_code=err.status)


# ---------- auth dependency ----------
def claims_dep(authorization: Optional[str] = Header(None)) -> dict:
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    claims = auth.verify_token(token)
    if not claims:
        raise ApiError(401, "Your session has expired. Connect your account again.", "unauthenticated")
    return claims


async def session_dep(claims: dict = Depends(claims_dep)):
    return await get_manager().session_for(claims)


# ---------- connect rate limit (per client IP) ----------
_attempts = defaultdict(deque)


def _limit(ip: str, limit: int = 8, window: int = 300, what: str = "connection attempts"):
    q = _attempts[ip]
    now = time.time()
    if len(_attempts) > 5000:
        for k in [k for k, v in _attempts.items() if not v or now - v[-1] > window]:
            _attempts.pop(k, None)
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        raise ApiError(429, f"Too many {what}. Wait a moment and try again.", "rate_limited")
    q.append(now)


# ---------- health ----------
@app.middleware("http")
async def _instance_header(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Instance"] = MRPC_INSTANCE          # lets the browser notice if two copies of the app answer in turn
    return resp


@app.post("/api/diag")
async def client_diag(request: Request):
    """Browser-side connection events (only when MRPC_DEBUG=1). Contains no secrets: kind + short message."""
    if os.getenv("MRPC_DEBUG", "").strip() in ("", "0", "false"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    try:
        d = await request.json()
        MRPC_DIAG.append(f"{time.strftime('%H:%M:%S')} CLIENT {str(d.get('k', ''))[:30]} | {str(d.get('m', ''))[:300]} | inst {MRPC_INSTANCE}")
    except Exception:  # noqa: BLE001
        pass
    return JSONResponse({"ok": True})


@app.get("/api/health/mrpc")
async def health_mrpc():
    """Recent MetaRPC failures and the first reply of each call. Only when MRPC_DEBUG=1; turn it off afterwards."""
    if os.getenv("MRPC_DEBUG", "").strip() in ("", "0", "false"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    return {"build": MRPC_BUILD, "instance": MRPC_INSTANCE, "provider": PROVIDER, "lines": list(MRPC_DIAG)}


@app.get("/api/health")
async def health():
    configured = (bool(_bridge_url and _bridge_key and len(_bridge_pw) >= 12) if PROVIDER == "bridge"
                  else bool(_mrpc_key) if PROVIDER == "metarpc" else bool(_metaapi_token))
    return {"status": "ok", "provider": PROVIDER, "mrpc_build": MRPC_BUILD, "instance": MRPC_INSTANCE, "metaapi": "configured" if _metaapi_token else "missing",
            "metarpc": "configured" if _mrpc_key else "missing", "broker": "configured" if configured else "missing",
            "time": int(time.time())}


# ---------- broker directory ----------
@app.get("/api/brokers/search")
async def brokers_search(q: str = Query(..., min_length=2, max_length=60), platform: int = Query(5, ge=4, le=5)):
    return {"brokers": await get_manager().search_brokers(q, platform)}


@app.get("/api/brokers/popular")
async def brokers_popular(platform: int = Query(5, ge=4, le=5)):
    return {"brokers": await get_manager().popular_brokers(platform)}


# ---------- connect / session ----------
async def _on_ready(session, info):
    claims = {"login": session.info["login"], "server": session.info["server"],
              "platform": session.info["platform"], "broker": session.info.get("broker_name", "")}
    return auth.sign_token(claims)


@app.post("/api/auth/connect", status_code=202)
async def connect(body: ConnectRequest, request: Request):
    _limit(request.client.host if request.client else "unknown")
    _limit("login:" + body.login.strip() + "|" + body.server.strip().lower(), limit=6, window=900)
    job, poll = await get_manager().start_connect(body.login, body.password, body.server, body.platform,
                                                  body.broker_name, _on_ready)
    return {"job": job, "poll": poll}


@app.get("/api/auth/connect/{job}")
async def connect_status(job: str, x_poll_key: str = Header("")):
    return get_manager().job(job, x_poll_key)


@app.get("/api/auth/me")
async def me(session=Depends(session_dep)):
    return await session.account_info()


@app.post("/api/auth/logout")
async def logout(claims: dict = Depends(claims_dep)):
    await get_manager().drop(claims)
    return {"ok": True}


# ---------- market (broker) ----------
@app.get("/api/market/symbols")
async def market_symbols(session=Depends(session_dep)):
    return {"symbols": await session.symbols()}


@app.get("/api/market/quotes")
async def market_quotes(symbols: str = Query(..., max_length=2000), session=Depends(session_dep)):
    names = [s for s in symbols.split(",") if s][:60]
    return {"quotes": await session.quotes(names)}


@app.get("/api/market/candles")
async def market_candles(symbol: str, timeframe: str = "H1", limit: int = Query(500, ge=1, le=1000),
                         before: Optional[int] = None, session=Depends(session_dep)):
    return {"candles": await session.candles(symbol, timeframe, limit, before)}


# ---------- trading ----------
@app.get("/api/trading/snapshot")
async def snapshot(session=Depends(session_dep)):
    account, positions, orders = await asyncio.gather(session.account_info(), session.positions(), session.orders())
    return {"account": account, "positions": positions, "orders": orders, "time": int(time.time())}


@app.get("/api/trading/history")
async def history(days: int = Query(30, ge=1, le=365), session=Depends(session_dep)):
    return {"deals": await session.history(days)}


@app.post("/api/trading/order")
async def place_order(body: OrderRequest, session=Depends(session_dep)):
    _limit("order:" + session.key, limit=20, window=60, what="orders")
    return await session.place_order(body.model_dump())


@app.get("/api/trading/order-status/{client_id}")
async def order_status(client_id: str, session=Depends(session_dep)):
    _limit("ostat:" + session.key, limit=60, window=60, what="status checks")
    return await session.order_status(client_id)


@app.post("/api/trading/positions/{position_id}/close")
async def close_position(position_id: str, body: ClosePositionRequest, session=Depends(session_dep)):
    _limit("mod:" + session.key, limit=60, window=60, what="trade changes")
    return await session.close_position(position_id, body.volume)


@app.patch("/api/trading/positions/{position_id}")
async def modify_position(position_id: str, body: ModifyRequest, session=Depends(session_dep)):
    _limit("mod:" + session.key, limit=60, window=60, what="trade changes")
    return await session.modify_position(position_id, body.stopLoss, body.takeProfit)


@app.patch("/api/trading/orders/{order_id}")
async def modify_order(order_id: str, body: ModifyRequest, session=Depends(session_dep)):
    _limit("mod:" + session.key, limit=60, window=60, what="trade changes")
    if not body.price:
        raise ApiError(400, "A price is required")
    return await session.modify_order(order_id, body.price, body.stopLoss, body.takeProfit)


@app.delete("/api/trading/orders/{order_id}")
async def cancel_order(order_id: str, session=Depends(session_dep)):
    _limit("mod:" + session.key, limit=60, window=60, what="trade changes")
    return await session.cancel_order(order_id)


# ---------- public data (no account needed) ----------
@app.get("/api/public/instruments")
async def public_instruments():
    return {"instruments": [{k: c[k] for k in ("symbol", "name", "cat", "digits")} for c in CATALOG]}


@app.get("/api/public/quotes")
async def public_quotes(symbols: str = Query(..., max_length=1000)):
    return {"quotes": await public.quotes([s for s in symbols.split(",") if s])}


@app.get("/api/public/candles")
async def public_candles(symbol: str, timeframe: str = "H1", limit: int = Query(600, ge=1, le=2000)):
    if symbol not in BY_SYMBOL:
        raise PublicError(404, "Unknown instrument")
    return {"candles": await public.candles(symbol, timeframe, limit)}


@app.get("/api/news")
async def news(source: str = "all"):
    return {"articles": await public.news(source), "sources": {k: v[0] for k, v in PublicData.NEWS_FEEDS.items()}}


@app.get("/api/calendar")
async def calendar(week: str = "this"):
    return {"events": await public.calendar(week)}


# ---------- lifecycle ----------
@app.on_event("startup")
async def _startup():
    try:
        auth.sign_token({"probe": 1})
    except RuntimeError as e:
        print(f"WARNING: {e}")

    async def reaper():
        while True:
            await asyncio.sleep(60 if PROVIDER in ("metarpc", "bridge") else 300)
            if manager:
                try:
                    await manager.reap_idle()
                except Exception:  # noqa: BLE001 - the reaper must never die
                    logging.getLogger("kanairy").exception("idle reaper failed")
    asyncio.create_task(reaper())


# ---------- web app ----------
@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/manifest.json", include_in_schema=False)
async def manifest():
    return FileResponse(STATIC / "manifest.json", media_type="application/manifest+json")


class _Static(StaticFiles):
    """Static files that browsers revalidate every time, so a redeploy never leaves people on stale scripts."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        if path.endswith((".js", ".mjs")):
            resp.headers["Content-Type"] = "application/javascript; charset=utf-8"
        return resp


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(STATIC / "img" / "icon.svg", media_type="image/svg+xml")


app.mount("/static", _Static(directory=str(STATIC)), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8000)))
