// Kanairy server. Runs on your VPS next to MT5.
//   EA  <--(127.0.0.1:eaPort, token)-->  this server  <--(appPort, signed requests)-->  Kanairy phone app
// No dependencies. Needs Node 18 or newer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { patchSection } from './mt5ini.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// KANAIRY_HOME lets the gateway run one copy of this server per person, each with its own settings and data.
const HOME = process.env.KANAIRY_HOME || DIR;
const DATA = path.join(HOME, 'data');
fs.mkdirSync(DATA, { recursive: true });
const CFG_FILE = path.join(HOME, 'config.json');
const STATE_FILE = path.join(DATA, 'state.json');
const SECRET_FILE = path.join(DATA, 'secrets.json');
const INI_FILE = path.join(DATA, 'kanairy-start.ini');

// ---------- config (created on first run) ----------
const rnd = n => crypto.randomBytes(n).toString('hex');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { /* first run */ }
const defaults = {
  appKey: rnd(16), eaToken: rnd(12), appPort: 8766, eaPort: 80,
  mt5Path: 'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
  mt5DataDir: '', // File > Open Data Folder in MT5, e.g. C:\\Users\\you\\AppData\\Roaming\\MetaQuotes\\Terminal\\ABC123
  allowLive: false,
  autoLaunch: true, // start MT5 by itself when the server starts, and again if it dies
  appHost: '0.0.0.0', eaHost: '127.0.0.1', // the gateway gives each person their own private addresses
  portable: false, // true = this server owns a private MT5 copy (one per person)
  quiet: false,
};
let fresh = false;
for (const [k, v] of Object.entries(defaults)) if (cfg[k] === undefined) { cfg[k] = v; fresh = true; }
// MetaTrader's WebRequest only talks to the standard web ports (80 for http), so the EA bridge lives on port 80.
if (!cfg.eaPort || Number(cfg.eaPort) === 8765) { cfg.eaPort = 80; fresh = true; }
if (fresh) fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
// Every private address (127.0.1.1 to 127.0.1.10) plus plain 127.0.0.1, so MT5 already allows them all, for every account.
const allowList = () => { const a = ['127.0.0.1']; for (let i = 1; i <= 10; i++) a.push('127.0.1.' + i); return a.flatMap(h => ['http://' + h, 'https://' + h]).join(';'); };
const eaUrl = () => 'http://' + (cfg.eaHost || '127.0.0.1') + (Number(cfg.eaPort) === 80 ? '' : ':' + cfg.eaPort);

// ---------- strategy engine (the same code as the app's Strategy lab) ----------
globalThis.window = globalThis;
await import('./engine/engine.js');
const evalStrategy = (candles, strat) => JSON.parse(globalThis.__eval(JSON.stringify(candles), JSON.stringify(strat)));

// ---------- persistent state ----------
const GUARD_KEYS = ['hub_lot', 'hub_max_open', 'hub_burst', 'hub_cooldown', 'hub_max_day', 'hub_daily_loss', 'hub_max_spread', 'hub_lot_per_1k', 'hub_lot_cap', 'hub_max_total_lots'];
const GUARD_DEFAULTS = { hub_lot: 0, hub_max_open: 3, hub_burst: 1, hub_cooldown: 0, hub_max_day: 200, hub_daily_loss: 0, hub_max_spread: 0, hub_lot_per_1k: 0, hub_lot_cap: 0.1, hub_max_total_lots: 0 };
// ea = an imported .mq5 expert advisor. mode 'kanairy' runs KanairyEA with your XML rules; mode 'custom' runs the imported EA by itself.
const EA_DEFAULT = { mode: 'kanairy', name: '', state: 'none', log: '', hasPreset: false };
let S = { guards: { ...GUARD_DEFAULTS }, strategy: null, rev: 0, feed: [], login: '', server: '', symbol: 'XAUUSD', tf: 'M1', hasPw: false, day: 0, dayTrades: 0, wins: 0, losses: 0, dayPnl: 0, ea: { ...EA_DEFAULT } };
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; S.guards = { ...GUARD_DEFAULTS, ...S.guards }; S.ea = { ...EA_DEFAULT, ...S.ea }; } catch { /* first run */ }
if (S.ea.state === 'compiling') { S.ea.state = 'failed'; S.ea.log = 'Compile was interrupted. Import the file again.'; } // server restarted mid-compile
const isCustom = () => S.ea.mode === 'custom' && S.ea.state === 'ok' && !!S.ea.name;
let saveT = null;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(STATE_FILE, JSON.stringify(S), () => {}), 400); };

