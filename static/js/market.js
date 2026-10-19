// Market data layer: public price feeds (delayed). Trading itself happens in the MT5 Web terminal.
import { api } from './api.js';
import { S, favorites, emit, inst } from './state.js';

let quoteTimer = null, quoteCtl = null;
let quoteBusy = false, lastOk = Date.now();

// Connection status: a single slow or failed poll must not flash "Offline". Only a stretch with no success at all does.
function markOk() { lastOk = Date.now(); if (!S.online) { S.online = true; emit('online'); } }
function markFail(e) {
  if (e?.name === 'AbortError') return;
  if (Date.now() - lastOk > 45000 && S.online) { S.online = false; emit('online'); }
}
const FALLBACK_INSTRUMENTS = [
  ['EURUSD', 'Euro / US Dollar', 'Forex', 5], ['GBPUSD', 'British Pound / US Dollar', 'Forex', 5], ['USDJPY', 'US Dollar / Japanese Yen', 'Forex', 3],
  ['USDCHF', 'US Dollar / Swiss Franc', 'Forex', 5], ['AUDUSD', 'Australian Dollar / US Dollar', 'Forex', 5], ['USDCAD', 'US Dollar / Canadian Dollar', 'Forex', 5],
  ['USDZAR', 'US Dollar / South African Rand', 'Forex', 4], ['XAUUSD', 'Gold futures (GC)', 'Metals', 2], ['USOIL', 'WTI crude oil futures', 'Energy', 2],
  ['US500', 'S&P 500', 'Indices', 2], ['NAS100', 'Nasdaq 100', 'Indices', 2], ['BTCUSD', 'Bitcoin', 'Crypto', 2], ['ETHUSD', 'Ethereum', 'Crypto', 2], ['AAPL', 'Apple', 'Stocks', 2],
].map(([symbol, name, cat, digits]) => ({ symbol, name, cat, digits }));

export async function loadInstruments() {
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
  emit('instruments');
}

export async function candles(symbol, tf, limit = 500, _before = null, signal) {
  return (await api.pubCandles(symbol, tf, limit, signal)).candles;
}

// symbols we need prices for right now
function watched() {
  const set = new Set();
  set.add(S.symbol);
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
    const res = (await api.pubQuotes(syms.slice(0, 40), quoteCtl.signal)).quotes;
    const at = Date.now();
    for (const [s, q] of Object.entries(res)) {
      const prev = S.quotes[s];
      S.quotes[s] = { ...prev, ...q, at, dir: prev ? Math.sign(q.bid - prev.bid) || prev.dir : 0 };
    }
    markOk(); emit('quotes');
  } catch (e) { markFail(e); }
  finally { quoteBusy = false; }
}

export function startPolling() {
  stopPolling();
  quoteBusy = false; lastOk = Date.now();
  pollQuotes();
  quoteTimer = setInterval(pollQuotes, 3000);
}
export function stopPolling() { clearInterval(quoteTimer); quoteCtl?.abort(); }
export const refreshNow = () => { pollQuotes(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow(); });

export const mid = s => { const q = S.quotes[s]; return q ? (q.bid + (q.ask || q.bid)) / 2 : null; };
export function dayChange(s) {
  const q = S.quotes[s]; if (!q || !q.prevClose) return null;
  const d = q.bid - q.prevClose; return { abs: d, pct: d / q.prevClose * 100 };
   }
