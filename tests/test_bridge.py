"""MT5 bridge adapter tests against a fake bridge (httpx MockTransport; no network).
Run: python3 tests/test_bridge.py"""
import asyncio, json, os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
os.environ["SESSION_SECRET"] = "x" * 32
try:
    import httpx  # noqa
except ImportError:
    sys.path.insert(0, os.path.dirname(__file__)); import httpx_stub  # noqa
    import httpx
from broker_manager import ApiError
from bridge_manager import BridgeManager

PW = "access-password-123"

class Fake:
    def __init__(self):
        self.log = []; self.read_only = False; self.connected = True
        self.positions = [{"ticket": 7, "symbol": "EURUSD", "type": 0, "volume": 0.2, "price_open": 1.1, "price_current": 1.101, "sl": 1.09, "tp": 0.0, "profit": 2.0, "time": 1781227000, "comment": "x"}]
        self.orders = [{"ticket": 9, "symbol": "EURUSD", "type": 2, "volume_current": 0.1, "price_open": 1.05, "sl": 0.0, "tp": 0.0, "time_setup": 1781227000, "comment": ""}]
        self.fill_reject = {2}            # filling modes the "broker" refuses for pending orders
        self.lose_reply_once = False
    def handler(self, req):
        path, q, method = req.url.path, req.url.params, req.method
        body = json.loads(req.content) if req.content else None
        self.log.append((method, path, q, body))
        assert req.headers.get("x-api-key") == "KEY"
        if path == "/health": return httpx.Response(200, json={"status": "ok", "connected": self.connected})
        if path == "/account": return httpx.Response(200, json={"login": 123456, "server": "Demo-Server", "balance": 1000.0, "equity": 1010.0, "margin": 10.0, "margin_free": 1000.0, "currency": "USD", "leverage": 100, "trade_allowed": True, "company": "MetaQuotes Ltd.", "name": "T"})
        if path == "/positions": return httpx.Response(200, json={"positions": self.positions})
        if path == "/orders": return httpx.Response(200, json={"orders": self.orders})
        if path == "/symbols": return httpx.Response(200, json={"total": 3, "symbols": ["EURUSD", "USDJPY", "XAUUSD"]})
        if path.startswith("/symbols/") and path.endswith("/tick"):
            sym = path.split("/")[2]
            if sym == "NOPE": return httpx.Response(404, json={"detail": "unknown symbol"})
            return httpx.Response(200, json={"time": 1781227214, "bid": 1.1, "ask": 1.1002})
        if path.startswith("/symbols/"):
            if path.split("/")[2] == "NOPE": return httpx.Response(404, json={"detail": "unknown symbol"})
            return httpx.Response(200, json={"digits": 5, "volume_min": 0.01, "volume_max": 50.0, "volume_step": 0.01, "trade_tick_size": 1e-05, "trade_contract_size": 100000.0})
        if path.startswith("/rates/"):
            return httpx.Response(200, json={"symbol": "EURUSD", "rates": [{"time": 1781226900, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "tick_volume": 10}, {"time": 1781226600, "open": 1.5, "high": 2, "low": 1, "close": 1.7, "tick_volume": 11}]})
        if path == "/history/deals":
            return httpx.Response(200, json={"deals": [{"ticket": 1, "type": 0, "entry": 1, "symbol": "EURUSD", "volume": 0.1, "price": 1.2, "profit": 5.0, "time": 1781227100, "position_id": 7, "comment": ""}, {"ticket": 2, "type": 2, "entry": 0, "profit": 100.0, "time": 1781227000, "comment": "deposit"}]})
        if self.read_only and method == "POST": return httpx.Response(403, json={"detail": "read-only mode"})
        if path == "/orders/market":
            self.positions.append({"ticket": 500 + len(self.log), "symbol": body["symbol"], "type": 0 if body["side"] == "buy" else 1, "volume": body["volume"], "price_open": 1.1, "price_current": 1.1, "sl": 0.0, "tp": 0.0, "profit": 0.0, "time": 1781227200, "comment": body.get("comment", "")})
            if body["volume"] == 0.07 and self.lose_reply_once: raise httpx.ReadTimeout("slow")
            if body["volume"] == 5.0: return httpx.Response(200, json={"retcode": 10019, "comment": "No money"})
            return httpx.Response(200, json={"retcode": 10009, "deal": 777, "order": 778, "comment": "Request executed"})
        if path == "/orders/send":
            a = body["action"]
            if a == 5 and body["type_filling"] in self.fill_reject: return httpx.Response(200, json={"retcode": 10030, "comment": "Unsupported filling mode"})
            return httpx.Response(200, json={"retcode": 10009, "order": 901, "comment": "done"})
        if path.endswith("/close") and path.startswith("/positions/"): return httpx.Response(200, json={"retcode": 10009, "comment": "closed"})
        return httpx.Response(404, json={"detail": "nope"})

