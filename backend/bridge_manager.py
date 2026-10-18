"""MT5 Bridge broker manager: a third provider next to MetaApi and MetaRPC.

The bridge (github.com/marketcalls/meta-docker) runs ONE MetaTrader 5 terminal, logged in to ONE broker account,
and exposes it over HTTP. So this provider is a single-account setup:

- The broker password never reaches this app. It lives in the bridge container's environment.
- Who may use the app is decided by BRIDGE_ACCESS_PASSWORD (set on this app). On the connect screen the person enters
  the MT5 account number (it must be the bridge's account), anything for the server, and the ACCESS password in
  the password box.
- Session tokens are signed as usual. Because there are no credentials to keep in memory, a restart of this app does
  not force a reconnect.

Settings: BRIDGE_URL (e.g. https://my-bridge.example.com), BRIDGE_API_KEY (the bridge's X-API-Key),
BRIDGE_ACCESS_PASSWORD (12+ characters).
"""
import asyncio
import hmac
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx

from broker_manager import (ApiError, BrokerManager, BrokerSession, ORDER_TYPES, TF_SECONDS, _epoch, _num,
                            explain_error)
from mrpc_manager import _g, _guess_category

log = logging.getLogger("kanairy.bridge")
BUILD = "bridge1-2026-10-18"

TF_BRIDGE = {"M1": "M1", "M5": "M5", "M15": "M15", "M30": "M30", "H1": "H1", "H4": "H4", "D1": "D1", "W1": "W1", "MN": "MN1"}
ORDER_TYPE_INT = {("buy", "limit"): 2, ("sell", "limit"): 3, ("buy", "stop"): 4, ("sell", "stop"): 5,
                  ("buy", "stop_limit"): 6, ("sell", "stop_limit"): 7}
PENDING_NAME = {2: "buy_limit", 3: "sell_limit", 4: "buy_stop", 5: "sell_stop", 6: "buy_stop_limit", 7: "sell_stop_limit"}
OK_RETCODES = {10008, 10009, 10010}          # placed, done, done partially
CID_TAG = "kr:"
FILLINGS = (2, 0, 1)                         # RETURN, FOK, IOC: brokers differ, so pending orders try each in turn


def _digits_guess(symbol: str) -> int:
    s = symbol.upper()
    if "JPY" in s:
        return 3
    if s.startswith(("XAU", "XPT", "XPD", "BTC", "ETH", "US500", "NAS", "US30", "GER", "UK100", "SPX")) or "OIL" in s:
        return 2
    if s.startswith("XAG"):
        return 3
    return 5


def _retcode_message(res: Dict[str, Any]) -> str:
    text = str(_g(res, "comment", "description", "message", default="") or "").strip()
    code = _g(res, "retcode")
    return f"{text} (code {code})" if code is not None and text else text or f"code {code}"


