// Secondary screens: news, calendar, strategies, learn, settings, about, developer, assistant.
import { h, icon, clear, toast, signed, cls, ago, dt, store } from './util.js';
import { S, on, emit, inst, persist, TFS } from './state.js';
import { api } from './api.js';
import { candles } from './market.js';
import { openSheet, confirmSheet } from './ui.js';
import { hooks } from './hooks.js';
import { A } from './bridge.js';
import { TEMPLATES, backtest, toXML, fromXML, validate } from './strategy.js';

const page = (id, ...kids) => clear(document.getElementById('view-' + id)).append(h('div', { class: 'inner' }, ...kids));

// ---------------- news ----------------
export function mountNews() {
  let source = 'all', timer = null, data = null, err = null;
  const render = () => {
    const list = h('div', {});
    if (err) list.append(h('div', { class: 'empty' }, h('b', {}, 'News unavailable'), err, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: load }, 'Try again'))));
    else if (!data) for (let i = 0; i < 5; i++) list.append(h('div', { class: 'skeleton', style: { margin: '10px 0', height: '84px' } }));
    else if (!data.articles.length) list.append(h('div', { class: 'empty' }, h('b', {}, 'No headlines right now'), 'The publishers’ feeds returned nothing. Try another source.'));
    else data.articles.forEach(a => list.append(h('a', { class: 'news-item', href: a.url, target: '_blank', rel: 'noopener noreferrer' },
      h('div', { class: 'nt' }, a.title), a.summary ? h('div', { class: 'ns' }, a.summary) : null, h('div', { class: 'nm' }, h('b', {}, a.source), ago(a.time), icon('external', 12)))));
    const srcs = [['all', 'All'], ...Object.entries(data?.sources || { fxstreet: 'FXStreet', investing: 'Investing.com', cnbc: 'CNBC Markets', marketwatch: 'MarketWatch', bloomberg: 'Bloomberg Markets', cointelegraph: 'Cointelegraph' })];
    page('news', h('div', { class: 'h1' }, 'Market news'), h('p', { class: 'lead' }, 'Live headlines from publishers’ own feeds. Tap one to read it at the source.'),
      h('div', { class: 'tabs', style: { padding: '0 0 10px' } }, srcs.map(([k, l]) => h('button', { class: 'tab', 'aria-selected': String(k === source), onclick: () => { source = k; data = null; err = null; render(); load(); } }, l))), list);
  };
  async function load() {
    try { err = null; data = await api.news(source); } catch (e) { err = e.message; }
    render();
  }
  hooks.onNews = () => { render(); load(); clearInterval(timer); timer = setInterval(() => { if (document.body.dataset.screen === 'news') load(); }, 300000); };
}