def calls(fk, path): return [c for c in fk.log if c[1] == path]

async def wait_job(mgr, job, poll):
    for _ in range(50):
        st = mgr.job(job, poll)
        if st["state"] in ("ready", "failed"): return st
        await asyncio.sleep(0.02)
    raise SystemExit("job timeout")

async def main():
    fk = Fake()
    def mk(): return BridgeManager("http://bridge.test", "KEY", PW, http=httpx.AsyncClient(transport=httpx.MockTransport(fk.handler)))
    mgr = mk()
    async def on_ready(session, info): return "TOKEN"
    # ---- connect: access password and account number checks
    job, poll = await mgr.start_connect("123456", "wrong", "Demo-Server", "mt5", "", on_ready)
    st = await wait_job(mgr, job, poll); assert st["state"] == "failed" and st["code"] == "bad_credentials", st
    job, poll = await mgr.start_connect("999999", PW, "Demo-Server", "mt5", "", on_ready)
    st = await wait_job(mgr, job, poll); assert st["state"] == "failed" and "not the one" in st["message"], st
    job, poll = await mgr.start_connect("123456", PW, "Demo-Server", "mt5", "", on_ready)
    st = await wait_job(mgr, job, poll); assert st["state"] == "ready" and st["token"] == "TOKEN" and st["account"]["balance"] == 1000, st
    claims = {"login": "123456", "server": "Demo-Server", "platform": "mt5"}
    # ---- a restarted app needs no relink; a different account does
    mgr2 = mk(); s = await mgr2.session_for(claims); assert s.info["login"] == "123456"
    try: await mgr2.session_for({"login": "555555", "server": "Demo-Server"}); raise SystemExit("relink")
    except ApiError as e: assert e.code == "relink"
    fk.connected = False
    try: await mk().session_for(claims); raise SystemExit("not logged in")
    except ApiError as e: assert e.status == 503
    fk.connected = True
    sess = await mgr.session_for(claims)
    # ---- reads
    info = await sess.account_info(); assert info["balance"] == 1000 and info["marginLevel"] == 10100 and info["broker"] == "MetaQuotes Ltd."
    pos, ords = await sess.positions(), await sess.orders()
    assert len(pos) == 1 and pos[0]["side"] == "buy" and pos[0]["stopLoss"] == 1.09 and pos[0]["takeProfit"] is None and pos[0]["openPrice"] == 1.1
    assert len(ords) == 1 and ords[0]["type"] == "buy_limit" and ords[0]["price"] == 1.05
    n = len(calls(fk, "/positions")); await sess.positions(); assert len(calls(fk, "/positions")) == n          # TTL cache
    names = [x["symbol"] for x in await sess.symbols()]; assert names == ["EURUSD", "USDJPY", "XAUUSD"]
    jpy = [x for x in await sess.symbols() if x["symbol"] == "USDJPY"][0]; assert jpy["digits"] == 3
    q = await sess.quotes(["EURUSD", "NOPE"]); assert list(q) == ["EURUSD"] and q["EURUSD"]["ask"] == 1.1002
    n = len(calls(fk, "/symbols/NOPE/tick")); await sess.quotes(["EURUSD", "NOPE"]); assert len(calls(fk, "/symbols/NOPE/tick")) == n   # unknown symbol is remembered
    try: await sess.quotes(["NOPE"]); raise SystemExit("no prices")
    except ApiError as e: assert e.status == 502
    c = await sess.candles("EURUSD", "H1", 10, None); assert len(c) == 2 and c[0]["t"] < c[1]["t"] and c[1]["c"] == 1.5
    assert calls(fk, "/rates/EURUSD")[-1][2]["timeframe"] == "H1" and calls(fk, "/rates/EURUSD")[-1][2]["count"] == "10"
    await sess.candles("EURUSD", "MN", 10, 1781227000); assert calls(fk, "/rates/EURUSD")[-1][2]["timeframe"] == "MN1" and "time_to" in calls(fk, "/rates/EURUSD")[-1][2]
    h = await sess.history(30); assert h[0]["kind"] == "deal" and h[0]["entry"] == "out" and h[0]["positionId"] == "7" and h[1]["kind"] == "balance"
    # ---- trading: market
    r = await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.1, "stopLoss": 1.09, "clientOrderId": "abcdef123456"})
    sent = calls(fk, "/orders/market")[-1][3]
    assert r["ok"] and r["orderId"] == "778" and sent["comment"] == "kr:abcdef123456" and sent["sl"] == 1.09 and "tp" not in sent
    r2 = await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.1, "stopLoss": 1.09, "clientOrderId": "abcdef123456"})
    assert r2["duplicate"] and len(calls(fk, "/orders/market")) == 1
    for bad, msg in (({"volume": 0.015}, "multiple"), ({"volume": 60}, "Maximum"), ({"symbol": "NOPE", "volume": 0.1}, "no symbol")):
        try: await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", **bad}); raise SystemExit("validation " + msg)
        except ApiError as e: assert e.status == 400 and msg in e.message, (bad, e.message)
    try: await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 5.0}); raise SystemExit("refused")
    except ApiError as e: assert e.status == 400 and "refused" in e.message and "No money" in e.message, e.message
    # a lost reply is settled from live state, not retried
    fk.lose_reply_once = True
    r3 = await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "market", "volume": 0.07, "clientOrderId": "lost0000resp1"})
    assert r3["ok"] and r3["reconciled"], r3
    assert len([c for c in calls(fk, "/orders/market") if c[3]["volume"] == 0.07]) == 1
    # ---- trading: pending order negotiates the filling mode (RETURN refused -> FOK)
    r4 = await sess.place_order({"symbol": "EURUSD", "side": "sell", "type": "stop", "volume": 0.1, "price": 1.0, "stopLoss": 1.05})
    sends = [c[3] for c in calls(fk, "/orders/send") if c[3]["action"] == 5]
    assert r4["ok"] and r4["orderId"] == "901" and [x["type_filling"] for x in sends] == [2, 0] and sends[-1]["type"] == 5 and sends[-1]["price"] == 1.0
    try: await sess.place_order({"symbol": "EURUSD", "side": "buy", "type": "limit", "volume": 0.1, "price": 1.0, "stopLoss": 1.05}); raise SystemExit("sl side")
    except ApiError as e: assert "below the entry" in e.message
    # ---- modify / close / cancel
    await sess.modify_position("7", None, 1.2); m = [c[3] for c in calls(fk, "/orders/send") if c[3]["action"] == 6][-1]
    assert m["position"] == 7 and m["symbol"] == "EURUSD" and m["sl"] == 1.09 and m["tp"] == 1.2      # unchanged SL kept
    await sess.close_position("7", None); assert calls(fk, "/positions/7/close")
    await sess.close_position("7", 0.05); d = [c[3] for c in calls(fk, "/orders/send") if c[3]["action"] == 1][-1]
    assert d["type"] == 1 and d["volume"] == 0.05 and d["price"] == 1.1 and d["position"] == 7          # buy closes with a sell at the bid
    await sess.close_position("7", 0.2); assert len(calls(fk, "/positions/7/close")) == 2                # >= full volume = full close
    await sess.cancel_order("9"); assert [c[3] for c in calls(fk, "/orders/send") if c[3]["action"] == 8][-1]["order"] == 9
    await sess.modify_order("9", 1.04, None, None); mo = [c[3] for c in calls(fk, "/orders/send") if c[3]["action"] == 7][-1]
    assert mo["order"] == 9 and mo["price"] == 1.04 and mo["symbol"] == "EURUSD"
    try: await sess.modify_position("999", 1, 1); raise SystemExit("404")
    except ApiError as e: assert e.status == 404
    # ---- read-only bridge
    fk.read_only = True
    try: await sess.cancel_order("9"); raise SystemExit("read only")
    except ApiError as e: assert e.status == 403 and e.code == "read_only"
    # ---- logout / idle
    await mgr.drop(claims); assert not mgr.sessions
    print("bridge tests ok")

asyncio.run(main())