class BridgeHttp:
    def __init__(self, base_url: str, api_key: str, http: Optional[httpx.AsyncClient] = None):
        self.base = base_url.rstrip("/")
        self.api_key = api_key
        self.http = http or httpx.AsyncClient(timeout=20)

    async def request(self, method: str, path: str, params: Optional[Dict[str, Any]] = None,
                      body: Optional[Dict[str, Any]] = None) -> Any:
        q = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            r = await self.http.request(method, self.base + path, params=q, json=body, headers={"X-API-Key": self.api_key})
        except httpx.TimeoutException as e:
            raise ApiError(504, "The MT5 bridge did not answer in time. Try again.", "timeout") from e
        except httpx.HTTPError as e:
            raise ApiError(502, f"Could not reach the MT5 bridge ({type(e).__name__}). Check BRIDGE_URL and that the bridge is running.", "upstream_error") from e
        text = r.text or ""
        try:
            data = r.json()
        except ValueError:
            data = None
        if r.status_code < 400:
            return data
        detail = data.get("detail") if isinstance(data, dict) else None
        msg = (detail.get("message") or detail.get("description")) if isinstance(detail, dict) else (detail if isinstance(detail, str) else "")
        msg = str(msg or text[:200] or f"HTTP {r.status_code}")
        if r.status_code == 401:
            raise ApiError(502, "The MT5 bridge refused this app's API key. The server operator must check BRIDGE_API_KEY.", "bridge_auth")
        if r.status_code == 403:
            raise ApiError(403, "Trading is switched off on the MT5 bridge (read-only mode).", "read_only")
        if r.status_code == 429:
            raise ApiError(429, "The MT5 bridge is rate limiting requests. Wait a moment.", "rate_limited")
        if r.status_code == 503:
            raise ApiError(503, "The MT5 terminal is not logged in to the broker yet. Try again in a minute.", "upstream_error")
        if r.status_code == 404:
            raise ApiError(404, msg, "not_found")
        if r.status_code in (400, 422):
            raise ApiError(400, f"The bridge rejected the request: {msg}"[:300], "validation")
        log.warning("bridge %s %s -> HTTP %s %s", method, path, r.status_code, msg[:200])
        raise ApiError(502, f"The MT5 terminal said: {msg}"[:300], "upstream_error")

    async def get(self, path: str, **params) -> Any:
        return await self.request("GET", path, params)

    async def post(self, path: str, body: Optional[Dict[str, Any]] = None, **params) -> Any:
        return await self.request("POST", path, params, body if body is not None else {})


def _rows(res: Any, *keys: str) -> List[Dict[str, Any]]:
    if isinstance(res, dict):
        for k in keys:
            if isinstance(res.get(k), list):
                res = res[k]
                break
        else:
            res = []
    return [r for r in (res or []) if isinstance(r, dict)]