// ---------------- calendar ----------------
export function mountCalendar() {
  let week = 'this', impact = 'all', ccy = 'all', data = null, err = null;
  const FLAG = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳', ZAR: '🇿🇦' };
  const render = () => {
    const body = h('div', {});
    if (err) body.append(h('div', { class: 'empty' }, h('b', {}, 'Calendar unavailable'), err, h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: load }, 'Try again'))));
    else if (!data) for (let i = 0; i < 6; i++) body.append(h('div', { class: 'skeleton', style: { margin: '8px 0', height: '40px' } }));
    else {
      const evs = data.filter(e => (impact === 'all' || e.impact === impact || (impact === 'high' && false)) && (ccy === 'all' || e.country === ccy));
      if (!evs.length) body.append(h('div', { class: 'empty' }, h('b', {}, 'No events match'), 'Change the impact or currency filter.'));
      let day = '';
      evs.forEach(e => {
        const d = new Date(e.time * 1000), label = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
        if (label !== day) { day = label; body.append(h('div', { class: 'cal-day' }, label)); }
        body.append(h('div', { class: 'cal-row' + (e.time < Date.now() / 1000 ? ' past' : '') },
          h('div', { class: 'mute' }, d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), h('div', {}, (FLAG[e.country] || '') + ' ' + e.country),
          h('div', {}, h('span', { class: 'impact ' + e.impact, title: e.impact + ' impact' }), ' ', e.title), h('div', { class: 'f' }, e.forecast ? `F ${e.forecast}` : '', e.previous ? h('div', {}, `P ${e.previous}`) : null)));
      });
    }
    const ccys = ['all', ...new Set((data || []).map(e => e.country))];
    page('calendar', h('div', { class: 'h1' }, 'Economic calendar'), h('p', { class: 'lead' }, `Times shown in your local time zone. F = forecast, P = previous.`),
      h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '8px' } },
        h('div', { class: 'seg' }, [['this', 'This week'], ['next', 'Next week']].map(([k, l]) => h('button', { 'aria-pressed': String(week === k), onclick: () => { week = k; data = null; render(); load(); } }, l))),
        h('div', { class: 'seg' }, ['all', 'high', 'medium', 'low'].map(k => h('button', { 'aria-pressed': String(impact === k), onclick: () => { impact = k; render(); } }, k === 'all' ? 'All impact' : k[0].toUpperCase() + k.slice(1)))),
        h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Currency', onchange: e => { ccy = e.target.value; render(); } }, ccys.map(c => h('option', { value: c, selected: c === ccy }, c === 'all' ? 'All currencies' : c)))),
      body);
  };
  async function load() { try { err = null; data = (await api.calendar(week)).events; } catch (e) { err = e.message; } render(); }
  hooks.onCalendar = () => { render(); if (!data) load(); };
}

// ---------------- strategies ----------------

