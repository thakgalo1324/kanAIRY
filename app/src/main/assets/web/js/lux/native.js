// Talks to your Kanairy server on the VPS through the Android app (signed requests).
// In a normal browser (no Android) it runs a small demo so the design can be previewed.
const N = window.Android || null;
const T = N ? N.token() : '';
export const native = !!N;
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ---------- request plumbing ----------
let seq = 0;
const pend = new Map();
window.__vpsCb = (id, status, text) => { const f = pend.get(id); if (f) { pend.delete(id); f({ status, text }); } };
function req(method, path, body) {
  return new Promise(res => {
    if (!N) { res({ status: 0, text: '' }); return; }
    const id = ++seq;
    const to = setTimeout(() => { pend.delete(id); res({ status: 0, text: 'timeout' }); }, 30000);
    pend.set(id, r => { clearTimeout(to); res(r); });
    N.vps(T, id, method, path, body ? JSON.stringify(body) : '');
  });
}

// ---------- cache the UI reads from ----------
const C = { status: {}, feed: [], strat: null, stratRev: -1, link: N ? 'unconfigured' : 'ok', vps: { url: '', hasKey: false, user: '' }, hello: null, n: 0, bad: 0, busy: false };
async function poll() {
  if (!N || C.busy) return;
  C.busy = true;
  try {
    C.vps = parse(N.vpsInfo(T), { url: '', hasKey: false, user: '' });
    if (!C.vps.url || !C.vps.hasKey) { C.link = 'unconfigured'; return; }
    if (!C.vps.user) { // shared key only: check the server and wait for sign-in
      const h = await req('GET', '/api/hello');
      C.link = h.status === 200 ? 'nouser' : h.status === 401 ? 'badkey' : 'offline';
      C.hello = h.status === 200 ? parse(h.text, null) : null; C.status = {};
      return;
    }
    const r = await req('GET', '/api/status');
    if (r.status === 200) {
      C.link = 'ok'; C.bad = 0;
      C.status = parse(r.text, {});
      if (C.status.rev !== C.stratRev) {
        const s = await req('GET', '/api/strategy');
        if (s.status === 200) { C.strat = parse(s.text, {}).strategy || null; C.stratRev = C.status.rev; }
      }
      if (C.n++ % 2 === 0) { const f = await req('GET', '/api/feed'); if (f.status === 200) C.feed = parse(f.text, []); }
    } else C.link = r.status === 401 && ++C.bad >= 4 ? 'badpin' : r.status === 401 ? C.link : r.status === 429 ? 'locked' : 'offline';
  } finally { C.busy = false; }
}
if (N) { setInterval(poll, 2500); poll(); }

// ---------- demo (preview only) ----------
const demo = { ea: { mode: 'kanairy', name: '', state: 'none', log: '', hasPreset: false }, run: false, pos: [], feed: [], pnl: 0, trades: 0, wins: 0, cfg: {}, strat: null, login: '', server: '', hasPw: false, symbol: 'XAUUSD' };
function demoTick() {
  if (!demo.run) return;
  if (Math.random() < .35 && demo.pos.length < 3) {
    const buy = Math.random() < .5, p = 2314 + Math.random() * 3;
    demo.pos.push([Date.now(), buy ? 0 : 1, 0.01, p, p - 1.1, p + 1.6, 0]);
    demo.feed.unshift({ t: Date.now(), k: 'open', text: (buy ? 'BUY' : 'SELL') + ' opened', side: buy ? 'buy' : 'sell', lots: 0.01, price: p, profit: 0 });
  }
  demo.pos.forEach(p => { p[6] = +(p[6] + (Math.random() - .42) * .9).toFixed(2); });
  if (demo.pos.length && Math.random() < .45) {
    const p = demo.pos.shift();
    demo.pnl += p[6]; demo.trades++; if (p[6] >= 0) demo.wins++;
    demo.feed.unshift({ t: Date.now(), k: 'close', text: (p[1] ? 'SELL' : 'BUY') + ' closed', side: p[1] ? 'sell' : 'buy', lots: p[2], price: p[3], profit: p[6] });
  }
  demo.feed = demo.feed.slice(0, 40);
}
if (!N) setInterval(demoTick, 1800);

// ---------- public API ----------
const LINK_TEXT = { unconfigured: 'Connect your server in Setup first', offline: 'Cannot reach your server. Check the address and that it is running', badkey: 'The server rejected your key. Check it in Setup', nouser: 'Sign in on the Setup tab first', badpin: 'Wrong name or PIN. Sign in again on the Setup tab', locked: 'Too many wrong PINs. Try again in a few minutes' };
const linkOk = () => { if (!N || C.link === 'ok') return true; B.onError(LINK_TEXT[C.link] || 'Server not connected'); return false; };

