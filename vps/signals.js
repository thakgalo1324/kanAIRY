// Reads trade signals written as plain text ("GOLD BUY 3927 3928 / TP 3935 / TP 3945 / TP 3960 / SL 3920") and plans safe market orders.
// Pure functions, no network. Anything unclear is rejected on purpose: a missing stop loss or odd numbers never become a trade.
const NUM = '(\\d{3,5}(?:\\.\\d+)?)';

export function parseSignal(raw) {
  const text = String(raw || '').replace(/[–—]/g, '-').replace(/\*/g, '').trim();
  if (!text) return { ok: false, reason: 'Empty message' };
  if (/\b(hit|profit|running|booked|closed|result|target\s*done)\b/i.test(text)) return { ok: false, reason: 'Looks like a result update, not a new signal' };
  if (/\b(limit|stop)\b(?!\s*loss)/i.test(text)) return { ok: false, reason: 'Pending orders (limit/stop) are not supported' };
  let m = new RegExp('\\b(?:gold|xauusd)\\b[^\\n\\d]*?\\b(buy|sell)\\b\\s*(?:@|at|now)?\\s*' + NUM + '(?:\\s*(?:-|to|/|\\s)\\s*' + NUM + ')?', 'i').exec(text);
  let side = '', a = 0, b = 0;
  if (m) { side = m[1].toLowerCase(); a = +m[2]; b = m[3] ? +m[3] : a; }
  else {
    m = new RegExp('\\b(buy|sell)\\b\\s*(?:gold|xauusd)\\b\\s*(?:@|at|now)?\\s*' + NUM + '(?:\\s*(?:-|to|/|\\s)\\s*' + NUM + ')?', 'i').exec(text);
    if (m) { side = m[1].toLowerCase(); a = +m[2]; b = m[3] ? +m[3] : a; }
  }
  if (!side) return { ok: false, reason: 'No GOLD BUY/SELL with a price found' };
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const tps = [];
  // "TP 3935", "TP1 3935", "TP: 3935 / 3945 / 3960". A single digit right after TP is the TP number, not part of the price.
  const tpRe = /\bTPs?\s*(?:\d(?=[\s:@=-]))?\s*[:@=-]?\s*(\d{3,5}(?:\.\d+)?(?:\s*[,\/&]\s*\d{3,5}(?:\.\d+)?)*)/gi;
  for (const t of text.matchAll(tpRe)) for (const n of t[1].match(/\d{3,5}(?:\.\d+)?/g) || []) tps.push(+n);
  const s = new RegExp('\\b(?:SL|stop\\s*loss)\\s*[:@=-]?\\s*' + NUM, 'i').exec(text);
  if (!s) return { ok: false, reason: 'No stop loss (SL) in the message, so it was not traded' };
  const sl = +s[1];
  if (!tps.length) return { ok: false, reason: 'No take profit (TP) found' };
  if (hi - lo > 15) return { ok: false, reason: 'Entry range is too wide to trust' };
  if (side === 'buy') {
    if (!(sl < lo)) return { ok: false, reason: 'Stop loss is not below the entry for a BUY' };
    if (tps.some(t => t <= hi)) return { ok: false, reason: 'A take profit is not above the entry for a BUY' };
    tps.sort((x, y) => x - y);
  } else {
    if (!(sl > hi)) return { ok: false, reason: 'Stop loss is not above the entry for a SELL' };
    if (tps.some(t => t >= lo)) return { ok: false, reason: 'A take profit is not below the entry for a SELL' };
    tps.sort((x, y) => y - x);
  }
  return { ok: true, symbol: 'XAUUSD', side, lo, hi, tps: [...new Set(tps)].slice(0, 5), sl };
}

// Plan market orders now, given the live price. Returns { ok, orders:[{sl,tp}] } (distances from the fill price) or { wait } / { ok:false, reason }.
export function planOrders(sig, price, o = {}) {
  const { bid, ask } = price, tol = o.tol ?? 1.5, maxOrders = Math.max(1, Math.min(o.maxOrders ?? 3, sig.tps.length));
  const buy = sig.side === 'buy', px = buy ? ask : bid;
  if (!(px > 0)) return { ok: false, wait: true, reason: 'Waiting for a price' };
  if (Math.abs(px - (sig.lo + sig.hi) / 2) > 120) return { ok: false, reason: 'The signal price is far from the live price. Wrong symbol or an old signal.' };
  if (buy) { if (px - sig.sl < 1) return { ok: false, reason: 'Price is already at the stop loss' }; if (px > sig.hi + tol) return { ok: false, wait: true, reason: 'Price is above the entry zone. Waiting for a dip into it.' }; }
  else { if (sig.sl - px < 1) return { ok: false, reason: 'Price is already at the stop loss' }; if (px < sig.lo - tol) return { ok: false, wait: true, reason: 'Price is below the entry zone. Waiting for a bounce into it.' }; }
  const tps = sig.tps.filter(t => (buy ? t - px >= 1 : px - t >= 1)).slice(0, maxOrders);
  if (!tps.length) return { ok: false, reason: 'Every take profit is already reached' };
  const slD = buy ? px - sig.sl : sig.sl - px;
  if (o.maxSl && slD > o.maxSl) return { ok: false, reason: `Stop loss is ${slD.toFixed(1)} away, more than your limit of ${o.maxSl}` };
  return { ok: true, orders: tps.map(t => ({ sl: +slD.toFixed(3), tp: +(buy ? t - px : px - t).toFixed(3) })) };
}