// live (not persisted)
const L = { running: false, killPending: false, lastSync: 0, sym: '', tf: '', bid: 0, ask: 0, bal: 0, eq: 0, spread: 0, hedge: true, pos: [], signal: 'WAIT', err: '', lastBarT: 0, lastEntryMs: 0, launchedAt: 0, relaunches: 0, eaSeen: 0, badToken: 0, mt5Up: false, wasConn: false, owner: null };

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
function addFeed(k, text, side = '', lots = 0, price = 0, profit = 0) {
  S.feed.unshift({ t: Date.now(), k, text, side, lots, price, profit });
  S.feed = S.feed.slice(0, 80);
  save();
}
function rollDay() {
  const d = new Date(), key = d.getFullYear() * 1000 + Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  if (S.day !== key) { S.day = key; S.dayTrades = 0; S.wins = 0; S.losses = 0; S.dayPnl = 0; save(); }
}
const g = k => Number(S.guards[k] ?? GUARD_DEFAULTS[k]);

// ---------- secrets (broker password, encrypted with the app key) ----------
function putSecret(plain) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(cfg.appKey, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  fs.writeFileSync(SECRET_FILE, JSON.stringify({ salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') }), { mode: 0o600 });
}
function getSecret() {
  try {
    const j = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    const key = crypto.scryptSync(cfg.appKey, Buffer.from(j.salt, 'hex'), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'hex'));
    d.setAuthTag(Buffer.from(j.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(j.ct, 'hex')), d.final()]).toString('utf8');
  } catch { return ''; }
}

// ---------- the brain: EA sync ----------
let wrongSymLog = 0;
function sync(r) {
  rollDay();
  if (isCustom()) return { cmds: [], run: false, ignore: 'custom-ea' }; // an imported EA is in charge, KanairyEA must stay idle
  const now = Date.now(), sym = String(r.sym || ''), cid = String(r.cid || sym);
  // Only the symbol chosen in the app may trade, and only one chart at a time.
  if (S.symbol && sym && !sym.toUpperCase().startsWith(S.symbol.toUpperCase())) {
    if (now - wrongSymLog > 30000) { wrongSymLog = now; log(`Ignoring an EA on ${sym}. Kanairy trades ${S.symbol} only. Remove KanairyEA from the ${sym} chart.`); addFeed('sys', `Ignored EA on ${sym} (trading ${S.symbol} only)`); }
    return { cmds: [], run: false, ignore: 'symbol' };
  }
  if (L.owner && L.owner.cid !== cid && now - L.owner.at < 10000) return { cmds: [], run: false, dup: true };
  L.owner = { cid, at: now };
  L.lastSync = Date.now();
  L.sym = r.sym || L.sym; L.tf = r.tf || L.tf;
  L.bid = +r.bid || 0; L.ask = +r.ask || 0; L.bal = +r.bal || 0; L.eq = +r.eq || 0; L.spread = +r.spread || 0;
  L.hedge = r.hedge !== false;
  L.pos = Array.isArray(r.pos) ? r.pos : [];
  const out = { cmds: [], run: L.running };
  if (L.killPending) { out.cmds.push({ a: 'closeall' }); L.killPending = false; return out; }
  if (!L.running) return out;
  if (L.lastBarT === 0) out.want = true; // ask the EA for candles now
  const bars = r.bars, barT = +r.barT || 0;
  if (!Array.isArray(bars) || bars.length < 30) return out;
  if (barT && barT === L.lastBarT) return out;
  L.lastBarT = barT;
  if (!S.strategy) { L.err = 'No strategy loaded. Import XML in the app.'; return out; }
  const candles = bars.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
  let sig;
  try { sig = evalStrategy(candles, S.strategy); } catch (e) { L.err = 'Engine error: ' + e.message; return out; }
  if (sig.error) { L.err = sig.error; return out; }
  L.err = '';
  decide(sig, out.cmds);
  return out;
}

function decide(sig, cmds) {
  const rules = S.strategy.rules || {};
  const hasExit = (rules.exitLong || []).length + (rules.exitShort || []).length > 0;
  const enL = !!sig.enterLong, enS = !!sig.enterShort, exL = !!sig.exitLong, exS = !!sig.exitShort;
  L.signal = enL && !enS ? 'BUY' : enS && !enL ? 'SELL' : 'WAIT';
  let nb = L.pos.filter(p => p[1] === 0).length, ns = L.pos.filter(p => p[1] === 1).length;
  if ((exL || (!hasExit && enS)) && nb > 0) { L.pos.filter(p => p[1] === 0).forEach(p => cmds.push({ a: 'close', t: p[0] })); nb = 0; }
  if ((exS || (!hasExit && enL)) && ns > 0) { L.pos.filter(p => p[1] === 1).forEach(p => cmds.push({ a: 'close', t: p[0] })); ns = 0; }
  if (L.signal === 'WAIT') return;
  const buy = L.signal === 'BUY', now = Date.now(), open = nb + ns;
  if (!L.hedge && ((buy && ns > 0) || (!buy && nb > 0))) return;
  if (g('hub_daily_loss') > 0 && S.dayPnl <= -g('hub_daily_loss')) { L.err = 'Daily loss limit reached'; return; }
  if (g('hub_max_spread') > 0 && L.spread > g('hub_max_spread')) { L.err = 'Spread too wide (' + L.spread + ')'; return; }
  if (now - L.lastEntryMs < g('hub_cooldown') * 1000) return;
  let burst = Math.max(1, Math.min(10, Math.floor(g('hub_burst')))); if (!L.hedge) burst = 1;
  const allow = Math.min(burst, g('hub_max_open') - open, g('hub_max_day') - S.dayTrades);
  if (allow <= 0) return;
  const atr = sig.atr;
  if (!(atr > 0)) { L.err = 'ATR not ready'; return; }
  const slAtr = sig.slAtr || 1.5, tpAtr = sig.tpAtr || 0;
  let lots = g('hub_lot') > 0 ? g('hub_lot') : (sig.lots || 0.01);
  // Optional compounding: lots grow with equity (lots per 1,000 of account currency), never above the cap.
  if (g('hub_lot_per_1k') > 0 && L.eq > 0) {
    const step = 0.01, cap = g('hub_lot_cap') > 0 ? g('hub_lot_cap') : 0.1;
    lots = Math.min(cap, Math.max(step, Math.floor((L.eq / 1000) * g('hub_lot_per_1k') / step) * step));
    lots = +lots.toFixed(2);
  }
  // Hard ceiling on all open volume together.
  let n = allow;
  if (g('hub_max_total_lots') > 0) {
    const openLots = L.pos.reduce((a, p) => a + (+p[2] || 0), 0);
    n = Math.min(n, Math.floor((g('hub_max_total_lots') - openLots + 1e-9) / lots));
    if (n <= 0) { L.err = 'Total lot ceiling reached'; return; }
  }
  // Ratchet mode: the target no longer closes the trade. The EA lets it run, then raises the stop one step at a time (step = trail x stop distance).
  const ratchet = sig.trail > 0 && tpAtr > 0;
  for (let i = 0; i < n; i++) cmds.push(ratchet
    ? { a: buy ? 'buy' : 'sell', lots, sl: atr * slAtr, tp: 0, tg: +(atr * tpAtr).toFixed(5), tr: +(atr * slAtr * sig.trail).toFixed(5) }
    : { a: buy ? 'buy' : 'sell', lots, sl: atr * slAtr, tp: tpAtr > 0 ? atr * tpAtr : 0 });
  S.dayTrades += n; L.lastEntryMs = now;
  addFeed('signal', L.signal + ' signal x' + n + ' @ ' + lots + ' lots', buy ? 'buy' : 'sell', lots);
}

function eaEvent(e) {
  rollDay();
  const side = String(e.side || '');
  if (e.k === 'close') { S.dayPnl += +e.profit || 0; if ((+e.profit || 0) >= 0) S.wins++; else S.losses++; addFeed('close', side.toUpperCase() + ' closed', side, +e.lots, +e.price, +e.profit); }
  else if (e.k === 'open') addFeed('open', side.toUpperCase() + ' opened', side, +e.lots, +e.price);
  else addFeed('sys', String(e.text || 'EA message'));
  save();
}

// ---------- app API ----------
function setRunning(on) {
  L.running = !!on; if (on) { L.err = ''; L.lastBarT = 0; }
  addFeed('sys', on ? 'Bot started' : 'Bot stopped');
}
function status() {
  rollDay();
  const now = Date.now();
  return {
    run: L.running, conn: L.lastSync > 0 && now - L.lastSync < 6000, age: L.lastSync ? Math.round((now - L.lastSync) / 1000) : -1,
    sym: L.sym, tf: L.tf, bid: L.bid, ask: L.ask, bal: L.bal, eq: L.eq, spread: L.spread, hedge: L.hedge, pos: L.pos,
    dayPnl: +S.dayPnl.toFixed(2), dayTrades: S.dayTrades, wins: S.wins, losses: S.losses, signal: L.signal, err: L.err,
    strategy: S.strategy ? S.strategy.name : '', rev: S.rev,
    info: { login: S.login, server: S.server, hasPw: S.hasPw, symbol: S.symbol, tf: S.tf, allowLive: !!cfg.allowLive, mt5Ready: !!cfg.mt5Path && !!cfg.mt5DataDir, portable: !!cfg.portable },
    cfg: S.guards,
    mt5Up: L.mt5Up, hint: hint(now),
    ea: { mode: isCustom() ? 'custom' : 'kanairy', name: S.ea.name, state: S.ea.state, log: S.ea.log, hasPreset: !!S.ea.hasPreset, running: isCustom() && L.mt5Up && !L.stopped },
  };
}

// Plain-language reason why the EA is not connected, shown in the app.
function hint(now = Date.now()) {
  if (isCustom()) {
    if (!S.login || !S.server || !S.hasPw) return 'Add your broker login in Account, then tap Launch MT5.';
    if (process.platform === 'win32' && !L.mt5Up) return L.launchedAt && now - L.launchedAt < 60000 ? 'MT5 is starting. Give it a minute.' : 'MT5 is not running on the server. Tap Launch MT5.';
    return `Running your imported EA "${S.ea.name}" inside MT5. It trades on its own, so watch it in the MT5 app.`;
  }
  if (L.lastSync > 0 && now - L.lastSync < 6000) return '';
  if (!cfg.mt5Path || !cfg.mt5DataDir) return 'MT5 was not found on the server. Open MT5 once on the VPS, then restart Kanairy server.';
  if (!S.login || !S.server || !S.hasPw) return 'Add your broker login in Account, then tap Launch MT5.';
  if (process.platform === 'win32' && !L.mt5Up) return L.launchedAt && now - L.launchedAt < 60000 ? 'MT5 is starting. Give it a minute.' : 'MT5 is not running on the server. Tap Launch MT5.';
  if (L.badToken && now - L.badToken < 20000) return 'The EA is calling with the wrong token. Tap Launch MT5 so it is set again.';
  if (L.lastSync > 0) return 'The EA stopped answering. Check MT5 is logged in and Algo Trading is on.';
  if (L.eaSeen && now - L.eaSeen < 20000) return 'The EA is reaching the server but not syncing. Tap Launch MT5.';
  return 'MT5 is open but the EA has not called in. On the VPS, check the chart for a smiley face and Algo Trading on.';
}

// Also write the WebRequest allow-list straight into MT5's own settings, so it does not depend on the startup file alone.
function patchCommon() {
  if (!cfg.mt5DataDir) return;
  try {
    const f = path.join(cfg.mt5DataDir, 'config', 'common.ini');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const cur = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0);
    fs.writeFileSync(f, patchSection(cur, 'Experts', { Enabled: 1, AllowLiveTrading: 1, WebRequest: 1, WebRequestUrl: allowList() }));
  } catch (e) { log('Could not update MT5 settings:', e.message); }
}

