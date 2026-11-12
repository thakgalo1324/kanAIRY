// Home: the robot's control room. Setup checklist, live signal, controls.
import { h, icon, clear, toast } from './util.js';
import { confirmSheet } from './ui.js';
import { on } from './state.js';
import { A, native } from './bridge.js';
import { hooks } from './hooks.js';

const root = () => document.getElementById('view-home');
let st = { svc: false, log: [] };

const MODES = [['lab', 'Strategy lab'], ['builtin', 'Built-in'], ['both', 'Both agree']];

export function mountHome() {
  const render = () => {
    const sig = st.action || 'WAIT';
    const step = (ok, title, desc, label, act) => h('div', { class: 'setting' }, h('span', { class: 'status' + (ok ? ' live' : ' bad') }),
      h('div', { class: 'grow' }, h('div', { class: 't' }, title), h('div', { class: 'd' }, desc)), ok ? null : h('button', { class: 'btn sm', onclick: () => A.act(act) }, label));
    const tog = (label, desc, on_, fn) => h('div', { class: 'setting' }, h('div', { class: 'grow' }, h('div', { class: 't' }, label), h('div', { class: 'd' }, desc)),
      h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: on_, onchange: e => fn(e.target.checked) }), h('i')));
    const act = (label, name, cls = '') => h('button', { class: 'btn sm ' + cls, onclick: () => { A.act(name); toast(label + '…'); } }, label);
    const hand = (label, name, cls, msg) => h('button', { class: 'btn ' + cls, onclick: async () => { if (await confirmSheet({ title: label, message: msg, okText: label, danger: name !== 'buy' && name !== 'sell' })) A.act(name); } }, label);

    clear(root()).append(h('div', { class: 'inner' },
      h('div', { class: 'h1' }, 'Kanairy'), h('p', { class: 'lead' }, 'Open MT5, launch Kanairy, switch Auto on. It reads the chart, runs your strategy and places the trades.'),
      !native ? h('div', { class: 'card', style: { marginBottom: '12px' } }, h('b', {}, 'Preview only'), h('div', { class: 'hint' }, 'Install the Kanairy app on your phone to trade. This is the browser preview.')) : null,

      h('div', { class: 'card hero ' + (sig === 'BUY' ? 'buy' : sig === 'SELL' ? 'sell' : '') },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'lbl' }, st.symbol ? `${st.symbol}${st.tf ? ' · ' + st.tf : ''}` : 'Waiting for MT5'), h('div', { class: 'sig' }, sig)),
          h('div', { style: { textAlign: 'right' } }, h('div', { class: 'lbl' }, 'Price'), h('div', { class: 'px2' }, st.price || '—'))),
        h('div', { class: 'hint', style: { whiteSpace: 'pre-line' } }, st.info || 'No scan yet. Press Scan now.'),
        h('div', { class: 'chips', style: { marginTop: '10px' } }, h('span', { class: 'chip' }, `${st.candles || 0} candles read`), h('span', { class: 'chip' }, st.strategy ? `Lab: ${st.strategy}` : 'No lab strategy'), h('span', { class: 'chip' }, `${st.open ?? 0} open · ${st.today ?? 0} today`))),

      st.problem ? h('div', { class: 'card problem' }, h('b', {}, 'Needs attention'), h('div', { class: 'hint' }, st.problem)) : null,
      st.problem ? h('div', { style: { height: '12px' } }) : null,
      h('div', { style: { height: '12px' } }),
      h('div', { class: 'card' },
        tog('Auto trading', st.auto ? (st.dry ? 'On in Paper mode: decisions are logged, no orders.' : 'On and LIVE: orders are placed in MT5.') : 'Off. Turn on to scan and trade by itself.', !!st.auto, v => { A.setAuto(v); }),
        tog('Live orders', 'Off = Paper mode. Test on a demo account first.', !st.dry, v => { A.setFlag('dry', !v); }),
        tog('Scalp mode', 'Fast scans, tight stops, several trades, time stop. Use a 1 minute chart.', !!st.scalp, v => { A.act(v ? 'scalp_on' : 'scalp_off'); }),
        h('div', { class: 'setting col' }, h('div', { class: 'grow' }, h('div', { class: 't' }, 'Decision engine'), h('div', { class: 'd' }, 'Strategy lab trades your active XML. Both agree also needs the built-in confluence score.')),
          h('div', { class: 'seg wide' }, MODES.map(([k, l]) => h('button', { 'aria-pressed': String(st.mode === k), onclick: () => { A.setCfg('mode', k); st.mode = k; render(); } }, l))))),

      h('div', { style: { height: '16px' } }),
      h('div', { class: 'h2' }, 'Hands'),
      h('div', { class: 'card stack' },
        h('div', { class: 'hint' }, 'Direct control. These act now, even in Paper mode, using the lot size from Settings. Kanairy opens MT5 and does it for you.'),
        h('div', { class: 'two' }, hand('Buy now', 'buy', 'primary', 'Kanairy will open MT5 and place a BUY with your lot size and an ATR stop.'), hand('Sell now', 'sell', 'danger', 'Kanairy will open MT5 and place a SELL with your lot size and an ATR stop.')),
        h('div', { class: 'two' }, hand('Close all', 'close', '', 'Kanairy will close every open trade in MT5.'), hand('Stop everything', 'stop', 'danger', 'Auto trading turns off and every open trade is closed.'))),
      h('div', { style: { height: '12px' } }),
      h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, act('Scan now', 'scan', 'primary'), act('Show overlay', 'overlay'), act('Open MT5', 'mt5'), act('Teach New Order button', 'teach'), act('Debug image', 'debug'), act('UI dump', 'dump')),

      h('div', { style: { height: '16px' } }),
      h('div', { class: 'h2' }, 'Setup'),
      h('div', { class: 'card' },
        step(!!st.svc, 'Accessibility service', st.svc ? 'Running.' : 'Needed to read the chart and tap MT5. Allow restricted settings first, then switch Kanairy on.', 'Allow restricted', 'appinfo'),
        st.svc ? null : step(false, 'Turn it on', 'Accessibility, Installed apps, Kanairy, On.', 'Open', 'a11y'),
        step(!!st.mt5, 'MT5 on screen', st.mt5 ? 'MT5 is in front.' : 'Open MT5 on a candlestick chart.', 'Open MT5', 'mt5'),
        step(!!st.battery, 'Battery', st.battery ? 'Unrestricted.' : 'Set to Unrestricted so Samsung keeps it alive.', 'Fix', 'battery')),

      h('div', { style: { height: '16px' } }),
      h('div', { class: 'h2' }, 'Live log'),
      h('div', { class: 'card logbox' }, (st.log && st.log.length ? st.log : ['Nothing yet.']).map(l => h('div', {}, l)))));
  };
  hooks.onHome = render;
  on('status', s => { st = s; if (document.body.dataset.screen === 'home') render(); });
  render();
}
