// API client for the public data routes. Normalises errors and applies timeouts.
export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

async function call(method, path, { query, signal, timeout = 25000 } = {}) {
  const url = new URL(path, location.origin);
  if (query) Object.entries(query).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
  signal?.addEventListener('abort', () => ctl.abort());
  let res;
  try {
    res = await fetch(url, { method, signal: ctl.signal });
  } catch (e) {
    if (e.name === 'AbortError' && !timedOut) throw e;       // the caller cancelled it (symbol changed, screen closed)
    throw new ApiError(0, e.name === 'AbortError' ? 'The server took too long to answer.' : 'Cannot reach the server. Check your connection.', 'network');
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || data?.detail?.[0]?.msg || `Request failed (${res.status})`, data?.code);
  }
  return data;
}

const get = (p, o) => call('GET', p, o);
export const api = {
  health: () => get('/api/health'),
  pubInstruments: () => get('/api/public/instruments'),
  pubQuotes: (symbols, signal) => get('/api/public/quotes', { query: { symbols: symbols.join(',') }, signal, timeout: 25000 }),
  pubCandles: (symbol, timeframe, limit, signal) => get('/api/public/candles', { query: { symbol, timeframe, limit }, signal, timeout: 40000 }),
  news: source => get('/api/news', { query: { source } }),
  calendar: week => get('/api/calendar', { query: { week } }),
};