class BridgeSession(BrokerSession):
    def __init__(self, key: str, mgr: "BridgeManager", info: Dict[str, Any]):
        super().__init__(key, None, None, info)
        self.mgr = mgr
        self.platform = "mt5"
        self._cache: Dict[str, Any] = {}
        self._bad_syms: Dict[str, float] = {}

    @property
    def http(self) -> BridgeHttp:
        return self.mgr.client

    async def _cached(self, name: str, ttl: float, fn):
        hit = self._cache.get(name)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        val = await fn()
        self._cache[name] = (time.time(), val)
        return val

    # --- account
    async def account_info(self) -> Dict[str, Any]:
        self.last_used = time.time()
        raw = await self._cached("account", 1.5, lambda: self.http.get("/account"))
        margin = _num(_g(raw, "margin"))
        equity = _num(_g(raw, "equity"))
        margin_level = _num(_g(raw, "margin_level"))
        return {
            "login": str(_g(raw, "login", default=self.info["login"])),
            "name": _g(raw, "name", default="") or "",
            "broker": _g(raw, "company", default="") or self.info.get("broker_name") or "",
            "server": _g(raw, "server", default=self.info["server"]),
            "platform": "mt5",
            "currency": _g(raw, "currency", default="USD") or "USD",
            "leverage": _g(raw, "leverage"),
            "balance": _num(_g(raw, "balance")),
            "equity": equity,
            "margin": margin,
            "freeMargin": _num(_g(raw, "margin_free", "freeMargin")),
            "marginLevel": margin_level or ((equity / margin * 100) if margin > 0 else None),
            "credit": _num(_g(raw, "credit")),
            "tradeAllowed": bool(_g(raw, "trade_allowed", default=True)),
            "type": _g(raw, "trade_mode"),
        }

    # --- positions and pending orders
    async def _positions_raw(self) -> List[Dict[str, Any]]:
        return _rows(await self._cached("positions", 1.5, lambda: self.http.get("/positions")), "positions")

    async def _orders_raw(self) -> List[Dict[str, Any]]:
        return _rows(await self._cached("orders", 1.5, lambda: self.http.get("/orders")), "orders")

    def _bust(self):
        for k in ("positions", "orders", "account"):
            self._cache.pop(k, None)

    async def positions(self) -> List[Dict[str, Any]]:
        self.last_used = time.time()
        out = []
        for r in await self._positions_raw():
            out.append({
                "id": str(_g(r, "ticket", "identifier", default="")), "symbol": _g(r, "symbol"),
                "side": "sell" if _num(_g(r, "type")) == 1 else "buy",
                "volume": _num(_g(r, "volume")), "openPrice": _num(_g(r, "price_open")),
                "currentPrice": _num(_g(r, "price_current")),
                "stopLoss": _g(r, "sl") or None, "takeProfit": _g(r, "tp") or None,
                "profit": _num(_g(r, "profit")), "swap": _num(_g(r, "swap")), "commission": _num(_g(r, "commission")),
                "openTime": _epoch(_g(r, "time")), "comment": _g(r, "comment", default="") or "",
            })
        return out

    async def orders(self) -> List[Dict[str, Any]]:
        self.last_used = time.time()
        out = []
        for r in await self._orders_raw():
            t = int(_num(_g(r, "type")))
            if t not in PENDING_NAME:
                continue
            out.append({
                "id": str(_g(r, "ticket", default="")), "symbol": _g(r, "symbol"), "type": PENDING_NAME[t],
                "side": "buy" if t in (2, 4, 6) else "sell",
                "volume": _num(_g(r, "volume_current", "volume_initial", "volume")),
                "price": _num(_g(r, "price_open", "price")),
                "stopLimitPrice": _g(r, "price_stoplimit", "stoplimit") or None,
                "stopLoss": _g(r, "sl") or None, "takeProfit": _g(r, "tp") or None,
                "currentPrice": _g(r, "price_current"),
                "time": _epoch(_g(r, "time_setup", "time")), "expiration": _epoch(_g(r, "time_expiration")) or None,
                "comment": _g(r, "comment", default="") or "",
            })
        return out

    # --- symbols / specification / prices
    async def symbols(self) -> List[Dict[str, Any]]:
        res = await self._cached("symbols", 600, lambda: self.http.get("/symbols", search="*", limit=3000))
        names = res.get("symbols", []) if isinstance(res, dict) else (res or [])
        out = []
        for n in names:
            name = n if isinstance(n, str) else _g(n, "name", "symbol")
            if not name:
                continue
            out.append({"symbol": name, "description": "", "path": "", "category": _guess_category(name),
                        "digits": _digits_guess(name)})
        return out

    async def spec(self, symbol: str) -> Dict[str, Any]:
        if symbol not in self.spec_cache:
            raw = await self.http.get(f"/symbols/{symbol}")
            self.spec_cache[symbol] = {
                "symbol": symbol, "digits": _g(raw, "digits"), "tickSize": _g(raw, "trade_tick_size", "point"),
                "contractSize": _g(raw, "trade_contract_size"), "minVolume": _g(raw, "volume_min"),
                "maxVolume": _g(raw, "volume_max"), "volumeStep": _g(raw, "volume_step"),
            }
        return self.spec_cache[symbol]

    async def quotes(self, symbols: List[str]) -> Dict[str, Any]:
        self.last_used = time.time()
        sem = asyncio.Semaphore(6)

        async def one(sym: str):
            async def fetch():
                async with sem:
                    return await self.http.get(f"/symbols/{sym}/tick")
            if self._bad_syms.get(sym, 0) > time.time():
                return sym, None
            try:
                q = await self._cached("q:" + sym, 0.8, fetch)
            except ApiError as e:
                if e.code == "not_found":
                    self._bad_syms[sym] = time.time() + 600
                elif e.code in ("bridge_auth", "read_only"):
                    raise
                return sym, None
            bid, ask = _num(_g(q, "bid")), _num(_g(q, "ask"))
            if not bid and not ask:
                return sym, None
            return sym, {"bid": bid, "ask": ask, "time": _epoch(_g(q, "time")) or int(time.time())}

        wanted = symbols[:self.mgr.max_quotes]
        pairs = await asyncio.gather(*(one(s) for s in wanted))
        got = {s: q for s, q in pairs if q}
        if wanted and not got:
            raise ApiError(502, "No live prices are coming from your broker right now.", "upstream_error")
        return got

    async def candles(self, symbol: str, timeframe: str, limit: int, before: Optional[int]) -> List[Dict[str, Any]]:
        if timeframe not in TF_BRIDGE:
            raise ApiError(400, f"Unsupported timeframe {timeframe}")
        limit = max(1, min(limit, 5000))
        if before:
            span = TF_SECONDS[timeframe] * (limit + 5)
            res = await self.http.get(f"/rates/{symbol}", timeframe=TF_BRIDGE[timeframe], time_from=int(before - span), time_to=int(before) - 1)
        else:
            res = await self.http.get(f"/rates/{symbol}", timeframe=TF_BRIDGE[timeframe], count=limit)
        rows, seen = [], set()
        for c in _rows(res, "rates"):
            t = _epoch(_g(c, "time"))
            if t is None or t in seen or (before and t >= before):
                continue
            seen.add(t)
            rows.append({"t": t, "o": _num(_g(c, "open")), "h": _num(_g(c, "high")), "l": _num(_g(c, "low")),
                         "c": _num(_g(c, "close")), "v": _num(_g(c, "tick_volume", "real_volume"))})
        rows.sort(key=lambda r: r["t"])
        return rows[-limit:]

    async def history(self, days: int) -> List[Dict[str, Any]]:
        days = max(1, min(days, 365))
        end = datetime.now(timezone.utc) + timedelta(minutes=5)
        start = end - timedelta(days=days)
        res = await self.http.get("/history/deals", time_from=int(start.timestamp()), time_to=int(end.timestamp()))
        out = []
        for d in _rows(res, "deals"):
            t = int(_num(_g(d, "type")))
            when = _epoch(_g(d, "time"))
            if t >= 2:                                   # balance, credit, charge, correction, bonus ...
                out.append({"id": str(_g(d, "ticket", default="")), "kind": "balance", "symbol": "", "time": when,
                            "profit": _num(_g(d, "profit")), "comment": _g(d, "comment", default="") or "Balance"})
                continue
            entry = {0: "in", 1: "out", 2: "inout", 3: "out_by"}.get(int(_num(_g(d, "entry"))), "")
            out.append({"id": str(_g(d, "ticket", default="")), "kind": "deal", "symbol": _g(d, "symbol"),
                        "side": "sell" if t == 1 else "buy", "entry": entry,
                        "volume": _num(_g(d, "volume")), "price": _num(_g(d, "price")),
                        "profit": _num(_g(d, "profit")), "swap": _num(_g(d, "swap")), "commission": _num(_g(d, "commission")),
                        "positionId": str(_g(d, "position_id", default="") or ""), "time": when,
                        "comment": _g(d, "comment", default="") or ""})
        out.sort(key=lambda r: r["time"] or 0, reverse=True)
        return out

    # --- idempotency: the client order id rides in the order comment ("kr:<id>") and is searched for on a timeout
    async def find_by_client_id(self, cid: str) -> Optional[Dict[str, Any]]:
        tag = CID_TAG + cid
        self._bust()
        for r in await self._positions_raw():
            if tag in str(_g(r, "comment", default="")):
                tk = str(_g(r, "ticket", default=""))
                return {"status": "executed", "positionId": tk, "orderId": tk}
        for r in await self._orders_raw():
            if tag in str(_g(r, "comment", default="")):
                return {"status": "working", "orderId": str(_g(r, "ticket", default="")), "positionId": ""}
        try:
            end = datetime.now(timezone.utc) + timedelta(minutes=5)
            res = await self.http.get("/history/deals", time_from=int((end - timedelta(hours=6)).timestamp()), time_to=int(end.timestamp()))
            for r in _rows(res, "deals"):
                if tag in str(_g(r, "comment", default="")):
                    pid = str(_g(r, "position_id", default="") or "")
                    return {"status": "executed", "orderId": str(_g(r, "order", default="") or ""), "positionId": pid}
        except Exception:  # noqa: BLE001 - history is a best-effort second look
            pass
        return None

    # --- trading
    @staticmethod
    def _check_result(res: Any, what: str) -> Dict[str, Any]:
        """A trade call can answer HTTP 200 with a refusal retcode: turn that into a clear error."""
        code = _g(res, "retcode") if isinstance(res, dict) else None
        if code is not None and int(_num(code)) not in OK_RETCODES:
            raise ApiError(400, f"Broker refused the {what}: {_retcode_message(res)}"[:300], "trade_rejected")
        return res if isinstance(res, dict) else {}

    async def _place_order_raw(self, req: Dict[str, Any], cid: Optional[str]) -> Dict[str, Any]:
        symbol, side, otype = req["symbol"], req["side"], req["type"]
        volume = float(req["volume"])
        sl, tp = req.get("stopLoss"), req.get("takeProfit")
        price, limit_price = req.get("price"), req.get("stopLimitPrice")
        if side not in ("buy", "sell"):
            raise ApiError(400, "side must be buy or sell")
        if otype not in ORDER_TYPES:
            raise ApiError(400, "Unsupported order type")
        if volume <= 0:
            raise ApiError(400, "Volume must be greater than zero")
        try:
            spec = await self.spec(symbol)
        except ApiError as e:
            if e.code == "not_found":
                raise ApiError(400, f"Your broker has no symbol called {symbol}.", "validation")
            spec = None
        vmin, vmax, vstep = (_num(spec.get("minVolume")), _num(spec.get("maxVolume")), _num(spec.get("volumeStep"))) if spec else (0, 0, 0)
        if vstep and abs(round(volume / vstep) * vstep - volume) > 1e-9 * max(1, volume / vstep):
            raise ApiError(400, f"Volume for {symbol} must be a multiple of {vstep} lots")
        if vmin and volume < vmin - 1e-12:
            raise ApiError(400, f"Minimum volume for {symbol} is {vmin} lots")
        if vmax and volume > vmax + 1e-12:
            raise ApiError(400, f"Maximum volume for {symbol} is {vmax} lots")
        if otype != "market" and not price:
            raise ApiError(400, "A price is required for pending orders")
        if otype == "stop_limit" and not limit_price:
            raise ApiError(400, "A stop-limit price is required for stop-limit orders")
        if otype != "market":
            if sl and (sl >= price if side == "buy" else sl <= price):
                raise ApiError(400, "For a buy the stop loss must be below the entry price." if side == "buy" else "For a sell the stop loss must be above the entry price.", "validation")
            if tp and (tp <= price if side == "buy" else tp >= price):
                raise ApiError(400, "For a buy the take profit must be above the entry price." if side == "buy" else "For a sell the take profit must be below the entry price.", "validation")
        comment = (CID_TAG + cid) if cid else (req.get("comment") or "KanAIRY")[:26]
        if otype == "market":
            body = {"symbol": symbol, "side": side, "volume": volume, "comment": comment[:31], "deviation": 20}
            if sl:
                body["sl"] = sl
            if tp:
                body["tp"] = tp
            res = self._check_result(await self.http.post("/orders/market", body), "order")
            self._bust()
            ticket = str(_g(res, "order", "deal", default="") or "")
            return {"ok": True, "orderId": ticket, "positionId": ticket, "code": _g(res, "retcode"),
                    "message": _g(res, "comment", default="Order accepted") or "Order accepted"}
        last: Optional[ApiError] = None
        for fill in FILLINGS:
            body = {"action": 5, "symbol": symbol, "volume": volume, "type": ORDER_TYPE_INT[(side, otype)], "price": price,
                    "sl": sl or 0.0, "tp": tp or 0.0, "type_time": 0, "type_filling": fill, "comment": comment[:31]}
            if otype == "stop_limit":
                body["stoplimit"] = limit_price
            try:
                res = self._check_result(await self.http.post("/orders/send", body), "order")
            except ApiError as e:
                last = e
                if e.code == "trade_rejected" and "10030" in e.message:      # 10030: filling mode unsupported, try the next
                    continue
                raise
            self._bust()
            ticket = str(_g(res, "order", default="") or "")
            return {"ok": True, "orderId": ticket, "positionId": "", "code": _g(res, "retcode"),
                    "message": _g(res, "comment", default="Order accepted") or "Order accepted"}
        raise last or ApiError(502, "The broker did not accept the order.", "upstream_error")

    async def _position(self, position_id: str) -> Dict[str, Any]:
        cur = next((p for p in await self._positions_raw() if str(_g(p, "ticket")) == str(position_id)), None)
        if cur is None:
            raise ApiError(404, "That position is no longer open.", "not_found")
        return cur

    async def modify_position(self, position_id: str, sl, tp) -> Dict[str, Any]:
        cur = await self._position(position_id)
        sl = _num(_g(cur, "sl")) if sl is None else sl
        tp = _num(_g(cur, "tp")) if tp is None else tp
        self._check_result(await self.http.post("/orders/send", {"action": 6, "symbol": _g(cur, "symbol"), "position": int(position_id),
                                                                  "sl": float(sl or 0), "tp": float(tp or 0)}), "change")
        self._bust()
        return {"ok": True, "message": "Position updated"}

    async def close_position(self, position_id: str, volume: Optional[float]) -> Dict[str, Any]:
        cur = await self._position(position_id)
        full = _num(_g(cur, "volume"))
        if not volume or volume >= full - 1e-12:
            self._check_result(await self.http.post(f"/positions/{position_id}/close", {}, deviation=20), "close")
            self._bust()
            return {"ok": True, "message": "Position closed"}
        is_buy = _num(_g(cur, "type")) == 0
        symbol = _g(cur, "symbol")
        tick = await self.http.get(f"/symbols/{symbol}/tick")
        price = _num(_g(tick, "bid" if is_buy else "ask"))
        last: Optional[ApiError] = None
        for fill in (1, 0, 2):
            body = {"action": 1, "symbol": symbol, "position": int(position_id), "volume": float(volume),
                    "type": 1 if is_buy else 0, "price": price, "deviation": 20, "type_filling": fill}
            try:
                self._check_result(await self.http.post("/orders/send", body), "close")
            except ApiError as e:
                last = e
                if e.code == "trade_rejected" and "10030" in e.message:
                    continue
                raise
            self._bust()
            return {"ok": True, "message": "Position partly closed"}
        raise last or ApiError(502, "The broker did not accept the close.", "upstream_error")

    async def cancel_order(self, order_id: str) -> Dict[str, Any]:
        self._check_result(await self.http.post("/orders/send", {"action": 8, "order": int(order_id)}), "cancel")
        self._bust()
        return {"ok": True, "message": "Order cancelled"}

    async def modify_order(self, order_id: str, price, sl, tp) -> Dict[str, Any]:
        cur = next((o for o in await self._orders_raw() if str(_g(o, "ticket")) == str(order_id)), None)
        if cur is None:
            raise ApiError(404, "That order is no longer pending.", "not_found")
        price = _num(_g(cur, "price_open")) if price is None else price
        sl = _num(_g(cur, "sl")) if sl is None else sl
        tp = _num(_g(cur, "tp")) if tp is None else tp
        body = {"action": 7, "order": int(order_id), "symbol": _g(cur, "symbol"), "price": float(price),
                "sl": float(sl or 0), "tp": float(tp or 0), "type_time": 0}
        if _g(cur, "price_stoplimit"):
            body["stoplimit"] = float(_g(cur, "price_stoplimit"))
        self._check_result(await self.http.post("/orders/send", body), "change")
        self._bust()
        return {"ok": True, "message": "Order updated"}