function writeStartFiles() {
  const pw = getSecret();
  const ini = ['[Common]', `Login=${S.login}`, `Password=${pw}`, `Server=${S.server}`, 'NewsEnable=0',
    '[Experts]', 'Enabled=1', 'AllowLiveTrading=1', 'AllowDllImport=0', 'Account=0', 'Profile=0', 'WebRequest=1', `WebRequestUrl=${allowList()}`,
    '[StartUp]', isCustom() ? `Expert=Imported\\${S.ea.name}` : 'Expert=KanairyEA',
    ...(isCustom() ? (S.ea.hasPreset ? [`ExpertParameters=${S.ea.name}.set`] : []) : ['ExpertParameters=kanairy.set']),
    `Symbol=${S.symbol}`, `Period=${S.tf}`, ''].join('\r\n');
  fs.writeFileSync(INI_FILE, ini, { mode: 0o600 });
  if (cfg.mt5DataDir) {
    const dir = path.join(cfg.mt5DataDir, 'MQL5', 'Presets');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kanairy.set'), `InpToken=${cfg.eaToken}\r\nInpHost=${cfg.eaHost || '127.0.0.1'}\r\nInpPort=${cfg.eaPort}\r\nInpAllowLive=${cfg.allowLive ? 'true' : 'false'}\r\n`);
  }
  patchCommon();
  setTimeout(() => fs.unlink(INI_FILE, () => {}), 90000); // MT5 reads it at startup; remove the password afterwards
}