// ---------------- strategies ----------------
export function mountStrategies() {
  let strat = store.get('labStrategy') || TEMPLATES.ema_cross(), result = null, running = false;
  const opts = { bars: 1000, balance: 10000, spread: 0, contract: null };
  const save = () => store.set('labStrategy', strat);
  const live = () => { try { return JSON.parse(A.getStrategy() || 'null'); } catch { return null; } };
  const render = () => {
    const i = inst(S.symbol) || {}, cs = opts.contract ?? i.contractSize ?? guessContract(S.symbol), act = live();
    const xml = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Strategy XML' }); xml.value = toXML(strat);
    const msg = h('div', { class: 'err' });
    const num = (key, label, step = 1) => h('div', { class: 'field' }, h('label', {}, label), h('input', { class: 'input', type: 'number', step, value: key === 'contract' ? cs : opts[key], onchange: e => { opts[key] = parseFloat(e.target.value); } }));
    const file = h('input', { type: 'file', accept: '.xml,text/xml,application/xml', class: 'hide', onchange: async e => { const f = e.target.files[0]; if (!f) return; try { strat = fromXML(await f.text()); save(); result = null; render(); toast('Strategy imported: ' + strat.name, 'ok'); } catch (er) { toast(er.message, 'error'); } } });
    const apply = () => { try { strat = fromXML(xml.value); save(); msg.textContent = ''; result = null; toast('Rules applied', 'ok'); render(); return true; } catch (e) { msg.textContent = e.message; return false; } };
    const activate = () => { if (!apply()) return; A.setStrategy(JSON.stringify(strat)); toast(`Kanairy will trade “${strat.name}”`, 'ok'); render(); };
    page('strategies', h('div', { class: 'h1' }, 'Strategy lab'), h('p', { class: 'lead' }, 'Build or import XML rules, test them on real history, then press Use for live trading. Kanairy runs the active strategy on your MT5 chart and places the trades.'),
      h('div', { class: 'card live-card' + (act ? ' on' : '') },
        h('div', { class: 'row' }, h('span', { class: 'status' + (act ? ' live' : '') }), h('div', { class: 'grow' }, h('b', {}, act ? `Live: ${act.name}` : 'No strategy is trading yet'), h('div', { class: 'hint' }, act ? `${act.risk.lots} lots · SL ${act.risk.slAtr ?? '–'}×ATR · TP ${act.risk.tpAtr ?? '–'}×ATR` : 'Pick a template or import XML, then press Use for live trading.')),
          act ? h('button', { class: 'btn sm', onclick: () => { A.setStrategy(''); toast('Live strategy cleared'); render(); } }, 'Stop') : null)),
      h('div', { style: { height: '12px' } }),
      h('div', { class: 'card stack' },
        h('div', { class: 'lbl' }, 'Start from a template or import your own XML'),
        h('div', { class: 'chips' }, Object.entries(TEMPLATES).map(([k, f]) => h('button', { class: 'chip', onclick: () => { strat = f(); save(); result = null; render(); } }, f().name)), h('button', { class: 'chip', onclick: () => file.click() }, icon('upload', 12), ' Import XML'), file),
        xml, h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('button', { class: 'btn sm', onclick: apply }, 'Apply changes'),
          h('button', { class: 'btn sm', onclick: () => { const ok = A.saveFile(strat.name.replace(/\W+/g, '_') + '.xml', xml.value); toast(ok ? 'Saved to Downloads/Kanairy' : 'Could not save the file', ok ? 'ok' : 'error'); } }, icon('download', 14), 'Export XML'),
          h('button', { class: 'btn sm primary', onclick: activate }, 'Use for live trading')), msg,
        h('p', { class: 'hint' }, 'Operands: ema:21, sma:50, rsi:14, macd:hist, bb:upper:20:2, close, or a number. Rules: <cross a b dir="above|below"/> and <compare a op="gt|lt" b/>. Volume-based indicators need volume, which a screen read does not have, so use price indicators for live trading. Entries use the last closed candle on your MT5 chart.')),
      h('div', { style: { height: '12px' } }),
      h('div', { class: 'card stack' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, `Test on ${S.symbol} · ${strat.timeframe}`),
        h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Symbol', onchange: e => { S.symbol = e.target.value; persist(); render(); } }, S.instruments.map(x => h('option', { selected: x.symbol === S.symbol }, x.symbol))),
        h('select', { class: 'input', style: { width: 'auto' }, 'aria-label': 'Timeframe', onchange: e => { strat.timeframe = e.target.value; save(); render(); } }, TFS.map(t => h('option', { selected: t === strat.timeframe }, t)))),
        h('div', { class: 'two' }, num('bars', 'Bars to test (max 5000)', 100), num('balance', 'Starting balance', 100)), h('div', { class: 'two' }, num('spread', 'Spread (price units)', 'any'), num('contract', 'Contract size')),
        h('button', { class: 'btn primary', id: 'btRun', disabled: running, onclick: run }, running ? 'Testing…' : 'Run backtest')),
      result ? resultCard() : null);
  };
  const guessContract = s => { const c = inst(s)?.cat || ''; return /forex/i.test(c) ? 100000 : /metal/i.test(c) ? 100 : 1; };
  async function run() {
    const errs = validate(strat); if (errs.length) { toast(errs[0], 'error'); return; }
    running = true; render();
    try {
      const n = Math.max(100, Math.min(5000, Math.round(opts.bars) || 1000));
      const cs = await candles(S.symbol, strat.timeframe, Math.min(n, 1000));
      if (cs.length < 60) throw new Error('Not enough price history for this symbol and timeframe.');
      const i = inst(S.symbol) || {};
      const r = backtest(strat, cs, { balance: opts.balance, spread: opts.spread || 0, contractSize: opts.contract ?? i.contractSize ?? guessContract(S.symbol) });
      result = { ...r, bars: cs.length, from: cs[0].t, to: cs[cs.length - 1].t, symbol: S.symbol, tf: strat.timeframe, balance: opts.balance };
    } catch (e) { toast(e.message, 'error'); }
    running = false; render();
    if (result) drawEquity();
  }
  function resultCard() {
    const s = result.stats, c = 'quote ccy';
    const k = (l, v, x) => h('div', { class: 'kpi' }, h('div', { class: 'v ' + (x || '') }, v), h('div', { class: 'k' }, l));
    return h('div', { class: 'card stack', style: { marginTop: '12px' } },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, `Result · ${result.bars} bars of ${result.symbol} ${result.tf}`)),
      h('p', { class: 'hint' }, `${dt(result.from)} → ${dt(result.to)}. Profit is in the symbol’s quote currency (${c}), before swaps and commissions.`),
      h('div', { class: 'grid' }, k('Net profit', signed(s.net), cls(s.net)), k('Return', signed(s.returnPct) + '%', cls(s.returnPct)), k('Trades', s.trades), k('Win rate', s.winRate.toFixed(1) + '%'), k('Profit factor', Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'), k('Max drawdown', s.maxDrawdownPct.toFixed(2) + '%', 'down'), k('Avg win / loss', `${s.avgWin.toFixed(2)} / ${s.avgLoss.toFixed(2)}`), k('Worst losing streak', s.worstLosingStreak)),
      h('canvas', { class: 'eq-canvas', id: 'eqCanvas', 'aria-label': 'Equity curve' }),
      s.trades < 30 ? h('p', { class: 'hint' }, 'Fewer than 30 trades is too few to trust these numbers. Test more bars or another symbol.') : null,
      h('div', { class: 'table-wrap', style: { maxHeight: '260px' } }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Side', 'Entry', 'Exit', 'Reason', 'Bars', 'P/L'].map((t, i) => h('th', { class: i > 3 ? 'r' : '' }, t)))),
        h('tbody', {}, result.trades.slice(-100).reverse().map(t => h('tr', {}, h('td', {}, h('span', { class: 'pill ' + (t.side === 'long' ? 'buy' : 'sell') }, t.side)), h('td', {}, dt(t.entryT)), h('td', {}, dt(t.exitT)), h('td', {}, t.reason), h('td', { class: 'r' }, t.bars), h('td', { class: 'r ' + cls(t.pnl) }, signed(t.pnl))))))));
  }
  function drawEquity() {
    const cv = document.getElementById('eqCanvas'); if (!cv || !result) return;
    const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1; cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const pts = result.equity, W = r.width, H = r.height, lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v)), span = hi - lo || 1;
    const X = i => 8 + i / Math.max(1, pts.length - 1) * (W - 16), Y = v => H - 18 - (v - lo) / span * (H - 36);
    ctx.strokeStyle = css('--line'); ctx.beginPath(); const y0 = Y(result.balance); ctx.moveTo(0, y0); ctx.lineTo(W, y0); ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))); ctx.strokeStyle = result.stats.net >= 0 ? css('--up') : css('--down'); ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = css('--mute'); ctx.font = '11px system-ui'; ctx.fillText(hi.toFixed(2), 8, 12); ctx.fillText(lo.toFixed(2), 8, H - 6);
  }
  hooks.onStrategies = render;
  on('theme', () => { if (result && document.body.dataset.screen === 'strategies') drawEquity(); });
}