class BridgeManager(BrokerManager):
    """Same public surface as BrokerManager, backed by one MT5 bridge."""

    def __init__(self, url: str, api_key: str, access_password: str, http: Optional[httpx.AsyncClient] = None):
        self.token = api_key
        self.client = BridgeHttp(url, api_key, http)
        self.http = self.client.http
        self.access_password = access_password
        self.max_quotes = max(1, int(os.getenv("BRIDGE_MAX_QUOTES", "12") or 12))
        self.sessions: Dict[str, BridgeSession] = {}
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self._attach_locks: Dict[str, asyncio.Lock] = {}
        self._broker_cache: Dict[str, Any] = {}

    async def search_brokers(self, query: str, version: int = 5) -> Dict[str, List[str]]:
        return {}

    async def popular_brokers(self, version: int = 5) -> Dict[str, List[str]]:
        return {}

    async def _account(self) -> Dict[str, Any]:
        health = await self.client.get("/health")
        if isinstance(health, dict) and health.get("connected") is False:
            raise ApiError(503, "The MT5 terminal is running but not logged in to the broker yet. Try again in a minute.", "upstream_error")
        return await self.client.get("/account")

    def _session(self, acct: Dict[str, Any], broker_name: str = "") -> BridgeSession:
        login = str(_g(acct, "login", default=""))
        server = str(_g(acct, "server", default="") or "bridge")
        key = self.key(login, server)
        sess = self.sessions.get(key)
        if sess is None:
            sess = BridgeSession(key, self, {"login": login, "server": server, "platform": "mt5",
                                             "broker_name": broker_name or str(_g(acct, "company", default="") or "")})
            self.sessions[key] = sess
        sess.last_used = time.time()
        return sess

    async def _connect_job(self, job_id, login, password, server, platform, broker_name, on_ready):
        try:
            self._set(job_id, "connecting", "Checking the access password")
            if not hmac.compare_digest(password.encode(), self.access_password.encode()):
                raise ApiError(401, "Wrong access password. Use the BRIDGE_ACCESS_PASSWORD set on the server (not your broker password).", "bad_credentials")
            self._set(job_id, "syncing", "Contacting the MT5 terminal")
            acct = await self._account()
            if str(_g(acct, "login", default="")) != str(login).strip():
                raise ApiError(401, "That account number is not the one this server trades. Use the MT5 account number the bridge is logged in with.", "bad_credentials")
            session = self._session(acct, broker_name)
            info = await session.account_info()
            token = await on_ready(session, info)
            self._set(job_id, "ready", "Connected", token=token, account=info)
        except Exception as e:  # noqa: BLE001
            err = e if isinstance(e, ApiError) else explain_error(e)
            log.warning("bridge connect failed for login %s -> %s (%s)", login, err.code, err.status)
            self._set(job_id, "failed", err.message, code=err.code)

    async def session_for(self, claims: Dict[str, Any]) -> BridgeSession:
        key = self.key(claims["login"], claims["server"])
        sess = self.sessions.get(key)
        if sess:
            sess.last_used = time.time()
            return sess
        lock = self._attach_locks.setdefault(key, asyncio.Lock())
        async with lock:
            sess = self.sessions.get(key)
            if sess:
                return sess
            acct = await self._account()                 # no credentials to restore: just confirm it is still the same account
            if str(_g(acct, "login", default="")) != str(claims["login"]):
                raise ApiError(401, "The bridge now trades a different account. Connect again.", "relink")
            return self._session(acct, claims.get("broker", ""))

    async def drop(self, claims: Dict[str, Any]):
        self.sessions.pop(self.key(claims["login"], claims["server"]), None)

    async def reap_idle(self, max_idle: Optional[int] = None):
        for key, sess in list(self.sessions.items()):
            if time.time() - sess.last_used > 6 * 3600:
                self.sessions.pop(key, None)
