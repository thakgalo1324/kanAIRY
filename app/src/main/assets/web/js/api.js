// Data layer. No server: everything is fetched straight from the public feeds through the phone.
import { httpGet } from './bridge.js';

export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

const fx = (symbol, name, digits = 5) => ({ symbol, name, cat: 'Forex', yahoo: symbol + '=X', digits });
const CATALOG = [
  fx('EURUSD', 'Euro / US Dollar'), fx('GBPUSD', 'British Pound / US Dollar'), fx('USDJPY', 'US Dollar / Japanese Yen', 3), fx('USDCHF', 'US Dollar / Swiss Franc'),
  fx('AUDUSD', 'Australian Dollar / US Dollar'), fx('USDCAD', 'US Dollar / Canadian Dollar'), fx('NZDUSD', 'New Zealand Dollar / US Dollar'), fx('EURGBP', 'Euro / British Pound'),
  fx('EURJPY', 'Euro / Japanese Yen', 3), fx('GBPJPY', 'British Pound / Japanese Yen', 3), fx('EURCHF', 'Euro / Swiss Franc'), fx('EURAUD', 'Euro / Australian Dollar'),
  fx('AUDJPY', 'Australian Dollar / Japanese Yen', 3), fx('CADJPY', 'Canadian Dollar / Japanese Yen', 3), fx('GBPAUD', 'British Pound / Australian Dollar'),
  fx('USDZAR', 'US Dollar / South African Rand', 4), fx('USDMXN', 'US Dollar / Mexican Peso', 4), fx('USDTRY', 'US Dollar / Turkish Lira', 4),
  { symbol: 'XAUUSD', name: 'Gold futures (GC)', cat: 'Metals', yahoo: 'GC=F', digits: 2 }, { symbol: 'XAGUSD', name: 'Silver futures (SI)', cat: 'Metals', yahoo: 'SI=F', digits: 3 },
  { symbol: 'USOIL', name: 'WTI crude oil futures', cat: 'Energy', yahoo: 'CL=F', digits: 2 }, { symbol: 'UKOIL', name: 'Brent crude oil futures', cat: 'Energy', yahoo: 'BZ=F', digits: 2 },
  { symbol: 'US500', name: 'S&P 500', cat: 'Indices', yahoo: '^GSPC', digits: 2 }, { symbol: 'US30', name: 'Dow Jones Industrial', cat: 'Indices', yahoo: '^DJI', digits: 2 },
  { symbol: 'NAS100', name: 'Nasdaq 100', cat: 'Indices', yahoo: '^NDX', digits: 2 }, { symbol: 'GER40', name: 'DAX 40', cat: 'Indices', yahoo: '^GDAXI', digits: 2 },
  { symbol: 'BTCUSD', name: 'Bitcoin', cat: 'Crypto', yahoo: 'BTC-USD', digits: 2 }, { symbol: 'ETHUSD', name: 'Ethereum', cat: 'Crypto', yahoo: 'ETH-USD', digits: 2 },
  { symbol: 'AAPL', name: 'Apple', cat: 'Stocks', yahoo: 'AAPL', digits: 2 }, { symbol: 'TSLA', name: 'Tesla', cat: 'Stocks', yahoo: 'TSLA', digits: 2 },
];
const YTF = { M1: ['1m', '5d', 1], M5: ['5m', '1mo', 1], M15: ['15m', '1mo', 1], M30: ['30m', '1mo', 1], H1: ['60m', '6mo', 1], H4: ['60m', '1y', 4], D1: ['1d', '5y', 1], W1: ['1wk', '10y', 1], MN: ['1mo', 'max', 1] };
const cache = new Map();
const hit = (k, ttl) => { const c = cache.get(k); return c && Date.now() - c.t < ttl * 1000 ? c.v : null; };
const put = (k, v) => { cache.set(k, { t: Date.now(), v }); return v; };