// ---------------- static pages ----------------
export function mountLearn() {
  const sec = (t, ...ps) => h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h3', { style: { marginBottom: '8px' } }, t), ...ps);
  const ul = items => h('ul', { style: { paddingLeft: '20px', color: 'var(--mute)' } }, items.map(i => h('li', { style: { marginBottom: '5px' } }, i)));
  page('learn', h('div', { class: 'h1' }, 'Learn trading'), h('p', { class: 'lead' }, 'The essentials, kept short. Practise on a demo account before risking real money.'),
    sec('How forex works', h('p', { class: 'mute' }, 'You buy one currency while selling another, so every price is a pair such as EUR/USD. The price tells you how much of the second currency one unit of the first costs.'),
      ul(['Pip: the usual unit of price movement (0.0001 for most pairs, 0.01 for JPY pairs).', 'Lot: trade size. 1.00 lot is 100,000 units of the base currency; 0.01 is a micro lot.', 'Spread: the gap between bid (you sell) and ask (you buy). It is your entry cost.', 'Leverage: lets you control a larger position with less margin, and magnifies losses as much as gains.', 'Margin: the funds your broker sets aside to keep a position open.'])),
    sec('Reading the chart', ul(['Candles show open, high, low and close for each period. Green/blue closed higher, red/orange lower.', 'Moving averages smooth price. When a fast one crosses a slow one, the trend may be changing.', 'RSI above 70 or below 30 hints at stretched moves, but strong trends can stay stretched.', 'MACD tracks momentum; Bollinger Bands show how wide the recent range is; ATR measures typical movement and is a good basis for stop distances.', 'Support and resistance are price levels the market has reacted to before. Kanairy also marks recent swing highs and lows as levels.'])),
    sec('Protecting your account', ul(['Risk a small fixed share of the balance per trade (1–2% is a common rule).', 'Set a stop loss before you enter. Kanairy sets one on every trade.', 'Aim for a reward bigger than the risk, but remember win rate matters as much as the ratio.', 'Check the economic calendar. High-impact releases can move price hundreds of pips in seconds and widen spreads.', 'Keep a journal. MT5’s History tab shows every deal your broker recorded.'])),
    sec('Position size formula', h('p', { class: 'mute' }, 'Lots = (balance × risk %) ÷ (stop distance in price × contract size). Example: 10,000 balance, 1% risk, 0.0020 stop on EUR/USD (contract size 100,000) → 100 ÷ 200 = 0.50 lots.')),
    sec('Honest expectations', h('p', { class: 'mute' }, 'Most retail traders lose money. Leverage, costs and emotion are the usual reasons. No indicator, robot or strategy removes that risk, and a backtest only shows what would have happened in the past.')));
}

