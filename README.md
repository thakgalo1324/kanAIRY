# Kanairy (VPS edition)

Your VPS runs MT5, the Kanairy EA and the Kanairy server. The phone app is the remote: log in, import your strategy XML, press Start, watch trades.

    app/   Android app (black and white UI). Build it with GitHub Actions.
    vps/   Kanairy server for the VPS (Node.js, no dependencies). Start here: vps/README-VPS.md
    mt5/   KanairyEA.mq5 (the trading EA) and KanairyTest.mq5 (one demo BUY and SELL to prove orders work)

## Order
1. VPS: follow `vps/README-VPS.md` (about 10 minutes).
2. Phone: push this folder to GitHub (keep the `.github` folder). Open Actions, wait for the green tick, then Releases and install `Kanairy.apk`.
3. App: Setup, enter `http://YOUR_VPS_IP:8766` and the app key. Account, enter your broker login, Launch MT5. Strategy, import XML. Live, hold the crown.
4. Use a demo account first. Also sign in to the same account in the MT5 app to watch trades fly.

You can also import your own `.mq5` EA from the Strategy tab; the server compiles and runs it in MT5 (see `vps/README-VPS.md`).

Strategy rules are checked when each candle closes. Every order carries a stop loss on the broker's side. Guard rails (max open trades, orders per signal, cooldown, daily orders, daily loss, max spread) live on the server.