function aggregate(rows, bucket) {
  const out = [];
  for (const r of rows) {
    const start = r.t - r.t % bucket, b = out[out.length - 1];
    if (b && b.t === start) { b.h = Math.max(b.h, r.h); b.l = Math.min(b.l, r.l); b.c = r.c; b.v += r.v; }
    else out.push({ t: start, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
  }
  return out;
}

async function yahoo(ticker, interval, range) {
  let last = new ApiError(502, 'Could not reach the public price feed.');
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const r = await httpGet(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`);
    if (r.status === 429) { last = new ApiError(429, 'The price feed is rate-limiting requests. Try again shortly.'); continue; }
    if (r.status !== 200) continue;
    try {
      const body = JSON.parse(r.body).chart;
      if (body.error || !body.result) throw new ApiError(404, 'No data for this instrument right now.');
      return body.result[0];
    } catch (e) { if (e instanceof ApiError) throw e; last = new ApiError(502, 'The price feed sent an unreadable answer.'); }
  }
  throw last;
}

export const api = {
  pubInstruments: async () => ({ instruments: CATALOG.map(({ symbol, name, cat, digits }) => ({ symbol, name, cat, digits })) }),
  async pubCandles(symbol, tf, limit = 600) {
    const ins = CATALOG.find(c => c.symbol === symbol); if (!ins) throw new ApiError(404, 'Unknown instrument');
    const cfg = YTF[tf]; if (!cfg) throw new ApiError(400, 'Unsupported timeframe');
    const key = `c:${symbol}:${tf}`; let rows = hit(key, 10);
    if (!rows) {
      const res = await yahoo(ins.yahoo, cfg[0], cfg[1]);
      const ts = res.timestamp || [], q = (res.indicators?.quote || [{}])[0]; rows = [];
      ts.forEach((t, i) => {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
        if ([o, h, l, c].some(v => v == null)) return;
        rows.push({ t: Math.floor(t), o, h, l, c, v: q.volume?.[i] || 0 });
      });
      if (cfg[2] > 1) rows = aggregate(rows, 3600 * cfg[2]);
      put(key, rows);
    }
    return { candles: rows.slice(-limit) };
  },
  async news(source = 'all') {
    const FEEDS = {
      fxstreet: ['FXStreet', 'https://www.fxstreet.com/rss/news'], investing: ['Investing.com', 'https://www.investing.com/rss/news_1.rss'],
      cnbc: ['CNBC Markets', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069'],
      marketwatch: ['MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse'], bloomberg: ['Bloomberg Markets', 'https://feeds.bloomberg.com/markets/news.rss'],
      cointelegraph: ['Cointelegraph', 'https://cointelegraph.com/rss'],
    };
    const ids = source === 'all' ? Object.keys(FEEDS) : FEEDS[source] ? [source] : [];
    if (!ids.length) throw new ApiError(400, 'Unknown news source');
    const lists = await Promise.all(ids.map(async id => {
      const k = 'n:' + id, c = hit(k, 300); if (c) return c;
      const r = await httpGet(FEEDS[id][1]); if (r.status !== 200) return [];
      const doc = new DOMParser().parseFromString(r.body, 'application/xml'); if (doc.querySelector('parsererror')) return [];
      const items = [...doc.querySelectorAll('item')].map(it => {
        const g = t => (it.querySelector(t)?.textContent || '').trim();
        const link = g('link'), title = g('title'); if (!title || !link.startsWith('http')) return null;
        const d = new DOMParser().parseFromString(g('description'), 'text/html').body.textContent.replace(/\s+/g, ' ').trim().slice(0, 320);
        const ts = Date.parse(g('pubDate')); return { title, url: link, summary: d, time: Number.isNaN(ts) ? Date.now() / 1000 : Math.floor(ts / 1000), source: FEEDS[id][0], sourceId: id };
      }).filter(Boolean).sort((a, b) => b.time - a.time).slice(0, 40);
      return put(k, items);
    }));
    return { articles: lists.flat().sort((a, b) => b.time - a.time).slice(0, 80), sources: Object.fromEntries(Object.entries(FEEDS).map(([k, v]) => [k, v[0]])) };
  },
  async calendar(week = 'this') {
    week = week === 'next' ? 'next' : 'this'; const k = 'cal:' + week, c = hit(k, 1800); if (c) return { events: c };
    const r = await httpGet(`https://nfs.faireconomy.media/ff_calendar_${week}week.json`);
    if (r.status !== 200) throw new ApiError(502, 'The economic calendar feed is unavailable right now.');
    let raw; try { raw = JSON.parse(r.body); } catch { throw new ApiError(502, 'The economic calendar feed is unavailable right now.'); }
    const events = raw.map(e => { const ts = Date.parse(e.date); return Number.isNaN(ts) ? null : { time: Math.floor(ts / 1000), title: e.title || '', country: e.country || '', impact: (e.impact || 'Low').toLowerCase(), forecast: e.forecast || '', previous: e.previous || '' }; }).filter(Boolean).sort((a, b) => a.time - b.time);
    return { events: put(k, events) };
  },
};