export function mountAbout() {
  page('about', h('div', { class: 'h1' }, 'About Kanairy'), h('p', { class: 'lead' }, 'An Android trading robot that watches your MT5 chart, runs your Strategy lab rules and places the trades.'),
    h('div', { class: 'card prose' },
      h('h3', {}, 'What it does'), h('ul', {}, ['Floats over the MT5 Android app and reads the live chart from the screen.', 'Runs the strategy you activate in the Strategy lab (XML rules, 25+ indicators) on those candles.', 'Opens the order ticket in MT5, fills lot, stop loss and take profit, and presses Buy or Sell.', 'Watches open trades, closes on reversal or after a time limit, and keeps a daily cap.', 'Tests strategies on real history, and streams news and the economic calendar.']),
      h('h3', {}, 'Your login'), h('p', {}, 'Kanairy never sees your broker login. It only taps buttons inside your own MT5 app. No PC, no VPS and no trading server are involved.'),
      h('h3', {}, 'What leaves the phone'), h('p', {}, 'Only public requests for the Strategy lab backtests, news and calendar. Chart reading, decisions and trading happen on the phone.'),
      h('h3', {}, 'Risk warning'), h('p', {}, 'Trading leveraged products carries a high risk of losing money. Kanairy is a tool, not financial advice, and makes no promise of profit. Start in Paper mode and test on a demo account first.')));
}

export function mountDeveloper() {
  page('developer', h('div', { class: 'h1' }, 'About the developer'), h('p', { class: 'lead' }, 'Thakgalo Matlala · Soshanguve, Pretoria, South Africa'),
    h('div', { class: 'card prose' }, h('p', {}, 'Thakgalo is a self-taught programmer and trader who started with forex at 13. He built KanAIRY to make a capable trading terminal available to anyone with a phone.'),
      h('p', {}, 'He plans to keep growing the platform, study computer science and finance, and mentor other young people in South Africa who are interested in trading and technology.')));
}

export function mountAssistant() {
  const v = document.getElementById('view-assistant');
  hooks.onAssistant = () => { if (!v.firstChild) v.append(h('iframe', { src: 'https://helpful-taiyaki-620c2c.netlify.app/', title: 'Kanairy AI assistant', allow: 'clipboard-write', referrerpolicy: 'no-referrer' })); };
}

