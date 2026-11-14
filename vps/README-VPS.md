# Kanairy on your VPS (easy setup)

The VPS runs MT5, the Kanairy EA and this server. Your phone app only controls it.

    Phone app  --(signed requests, port 8766)-->  Kanairy server  <--(127.0.0.1:80)-->  KanairyEA in MT5

## Setup, three steps
1. Install **MetaTrader 5** on the VPS and open it once (so it creates its data folder). Keep the `vps` and `mt5` folders side by side.
2. Double-click **`start-kanairy.bat`** in the `vps` folder. It does the rest:
   - installs Node.js if missing (if it does, close the window and double-click again),
   - opens port 8766 in Windows Firewall (tap Yes),
   - finds MT5, copies `KanairyEA.mq5` in and compiles it,
   - prints your **Phone address** and **App key**.
3. In your VPS provider's website, open **TCP port 8766** in its firewall (security group). Windows cannot do this part for you.

Then on the phone: Kanairy, Setup, enter the address and key, tap Connect. Account, enter your broker login (demo first), tap Launch MT5.

## Keep it running (set once)
- Right-click `autostart-kanairy.bat`, choose Run as administrator. Kanairy server then starts every time you sign in to the VPS.
- The server now starts MT5 by itself with your saved login (set `"autoLaunch": false` in `config.json` to turn that off), checks every 15 seconds that MT5 is alive, and restarts it if the EA does not connect within 2 minutes.
- It also writes the WebRequest permission into MT5's own settings every launch, so you never tick it by hand.
- After a full reboot, reconnect with Remote Desktop once so the Windows desktop exists. For no-touch reboots, turn on auto-logon (Win+R, `netplwiz`).
- Allocate an Elastic IP in EC2 and attach it to the instance so the phone address never changes.
- The app's EA row now tells you why it is not connected (MT5 not running, wrong token, EA silent).

## If something does not work
- **First, double-click `fix-everything.bat`.** It checks every link (MT5, EA, token, WebRequest permission, Windows firewall, server, AWS port, clock), repairs what it can, and prints exactly what is left. Report is saved in `data\doctor-report.txt`.
- `MT5 not found`: install MetaTrader 5, open it once, run the bat again. Or set `mt5Path` and `mt5DataDir` in `config.json` by hand.
- EA did not compile: open MT5, press F4, open KanairyEA, press F7, and read the errors.
- Phone cannot connect: open `http://YOUR_VPS_IP:8766/api/status` in the phone browser. `{"error":"unauthorized"}` means the server is reachable. If the page never loads, port 8766 is closed in the provider firewall.

## Linux
`node server.js` works the same. MT5 needs Wine there. Set `mt5Path` to the Wine path of `terminal64.exe`.

## Security
- Every app request is signed with your App key and expires in 60 seconds, so nobody can place or replay trades without the key. The key never travels over the network.
- Traffic itself is plain HTTP. Balances and trades are visible to someone on your network path. For privacy put the server behind HTTPS (Caddy or Cloudflare Tunnel) or a VPN such as Tailscale, and use that address in the app.
- The EA bridge (port 80) listens on the VPS itself only. Do not open it in the AWS security group. MetaTrader's WebRequest can only reach the standard web ports, which is why it is 80. If another program uses port 80 (IIS, for example), stop that program.
- Your broker password is stored encrypted in `data\secrets.json` and written to MT5's start file only while MT5 starts (removed after 90 seconds).
- The EA refuses real accounts unless `allowLive` is `true` in `config.json`. Use a demo account first.

## Import your own EA (.mq5)
In the app, Strategy tab, **Import an EA**. Pick a `.mq5` source (this server compiles it with MetaEditor) or a compiled `.ex5` (copied into MT5 as it is) and it runs inside MT5.
- An `.ex5` cannot be inspected by Kanairy, so only use ones you trust and are licensed for. EAs that need a DLL are refused (Kanairy keeps DLLs off). EAs that `#include` your own files will fail to compile; the error shows in the app.
- Optional: add the EA's `.set` settings file, choose the chart timeframe, then tap **Run it on my VPS**. The symbol is the one set in Account.
- An imported EA trades **by itself**. Kanairy's guard rails, the live-account lock (`allowLive`) and the Live crown do not apply to it. Use a demo account first.
- The Live screen's stop button shuts MT5 down so the EA cannot trade. Open trades stay open with their broker stops.
- **Back to my XML strategy** switches back to KanairyEA. Imported files live in MT5's `MQL5\Experts\Imported` folder; compile output is in `data\ea-compile.log`.
- Only import EAs you own or are licensed to use.

## Many people on one VPS (up to 10)
`start-kanairy.bat` now starts the **gateway**. One public port, **one app key for everyone**, and each person has their own name and PIN.
- **One app key, one EA key, forever.** They are created once and stored in `C:\ProgramData\Kanairy` (not in this folder), so replacing the `vps` folder never changes them. If you already had a key in `vps\config.json`, it is kept.
- **In the app:** Setup, enter the address and the app key once, then **Create account** (name + PIN). On another phone, use **Sign in** with the same name and PIN.
- **Each person is separate:** their own broker login, strategy, imported EAs, settings and their own private copy of MT5 (copied automatically the first time, a few minutes). Nobody sees anyone else's account.
- **Server size:** each MT5 uses roughly 300 to 600 MB of RAM and about 400 MB of disk. For 10 people plan for 8 GB RAM or more.
- **Limits:** 10 accounts by default (`maxUsers` in `ProgramData\Kanairy\gateway.json`). 8 wrong PINs lock that account for 5 minutes. Deleting an account in the app removes its files and private MT5.
- **Start and stop an imported EA from the phone:** with an imported `.mq5` or `.ex5`, hold the crown to start MT5 with it, tap to stop it. Stopping shuts down only that person's MT5.
- The old single-account `server.js` still works if you run it directly, but the gateway is the normal way now. Close any old "Kanairy server" window before starting the gateway, because both use port 8766.
- Everyone's EA talks to the server on its own private address (127.0.1.x, port 80), all with the same EA key.

## Ratchet (trailing) trades

Add `<trail step="0.2"/>` to a strategy. The take-profit is then a target, not an exit. When price passes it, the trade stays open and the stop moves up one step at a time (step = 0.2 x the stop distance, so one fifth). The stop only ever moves in your favour. Needs the updated KanairyEA (the server recompiles it when you press Launch MT5).

## WhatsApp channel (optional, unofficial)

Run `install-whatsapp.bat` once (needs internet), then restart Kanairy. In the app, Setup has a WhatsApp card: enter a spare number, get a pairing code, and enter it in WhatsApp under Linked devices. Paste the channel link and tap Follow. Posts are collected in the server's inbox. WhatsApp can log out or ban a linked number, so use a spare one.
