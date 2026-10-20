"""KanAIRY API.

Serves the web app plus public market data, news and the economic calendar.
Trading happens in the embedded MetaQuotes MT5 Web terminal, so this server holds
no broker credentials, no accounts and needs no secrets.
"""
import logging
import mimetypes
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv  # noqa: E402

load_dotenv()
logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")

from fastapi import FastAPI, Query, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402

from public_data import BY_SYMBOL, CATALOG, PublicData, PublicError  # noqa: E402

log = logging.getLogger("kanairy")

# Some systems (notably Windows with odd registry entries) serve .js as text/plain, and browsers refuse
# to run ES modules with that type: the page then loads but stays blank. Pin the types explicitly.
for _ext, _type in ((".js", "application/javascript"), (".mjs", "application/javascript"), (".css", "text/css"),
                    (".svg", "image/svg+xml"), (".json", "application/json"), (".webmanifest", "application/manifest+json")):
    mimetypes.add_type(_type, _ext)

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"

app = FastAPI(title="KanAIRY API", version="4.0.0", docs_url="/api/docs", redoc_url=None)

allowed = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed or [],          # same-origin by default; set ALLOWED_ORIGINS to open it up
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)

# Behind a hosting proxy (Pxxl, Render...) the client address is in X-Forwarded-For. Trust it when told to
# (TRUST_PROXY=1, or automatically on Pxxl).
if os.getenv("TRUST_PROXY", "").strip().lower() in ("1", "true", "yes") or os.getenv("PXXL_ENV"):
    try:
        from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")
    except Exception:  # noqa: BLE001 - never stop the app from starting over this
        log.warning("could not enable proxy headers")

public = PublicData()


# ---------- errors ----------
@app.exception_handler(PublicError)
async def _public_error(_: Request, exc: PublicError):
    return JSONResponse({"error": exc.message, "code": "public_feed"}, status_code=exc.status)


@app.exception_handler(Exception)
async def _unhandled(_: Request, exc: Exception):
    log.exception("unhandled error")
    return JSONResponse({"error": "Something went wrong on the server. Try again.", "code": "server_error"}, status_code=500)


# ---------- health ----------
@app.get("/api/health")
async def health():
    return {"status": "ok", "time": int(time.time())}


@app.get("/api/health/feed")
async def health_feed():
    """Open this in a browser to see whether the server can reach the price feed (EURUSD test)."""
    try:
        res = await public._chart("EURUSD=X", "1h", "1d")
        return {"feed": "ok", "points": len(res.get("timestamp") or []), "detail": public.last_feed}
    except PublicError as e:
        return {"feed": "failing", "error": e.message, "detail": public.last_feed}


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