// ---------------- settings ----------------
const TRADING_FIELDS = [
  ['Fallback lot size (when the strategy has none)', 'lot', '0.01'], ['Max open trades', 'max_open', '1'], ['Max trades per day', 'max_day', '20'],
  ['Cooldown between trades (min)', 'cooldown', '2'], ['Scan every (seconds)', 'interval', '20'], ['Close everything after (min, 0 = off)', 'hold_min', '0'],
  ['Built-in engine: signal threshold', 'thr', '3'], ['Built-in engine: stop loss (×ATR)', 'sl_atr', '1.5'], ['Built-in engine: take profit (risk:reward)', 'rr', '2'],
];
export function mountSettings() {
  const render = () => {
    const set = (k, v) => { S.settings[k] = v; persist(); emit('settings'); };
    const row = (t, d, control) => h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, t), d ? h('div', { class: 'd' }, d) : null), control);
    const toggle = (k) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: !!S.settings[k], 'aria-label': k, onchange: e => set(k, e.target.checked) }), h('i'));
    const flag = (k, d) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: A.getFlag(k, d), 'aria-label': k, onchange: e => A.setFlag(k, e.target.checked) }), h('i'));
    const num = (t, k, d) => row(t, null, h('input', { class: 'input', style: { width: '96px', textAlign: 'right' }, inputMode: 'decimal', value: A.getCfg(k, d), onchange: e => A.setCfg(k, e.target.value.trim()) }));
    const colors = ['Auto detect', 'Green up / Red down', 'Blue up / Red down', 'Green up / Blue down', 'Red up / Green down'];
    page('settings', h('div', { class: 'h1' }, 'Settings'), h('p', { class: 'lead' }, 'Saved on this device.'),
      h('div', { class: 'card' },
        row('Theme', 'Dark suits low light; light suits daylight.', h('div', { class: 'seg' }, ['dark', 'light'].map(t => h('button', { 'aria-pressed': String(S.settings.theme === t), onclick: () => { set('theme', t); render(); } }, t[0].toUpperCase() + t.slice(1))))),
        row('Colour-blind palette', 'Uses blue and orange instead of green and red.', toggle('colorblind'))),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'h2' }, 'Trading'),
      h('div', { class: 'card' }, TRADING_FIELDS.map(([t, k, d]) => num(t, k, d)),
        row('Check open positions before each entry', 'Reads MT5’s Trade tab so the max-open limit is real.', flag('pos_check', true))),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'h2' }, 'Chart reading'),
      h('div', { class: 'card' },
        row('Candle colours', null, h('select', { class: 'input', style: { width: 'auto' }, onchange: e => A.setCfg('color', e.target.value) }, colors.map((c, i) => h('option', { value: i, selected: String(i) === String(A.getCfg('color', 0)) }, c)))),
        row('Auto-find the chart area', 'Uses the price axis to locate the chart, so no manual margins.', flag('auto_region', true)),
        row('Auto-zoom the chart', 'Pinches the chart until candles are sharp and numerous enough to read.', flag('auto_zoom', true)),
        row('Sharpen image before reading', 'Upscales and cleans the price axis (about 3×) for the text reader.', flag('enhance', true)),
        num('Fallback: ignore top (%)', 'm_top', '14'), num('Fallback: ignore bottom (%)', 'm_bot', '13'), num('Fallback: price axis width (%)', 'm_right', '13')),
      h('div', { style: { height: '14px' } }),
      h('div', { class: 'card' }, row('Clear local data', 'Removes saved strategies and settings from this device. Your broker account is not affected.',
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmSheet({ title: 'Clear local data', message: 'This removes everything Kanairy saved on this device.', okText: 'Clear everything', danger: true })) { Object.keys(localStorage).filter(k => k.startsWith('kanairy.')).forEach(k => localStorage.removeItem(k)); A.setStrategy(''); location.reload(); } } }, 'Clear'))));
  };
  hooks.onSettings = render;
}