// Stop / detect this person's MT5 only. A private (portable) copy is matched by its path, so one person's stop never touches another's.
const psq = x => String(x).replace(/'/g, "''");
const psMatch = () => `Get-CimInstance Win32_Process -Filter "Name='terminal64.exe'" | Where-Object { $_.ExecutablePath -ieq '${psq(cfg.mt5Path)}' }`;
function killMt5(cb) {
  if (process.platform !== 'win32') { if (cb) cb(); return; }
  if (cfg.portable) execFile('powershell', ['-NoProfile', '-Command', `${psMatch()} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], () => { if (cb) cb(); });
  else execFile('taskkill', ['/IM', 'terminal64.exe', '/F'], () => { if (cb) cb(); });
}

async function launchMt5() {
  await autoSetup();
  if (!S.login || !S.server || !S.hasPw) return { ok: false, error: 'Save your broker login first.' };
  if (!cfg.mt5Path || !fs.existsSync(cfg.mt5Path)) return { ok: false, error: 'MT5 not found. Set mt5Path in config.json on the VPS.' };
  if (isCustom() && !fs.existsSync(path.join(cfg.mt5DataDir || '', 'MQL5', 'Experts', 'Imported', S.ea.name + '.ex5'))) return { ok: false, error: 'The imported EA is not compiled on the server. Import it again.' };
  L.stopped = false;
  writeStartFiles();
  // MT5 reopens its saved charts, EA included, and that keeps the old EA on the chart. Drop saved charts that hold the other EA so the startup file attaches the right one.
  const cleanCharts = () => {
    try {
      const dir = path.join(cfg.mt5DataDir || '', 'Profiles', 'Charts', 'Default');
      const drop = isCustom() ? /KanairyEA/i : /KanairyEA|Imported\\/i; // always re-attach Kanairy fresh, so it uses this person's own address and key, not inputs saved on an old chart
      for (const f of fs.readdirSync(dir)) if (/\.chr$/i.test(f) && drop.test(readText(path.join(dir, f)))) { fs.unlinkSync(path.join(dir, f)); log('Cleared saved chart', f); }
    } catch { /* no saved charts */ }
  };
  const start = () => {
    cleanCharts();
    const args = [...(cfg.portable ? ['/portable'] : []), '/config:' + INI_FILE];
    const child = process.platform === 'win32' ? spawn(cfg.mt5Path, args, { detached: true, stdio: 'ignore' }) : spawn('wine', [cfg.mt5Path, ...args], { detached: true, stdio: 'ignore' });
    child.on('error', e => log('MT5 launch failed:', e.message));
    child.unref();
    log('MT5 started');
    L.launchedAt = Date.now();
  };
  L.launchedAt = Date.now();
  if (process.platform === 'win32') killMt5(() => setTimeout(start, 2500));
  else start();
  addFeed('sys', 'MT5 restarting with your login');
  return { ok: true };
}

// ---------- one-click setup: find MT5, install and compile the EA, show the phone address ----------
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
function findMt5() {
  if (cfg.portable) return cfg.mt5Path && fs.existsSync(cfg.mt5Path) ? cfg.mt5Path : '';
  if (cfg.mt5Path && fs.existsSync(cfg.mt5Path)) return cfg.mt5Path;
  const roots = new Set([process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean));
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch { continue; }
    for (const d of dirs) {
      if (!/meta\s*trader|mt5/i.test(d)) continue;
      const exe = path.join(r, d, 'terminal64.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return '';
}
function findDataDir(exe) {
  const base = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Terminal');
  const want = path.dirname(exe).toLowerCase();
  let fallback = '';
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return ''; }
  for (const d of dirs) {
    const dir = path.join(base, d);
    if (!fs.existsSync(path.join(dir, 'MQL5'))) continue;
    try {
      const o = fs.readFileSync(path.join(dir, 'origin.txt'));
      const txt = (o[0] === 0xFF ? o.toString('utf16le') : o.toString('utf8')).replace(/^\uFEFF/, '').trim().toLowerCase();
      if (txt === want) return dir;
    } catch { /* no origin file */ }
    fallback = fallback || dir;
  }
  return fallback;
}
let compiling = null;
function autoSetup() {
  if (compiling) return compiling;
  return new Promise(done => {
    try {
      const exe = findMt5();
      if (!exe) { log('MT5 not found. Install MetaTrader 5, open it once, then restart this server.'); return done(); }
      let changed = false;
      if (cfg.mt5Path !== exe) { cfg.mt5Path = exe; changed = true; }
      if (!cfg.mt5DataDir || !fs.existsSync(cfg.mt5DataDir)) { cfg.mt5DataDir = cfg.portable ? path.dirname(exe) : findDataDir(exe); changed = !!cfg.mt5DataDir || changed; }
      if (changed) saveCfg();
      if (!cfg.mt5DataDir) { log('MT5 data folder not found. Open MT5 once, close it, then restart this server.'); return done(); }
      log('MT5 found:', exe);
      const src = path.join(DIR, '..', 'mt5', 'KanairyEA.mq5');
      if (!fs.existsSync(src)) { log('KanairyEA.mq5 not found next to the vps folder. Keep the mt5 folder beside vps.'); return done(); }
      const dstDir = path.join(cfg.mt5DataDir, 'MQL5', 'Experts');
      fs.mkdirSync(dstDir, { recursive: true });
      const dst = path.join(dstDir, 'KanairyEA.mq5'), ex5 = path.join(dstDir, 'KanairyEA.ex5');
      const need = !fs.existsSync(dst) || fs.readFileSync(src, 'utf8') !== fs.readFileSync(dst, 'utf8');
      if (need) fs.copyFileSync(src, dst);
      const stale = !fs.existsSync(ex5) || fs.statSync(ex5).mtimeMs < fs.statSync(dst).mtimeMs;
      if (!need && !stale) { log('EA already installed.'); return done(); }
      const me = path.join(path.dirname(exe), 'MetaEditor64.exe');
      if (!fs.existsSync(me)) { log('MetaEditor not found. Open MT5, press F4, open KanairyEA and press F7 to compile it.'); return done(); }
      const t0 = Date.now() - 2000;
      compiling = new Promise(r => execFile(me, ['/compile:' + dst, '/log:' + path.join(DATA, 'compile.log')], () => {
        const okNow = fs.existsSync(ex5) && fs.statSync(ex5).mtimeMs >= t0;
        log(okNow ? 'EA installed and compiled.' : 'EA compile failed. See data\\compile.log');
        compiling = null; r(); done();
      }));
    } catch (e) { log('Auto setup problem:', e.message); done(); }
  });
}
// ---------- import your own .mq5 EA: the phone sends the source, this server compiles it and runs it inside MT5 ----------
const TFS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20', 'M30', 'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D1', 'W1', 'MN1'];
const cleanName = n => String(n || '').replace(/\.(mq5|ex5)$/i, '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'ImportedEA';
const readText = f => { try { const b = fs.readFileSync(f); const u16 = (b[0] === 0xFF && b[1] === 0xFE) || (b.length > 3 && b[0] !== 0 && b[1] === 0 && b[3] === 0); return (u16 ? b.toString('utf16le') : b.toString('utf8')).replace(/^﻿/, ''); } catch { return ''; } };
const eaFail = msg => { S.ea.state = 'failed'; S.ea.log = String(msg).slice(0, 700); save(); addFeed('sys', 'EA import failed'); };

async function importEa(name, source) {
  if (S.ea.state === 'compiling') return { ok: false, error: 'Still compiling the last file. Wait a moment.' };
  if (typeof source !== 'string' || source.length < 100) return { ok: false, error: 'That file is empty or too small to be an EA.' };
  if (source.length > 1.5e6) return { ok: false, error: 'That file is too large (limit 1.5 MB).' };
  if (source.includes('\u0000') || source.includes('�')) return { ok: false, error: 'That file is not plain MQL5 text. Import the .mq5 source, not a compiled .ex5.' };
  if (!/\bOn(Init|Tick|Timer|Trade|ChartEvent)\s*\(/.test(source)) return { ok: false, error: 'This does not look like an expert advisor (no OnTick or OnInit found).' };
  if (/#import\s+"[^"]*\.dll"/i.test(source)) return { ok: false, error: 'This EA imports a DLL. Kanairy keeps DLLs off on your server for safety, so it cannot run here.' };
  await autoSetup();
  if (!cfg.mt5DataDir) return { ok: false, error: 'MT5 was not found on the server. Open MT5 once on the VPS first.' };
  const me = path.join(path.dirname(cfg.mt5Path || ''), 'MetaEditor64.exe');
  if (!fs.existsSync(me)) return { ok: false, error: 'MetaEditor was not found next to MT5, so the server cannot compile.' };
  const nm = cleanName(name), dir = path.join(cfg.mt5DataDir, 'MQL5', 'Experts', 'Imported');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, nm + '.mq5'), ex5 = path.join(dir, nm + '.ex5'), logf = path.join(DATA, 'ea-compile.log');
  fs.writeFileSync(dst, '﻿' + source, 'utf8');
  try { fs.unlinkSync(ex5); } catch { /* none yet */ }
  try { fs.unlinkSync(logf); } catch { /* none yet */ }
  if (S.ea.name !== nm) S.ea.hasPreset = false;
  S.ea.name = nm; S.ea.state = 'compiling'; S.ea.log = ''; save();
  addFeed('sys', `Compiling imported EA ${nm}`);
  execFile(me, ['/compile:' + dst, '/log:' + logf], { timeout: 120000 }, () => {
    const out = readText(logf), m = /Result:\s*(\d+)\s*errors?,\s*(\d+)\s*warnings?/i.exec(out);
    const errors = m ? +m[1] : (fs.existsSync(ex5) ? 0 : 1);
    if (fs.existsSync(ex5) && errors === 0) {
      S.ea.state = 'ok'; S.ea.log = m ? `Compiled with ${m[2]} warnings.` : 'Compiled.'; save(); addFeed('sys', `EA ${nm} compiled`); log('Imported EA compiled:', nm);
    } else {
      const lines = out.split(/\r?\n/).filter(l => /error/i.test(l) && !/Result:/i.test(l)).map(l => l.replace(/^[A-Za-z]:\\[^ ]*?\.mq5/i, '').trim()).slice(0, 6);
      eaFail(lines.length ? lines.join('\n') : 'Compile failed. See data\\ea-compile.log on the server.');
    }
  });
  return { ok: true, name: nm, state: 'compiling' };
}

// A compiled .ex5 is not compiled again, only copied into MT5. Kanairy cannot see inside it, so DLLs stay off and it runs only as MT5 allows.
async function importEx5(name, b64) {
  if (S.ea.state === 'compiling') return { ok: false, error: 'Still compiling the last file. Wait a moment.' };
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 1024) return { ok: false, error: 'That file is empty or too small to be an EA.' };
  if (buf.length > 2e6) return { ok: false, error: 'That file is too large (limit 2 MB).' };
  const head = buf.subarray(0, 4).toString('latin1');
  if (head.startsWith('MZ') || head.startsWith('PK') || head.startsWith('<') || head.startsWith('\u007fELF')) return { ok: false, error: 'That is not an .ex5 file (it looks like a program, zip or web page). Unzip it and pick the .ex5 inside.' };
  await autoSetup();
  if (!cfg.mt5DataDir) return { ok: false, error: 'MT5 was not found on the server. Open MT5 once on the VPS first.' };
  const nm = cleanName(name), dir = path.join(cfg.mt5DataDir, 'MQL5', 'Experts', 'Imported');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nm + '.ex5'), buf);
  try { fs.unlinkSync(path.join(dir, nm + '.mq5')); } catch { /* none */ }
  if (S.ea.name !== nm) S.ea.hasPreset = false;
  S.ea.name = nm; S.ea.state = 'ok'; S.ea.log = 'Compiled file copied to MT5. Kanairy cannot check what is inside it, and DLLs stay off.'; save();
  addFeed('sys', `EA ${nm} (.ex5) added`);
  return { ok: true, name: nm, state: 'ok' };
}

function importPreset(text) {
  if (!S.ea.name) return { ok: false, error: 'Import the .mq5 file first.' };
  if (typeof text !== 'string' || text.length > 2e5 || !/^[^=\n]+=/m.test(text)) return { ok: false, error: 'That does not look like an MT5 .set settings file.' };
  if (!cfg.mt5DataDir) return { ok: false, error: 'MT5 data folder not found on the server.' };
  const dir = path.join(cfg.mt5DataDir, 'MQL5', 'Presets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, S.ea.name + '.set'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text.replace(/^﻿/, '').replace(/\r?\n/g, '\r\n'), 'utf16le')]));
  S.ea.hasPreset = true; save(); addFeed('sys', 'EA settings file saved');
  return { ok: true };
}

function setEaMode(mode, tf) {
  if (tf !== undefined && tf !== '') { if (!TFS.includes(String(tf))) return { ok: false, error: 'Unknown timeframe.' }; S.tf = String(tf); }
  if (mode === 'custom') {
    if (S.ea.state !== 'ok' || !S.ea.name) return { ok: false, error: 'Import and compile an .mq5 file first.' };
    S.ea.mode = 'custom'; L.running = false; L.lastSync = 0;
  } else { S.ea.mode = 'kanairy'; if (S.strategy && S.strategy.timeframe && (tf === undefined || tf === '')) S.tf = S.strategy.timeframe; }
  L.lastBarT = 0; save();
  addFeed('sys', S.ea.mode === 'custom' ? `Mode: imported EA ${S.ea.name} (trades by itself)` : 'Mode: Kanairy strategy');
  return { ok: true, mode: S.ea.mode, tf: S.tf };
}

async function showAddress() {
  let ip = '';
  try { ip = (await (await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000) })).text()).trim(); } catch { /* offline */ }
  console.log('\n  Kanairy server is running.');
  console.log(`  Phone address:  http://${ip || '<your VPS public IP>'}:${cfg.appPort}`);
  console.log(`  App key:        ${cfg.appKey}`);
  console.log(`\n  Also open TCP port ${cfg.appPort} in your VPS provider's firewall (security group).\n`);
}

const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
function readBody(req, max = 3e6) {
  return new Promise((ok, no) => { let n = 0; const ch = []; req.on('data', c => { n += c.length; if (n > max) { no(new Error('too large')); req.destroy(); } else ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', no); });
}

const seen = new Map();
function appAuth(req, body) {
  const ts = Number(req.headers['x-ts']), nonce = String(req.headers['x-nonce'] || ''), sig = String(req.headers['x-sig'] || '');
  if (!ts || !nonce || !sig || Math.abs(Date.now() - ts) > 60000) return false;
  const exp = crypto.createHmac('sha256', cfg.appKey).update(`${ts}\n${nonce}\n${req.method}\n${req.url}\n${body}`).digest('hex');
  const a = Buffer.from(exp), b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (seen.has(sig)) return false; // replay
  seen.set(sig, ts);
  for (const [k, v] of seen) if (Date.now() - v > 130000) seen.delete(k);
  return true;
}

const appServer = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    if (!appAuth(req, body)) return send(res, 401, { error: 'unauthorized' });
    const j = body ? JSON.parse(body) : {};
    const u = req.url;
    if (u === '/api/status') return send(res, 200, status());
    if (u === '/api/feed') return send(res, 200, S.feed);
    if (u === '/api/strategy' && req.method === 'GET') return send(res, 200, { strategy: S.strategy, rev: S.rev });
    if (u === '/api/strategy') { S.strategy = j.strategy || null; S.rev++; if (S.strategy && S.strategy.timeframe) S.tf = S.strategy.timeframe; L.lastBarT = 0; save(); addFeed('sys', S.strategy ? 'Strategy loaded: ' + S.strategy.name : 'Strategy cleared'); return send(res, 200, { ok: true, rev: S.rev }); }
    if (u === '/api/cfg') { if (!GUARD_KEYS.includes(j.key) || !(Number(j.value) >= 0)) return send(res, 400, { error: 'bad value' }); S.guards[j.key] = Number(j.value); save(); return send(res, 200, { ok: true }); }
    if (u === '/api/run') { setRunning(j.on); return send(res, 200, { ok: true }); }
    if (u === '/api/kill') {
      L.running = false;
      if (isCustom()) { L.stopped = true; L.mt5Up = false; killMt5(); addFeed('sys', 'Stopped MT5 so the imported EA cannot trade. Open trades stay open with their broker stops.'); }
      else { L.killPending = true; addFeed('sys', 'Kill switch: closing all trades'); }
      return send(res, 200, { ok: true });
    }
    if (u === '/api/ea/import') return send(res, 200, j.ex5 ? await importEx5(j.name, j.ex5) : await importEa(j.name, j.source));
    if (u === '/api/ea/preset') return send(res, 200, importPreset(j.text));
    if (u === '/api/ea/mode') return send(res, 200, setEaMode(j.mode, j.tf));
    if (u === '/api/login') {
      S.login = String(j.login || '').trim(); S.server = String(j.server || '').trim();
      S.symbol = String(j.symbol || S.symbol || 'XAUUSD').toUpperCase().replace(/[^A-Z0-9._]/g, '');
      if (j.tf) S.tf = String(j.tf);
      if (j.password) { putSecret(String(j.password)); S.hasPw = true; }
      if (j.clear) { S.login = ''; S.server = ''; S.hasPw = false; try { fs.unlinkSync(SECRET_FILE); } catch { /* none */ } }
      save(); return send(res, 200, { ok: true });
    }
    if (u === '/api/launch') return send(res, 200, await launchMt5());
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
});

// ---------- EA listener (this machine only) ----------
const eaServer = http.createServer(async (req, res) => {
  try {
    const tok = String(req.headers['x-token'] || '');
    const a = Buffer.from(tok), b = Buffer.from(cfg.eaToken);
    const body = await readBody(req);
    L.eaSeen = Date.now();
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { if (!L.badToken || Date.now() - L.badToken > 30000) log('EA called with a wrong token. Tap Launch MT5 in the app.'); L.badToken = Date.now(); return send(res, 401, { error: 'bad token' }); }
    if (req.url.startsWith('/ping')) return send(res, 200, { ok: true });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const j = JSON.parse(body || '{}');
    if (req.url.startsWith('/sync')) return send(res, 200, sync(j));
    if (req.url.startsWith('/event')) { eaEvent(j); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'unknown' });
  } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
});

appServer.listen(cfg.appPort, cfg.appHost || '0.0.0.0', () => log(`App API on port ${cfg.appPort}`));
eaServer.on('error', e => log(e.code === 'EADDRINUSE' ? `EA bridge: port ${cfg.eaPort} is used by another program (for example IIS or a web server). Stop it, then restart Kanairy server.` : 'EA bridge error: ' + e.message));
eaServer.listen(cfg.eaPort, cfg.eaHost || '127.0.0.1', () => log(`EA bridge on ${cfg.eaHost || '127.0.0.1'}:${cfg.eaPort}`));
// The first account also answers on plain 127.0.0.1, so an EA compiled before the per-person addresses existed still connects.
if (cfg.eaHost === '127.0.1.1') {
  const alt = http.createServer((q, r) => eaServer.emit('request', q, r));
  alt.on('error', () => { /* port taken: the private address still works */ });
  alt.listen(cfg.eaPort, '127.0.0.1', () => log('EA bridge also on 127.0.0.1:' + cfg.eaPort));
}
autoSetup();
if (!cfg.quiet) showAddress();

// ---------- keep MT5 and the EA alive ----------
function checkMt5() {
  if (process.platform !== 'win32') { L.mt5Up = !L.stopped; return; }
  if (cfg.portable) { execFile('powershell', ['-NoProfile', '-Command', `(${psMatch()} | Measure-Object).Count`], (err, out) => { L.mt5Up = !err && Number(String(out).trim()) > 0; }); return; }
  execFile('tasklist', ['/FI', 'IMAGENAME eq terminal64.exe', '/NH'], (err, out) => { L.mt5Up = !err && /terminal64\.exe/i.test(String(out)); });
}
let firstWatch = true;
function watchdog() {
  const now = Date.now(), conn = L.lastSync > 0 && now - L.lastSync < 6000;
  if (isCustom()) { // imported EA: only keep MT5 itself alive, there is no Kanairy EA connection to wait for
    checkMt5();
    if (process.platform !== 'win32' || cfg.autoLaunch === false || L.stopped) return;
    if (!L.mt5Up && now - L.launchedAt > 45000 && S.login && S.server && S.hasPw && cfg.mt5Path) { log('MT5 is not running. Starting it with your imported EA.'); launchMt5(); }
    return;
  }
  if (conn !== L.wasConn) { L.wasConn = conn; log(conn ? 'EA connected.' : 'EA disconnected.'); addFeed('sys', conn ? 'EA connected' : 'EA disconnected'); }
  if (conn) { L.relaunches = 0; return; }
  checkMt5();
  if (process.platform !== 'win32' || cfg.autoLaunch === false) return;
  if (!S.login || !S.server || !S.hasPw || !cfg.mt5Path) return;
  const sinceLaunch = now - L.launchedAt;
  if (!L.mt5Up && (firstWatch || sinceLaunch > 45000)) { firstWatch = false; log('MT5 is not running. Starting it with your saved login.'); launchMt5(); return; }
  firstWatch = false;
  // MT5 is up but the EA never reported: restart it a couple of times, only if we started it ourselves.
  if (L.mt5Up && L.launchedAt && sinceLaunch > 120000 && L.relaunches < 2) { L.relaunches++; log('EA has not connected. Restarting MT5 (attempt ' + L.relaunches + ').'); launchMt5(); }
}
checkMt5();
setInterval(watchdog, 15000);
setTimeout(watchdog, 4000);