export const B = {
  onError: () => {},
  link: () => C.link,
  linkOk,
  vps: () => C.vps,
  status() {
    if (!N) return { link: 'ok', svc: true, run: demo.run, conn: true, sym: 'XAUUSD', tf: 'M1', bal: 10000 + demo.pnl, eq: 10000 + demo.pnl + demo.pos.reduce((a, p) => a + p[6], 0), pos: demo.pos, dayPnl: +demo.pnl.toFixed(2), dayTrades: demo.trades, wins: demo.wins, losses: demo.trades - demo.wins, signal: 'WAIT', err: '', strategy: demo.strat ? demo.strat.name : '' };
    return { ...C.status, link: C.link, run: C.link === 'ok' && !!C.status.run, conn: C.link === 'ok' && !!C.status.conn, strategy: C.link === 'ok' ? (C.status.strategy || '') : '' };
  },
  feed: () => (N ? C.feed : demo.feed),
  info: () => (N ? (C.status.info || {}) : { login: demo.login, server: demo.server, hasPw: demo.hasPw, symbol: demo.symbol }),
  pollNow: () => poll(),
  async run(on) { if (!linkOk()) return; if (N) { await req('POST', '/api/run', { on: !!on }); C.status.run = !!on; poll(); } else demo.run = !!on; },
  async kill() { if (!linkOk()) return; if (N) { await req('POST', '/api/kill', {}); C.status.run = false; poll(); } else { demo.run = false; demo.pos = []; } },
  async saveLogin(login, server, password, symbol) {
    if (!linkOk()) return false;
    if (!N) { demo.login = login; demo.server = server; demo.symbol = symbol; if (password) demo.hasPw = true; return true; }
    const r = await req('POST', '/api/login', { login, server, password, symbol });
    poll(); return r.status === 200;
  },
  async clearLogin() { if (!linkOk()) return; if (N) { await req('POST', '/api/login', { clear: true }); poll(); } else { demo.login = ''; demo.server = ''; demo.hasPw = false; } },
  async launch() {
    if (!N) return { ok: false, error: 'Preview only. Install the Android app.' };
    if (!linkOk()) return { ok: false, error: LINK_TEXT[C.link] };
    const r = await req('POST', '/api/launch', {});
    return parse(r.text, { ok: false, error: 'No answer from the server' });
  },
  getCfg: (k, d) => (N ? (C.status.cfg && C.status.cfg[k] !== undefined ? C.status.cfg[k] : d) : (demo.cfg[k] ?? d)),
  async setCfg(k, v) {
    if (!linkOk()) return;
    if (!N) { demo.cfg[k] = v; return; }
    if (C.status.cfg) C.status.cfg[k] = Number(v);
    await req('POST', '/api/cfg', { key: k, value: Number(v) });
  },
  getStrategy: () => { const s = N ? C.strat : demo.strat; return s ? JSON.stringify(s) : ''; },
  async setStrategy(json) {
    if (!linkOk()) return false;
    const s = parse(json, null);
    if (!N) { demo.strat = s; return true; }
    C.strat = s; if (C.status) C.status.strategy = s ? s.name : '';
    const r = await req('POST', '/api/strategy', { strategy: s });
    poll(); return r.status === 200;
  },
  // ---- imported .mq5 expert advisor (the phone sends the source, the server compiles and runs it in MT5) ----
  ea: () => (N ? (C.status.ea || { mode: 'kanairy', name: '', state: 'none', log: '', hasPreset: false }) : demo.ea),
  async importEa(name, source) {
    if (!linkOk()) return { ok: false, error: LINK_TEXT[C.link] };
    if (!N) { demo.ea = { mode: 'kanairy', name, state: 'ok', log: 'Preview only', hasPreset: false }; return { ok: true }; }
    const r = await req('POST', '/api/ea/import', { name, source });
    poll(); return parse(r.text, { ok: false, error: r.status === 0 ? 'The server did not answer. Try again.' : 'Server error ' + r.status });
  },
  async importEx5(name, b64) {
    if (!linkOk()) return { ok: false, error: LINK_TEXT[C.link] };
    if (!N) { demo.ea = { mode: 'kanairy', name, state: 'ok', log: 'Preview only', hasPreset: false }; return { ok: true }; }
    const r = await req('POST', '/api/ea/import', { name, ex5: b64 });
    poll(); return parse(r.text, { ok: false, error: r.status === 0 ? 'The server did not answer. Try again.' : 'Server error ' + r.status });
  },
  async importPreset(text) {
    if (!linkOk()) return { ok: false, error: LINK_TEXT[C.link] };
    if (!N) return { ok: true };
    const r = await req('POST', '/api/ea/preset', { text });
    poll(); return parse(r.text, { ok: false, error: 'No answer from the server' });
  },
  async setEaMode(mode, tf) {
    if (!linkOk()) return { ok: false, error: LINK_TEXT[C.link] };
    if (!N) { demo.ea.mode = mode; return { ok: true }; }
    const r = await req('POST', '/api/ea/mode', { mode, tf });
    poll(); return parse(r.text, { ok: false, error: 'No answer from the server' });
  },
  saveVps(url, key) { if (N) N.saveVps(T, url, key); },
  // ---- accounts: one shared app key, then a name and PIN for each person ----
  user: () => (N ? (C.vps.user || '') : 'preview'),
  hello: () => C.hello || null,
  async signIn(name, pin) {
    if (!N) return { ok: true };
    N.saveUser(T, name, pin);
    const r = await req('GET', '/api/me');
    if (r.status === 200) { C.status = {}; C.stratRev = -1; await poll(); return { ok: true }; }
    N.clearUser(T); poll();
    return { ok: false, error: r.status === 401 ? 'Wrong name or PIN' : r.status === 429 ? 'Too many wrong PINs. Try again in a few minutes.' : 'Cannot reach your server' };
  },
  async createAccount(name, pin) {
    if (!N) return { ok: true };
    const key = N.deriveUserKey(T, name, pin);
    if (!key) return { ok: false, error: 'Save the server key first' };
    const r = await req('POST', '/api/register', { name, userKey: key });
    const j = parse(r.text, { ok: false, error: r.status === 401 ? 'The server rejected the app key' : 'Cannot reach your server' });
    if (!j.ok) return j;
    return B.signIn(name, pin);
  },
  signOut() { if (N) { N.clearUser(T); C.status = {}; C.stratRev = -1; poll(); } },
  async deleteAccount() {
    if (!N) return { ok: true };
    const r = await req('POST', '/api/account/delete', {});
    if (r.status === 200) { N.clearUser(T); C.status = {}; poll(); return { ok: true }; }
    return { ok: false, error: 'Could not delete. Try again.' };
  },
};
