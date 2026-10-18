// Market data layer: one interface over broker (MetaApi) and public feeds.
import { api, report } from './api.js';
import { S, active, isBroker, favorites, emit, inst } from './state.js';

let quoteTimer = null, snapTimer = null, quoteCtl = null;
let quoteBusy = false, snapBusy = false, lastOk = Date.now();
const MAX_BROKER_QUOTES = 4;           // every broker price is a command the cloud terminal runs in turn: keep the list short

// Connection status: a single slow or failed poll must not flash "Offline". Only a stretch with no success at all does.
function markOk() { lastOk = Date.now(); if (!S.online) { S.online = true; report('status', 'back online'); emit('online'); } }
function markFail(e) {
  if (e?.name === 'AbortError' || e?.status === 401) return;
  if (Date.now() - lastOk > 45000 && S.online) { S.online = false; report('status', `OFFLINE after 45s without a successful poll; last error: ${e?.status ?? ''} ${e?.message ?? ''}`); emit('online'); }
}
const dayRefAt = {};
const FALLBACK_INSTRUMENTS = [
  ['EURUSD', 'Euro / US Dollar', 'Forex', 5], ['GBPUSD', 'British Pound / US Dollar', 'Forex', 5], ['USDJPY', 'US Dollar / Japanese Yen', 'Forex', 3],
  ['USDCHF', 'US Dollar / Swiss Franc', 'Forex', 5], ['AUDUSD', 'Australian Dollar / US Dollar', 'Forex', 5], ['USDCAD', 'US Dollar / Canadian Dollar', 'Forex', 5],
  ['USDZAR', 'US Dollar / South African Rand', 'Forex', 4], ['XAUUSD', 'Gold futures (GC)', 'Metals', 2], ['USOIL', 'WTI crude oil futures', 'Energy', 2],
  ['US500', 'S&P 500', 'Indices', 2], ['NAS100', 'Nasdaq 100', 'Indices', 2], ['BTCUSD', 'Bitcoin', 'Crypto', 2], ['ETHUSD', 'Ethereum', 'Crypto', 2], ['AAPL', 'Apple', 'Stocks', 2],
].map(([symbol, name, cat, digits]) => ({ symbol, name, cat, digits }));

export async function loadInstruments() {
  if (isBroker()) {
    const { symbols } = await api.symbols();
    S.instruments = symbols.map(s => ({ symbol: s.symbol, name: s.description || s.symbol, cat: s.category || 'Other', digits: s.digits ?? 5,
      minVolume: s.minVolume, maxVolume: s.maxVolume, volumeStep: s.volumeStep, contractSize: s.contractSize, tickSize: s.tickSize, path: s.path }));
  } else {
    try {
      const { instruments } = await api.pubInstruments();
      if (!Array.isArray(instruments) || !instruments.length) throw new Error('The server sent an empty symbol list.');
      S.instruments = instruments;
    } catch (e) {
      // Without a symbol list the watchlist and chart would wait forever. Fall back to a built-in list, then report the failure.
      S.instruments = FALLBACK_INSTRUMENTS.map(x => ({ ...x }));
      emit('instruments');
      throw e;
    }
  }
  emit('instruments');
}

export async function candles(symbol, tf, limit = 500, before = null, signal) {
  if (isBroker()) return (await api.candles(symbol, tf, Math.min(limit, 1000), before, signal)).candles;
  return (await api.pubCandles(symbol, tf, limit, signal)).candles;
}

// symbols we need prices for right now
function watched() {
  const set = new Set();
  set.add(S.symbol);
  S.positions.forEach(p => set.add(p.symbol)); S.orders.forEach(o => set.add(o.symbol));
  S.alerts.filter(a => !a.fired).forEach(a => set.add(a.symbol));
  favorites().forEach(f => set.add(f));
  if (S.catFilter && S.catFilter !== 'Favorites') S.instruments.filter(i => i.cat === S.catFilter).slice(0, 30).forEach(i => set.add(i.symbol));
  if (S.query) S.instruments.filter(i => (i.symbol + i.name).toLowerCase().includes(S.query.toLowerCase())).slice(0, 20).forEach(i => set.add(i.symbol));
  return [...set].filter(s => s && (!S.instruments.length || inst(s)));
}

async function pollQuotes() {
  if (document.hidden || quoteBusy) return;               // never start a new request while one is still running
  const syms = watched(); if (!syms.length) return;
  quoteBusy = true; quoteCtl = new AbortController();
  try {
    const res = isBroker() ? (await api.quotes(syms.slice(0, MAX_BROKER_QUOTES), quoteCtl.signal)).quotes : (await api.pubQuotes(syms.slice(0, 40), quoteCtl.signal)).quotes;
    const at = Date.now();
    for (const [s, q] of Object.entries(res)) {
      const prev = S.quotes[s];
      S.quotes[s] = { ...prev, ...q, at, dir: prev ? Math.sign(q.bid - prev.bid) || prev.dir : 0 };
    }
    markOk(); emit('quotes');
    if (isBroker()) refreshDayRefs(syms);
  } catch (e) { markFail(e); }
  finally { quoteBusy = false; }
}

// broker quotes carry no previous close; derive it from the last two daily candles
async function refreshDayRefs(syms) {
  const now = Date.now();
  for (const s of syms.slice(0, 6)) {
    if (dayRefAt[s] && now - dayRefAt[s] < 600000) continue;
    dayRefAt[s] = now;
    try {
      const c = await candles(s, 'D1', 2);
      if (c.length >= 2 && S.quotes[s]) S.quotes[s].prevClose = c[c.length - 2].c;
      else if (c.length === 1 && S.quotes[s]) S.quotes[s].prevClose = c[0].o;
      emit('quotes');
    } catch { dayRefAt[s] = 0; }
  }
}

async function pollSnapshot() {
  if (document.hidden || !isBroker() || snapBusy) return;
  snapBusy = true;
  try {
    const snap = await api.snapshot();
    S.account = snap.account; S.positions = snap.positions; S.orders = snap.orders; S.lastSnapshot = Date.now();
    markOk(); emit('snapshot');
  } catch (e) { markFail(e); }
  finally { snapBusy = false; }
}

export function startPolling() {
  stopPolling();
  quoteBusy = false; snapBusy = false; lastOk = Date.now();
  pollQuotes(); pollSnapshot();
  quoteTimer = setInterval(pollQuotes, isBroker() ? 5000 : 3000);
  snapTimer = setInterval(pollSnapshot, isBroker() ? 5000 : 2000);
}
export function stopPolling() { clearInterval(quoteTimer); clearInterval(snapTimer); quoteCtl?.abort(); }
export const refreshNow = () => { pollQuotes(); pollSnapshot(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow(); });

export const mid = s => { const q = S.quotes[s]; return q ? (q.bid + (q.ask || q.bid)) / 2 : null; };
export function dayChange(s) {
  const q = S.quotes[s]; if (!q || !q.prevClose) return null;
  const d = q.bid - q.prevClose; return { abs: d, pct: d / q.prevClose * 100 };
}
export const accountLabel = () => active()?.label || 'Public prices';
