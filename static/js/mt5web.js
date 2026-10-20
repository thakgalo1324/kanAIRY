// MetaQuotes MT5 Web Terminal panel. This is where people log in with their broker and trade. The terminal comes
// from MetaQuotes' own domain, so this page cannot read or control it: charts, news, alerts and the Strategy lab
// stay KanAIRY's, while orders, positions and the account live inside the terminal.
import { h, clear } from './util.js';
import { S, on } from './state.js';

// MetaQuotes' documented embed address (mql5.com article 3024, "Embed MetaTrader 4/5 WebTerminal on your website").
// The old trade.mql5.com address now only redirects here.
export const DEFAULT_MT5_URL = 'https://metatraderweb.app/trade?demo_all_servers=1&startup_mode=open_demo&startup_version=5&lang=en&save_password=off';

export function terminalUrl() {
  const u = String(S.settings.mt5Url || '').trim();
  if (!/^https:\/\//i.test(u)) return DEFAULT_MT5_URL;
  return u.replace(/^https:\/\/trade\.mql5\.com\//i, 'https://metatraderweb.app/');   // MetaQuotes moved the web terminal
}

let panelEl = null, shownUrl = '';

const wide = () => matchMedia('(min-width: 1000px)').matches;
let forceEmbed = false;

// Phones: MetaQuotes' terminal often hangs when it is shown inside another page (browsers block the storage it needs),
// so on a phone the Trade tab is a launcher that opens it as its own page. "Load it here" still tries the embedded one.
function renderLauncher(url) {
  clear(panelEl).append(h('div', { class: 'mt5-launch' },
    h('b', {}, 'Trade with MT5'),
    h('p', {}, 'The MetaTrader 5 terminal opens as its own page, so it loads reliably on your phone. Log in with your broker there, then come back here for charts, alerts and news.'),
    h('a', { class: 'btn primary block', href: url, target: '_blank', rel: 'noopener' }, 'Open MT5 terminal'),
    h('button', { class: 'btn block', onclick: () => { forceEmbed = true; shownUrl = ''; render(); } }, 'Load it here instead'),
    h('p', { class: 'hint' }, 'Your password goes to MetaQuotes and your broker, not to KanAIRY. Using your broker\u2019s own web terminal? Set its address in Settings.')));
}

function render() {
  const url = terminalUrl();
  shownUrl = url;
  if (!wide() && !forceEmbed) { renderLauncher(url); return; }
  const status = h('div', { class: 'mt5-status' }, 'Loading the MT5 terminal\u2026');
  const frame = h('iframe', { class: 'mt5-frame', src: url, title: 'MetaTrader 5 Web Terminal', allow: 'fullscreen; clipboard-write', allowfullscreen: '' });
  let slow = null;
  frame.addEventListener('load', () => { clearTimeout(slow); status.remove(); });
  slow = setTimeout(() => {
    if (!status.isConnected) return;
    clear(status).append(h('span', {}, 'Still loading. Some devices and networks block the terminal inside another page. '),
      h('a', { class: 'btn sm primary', href: url, target: '_blank', rel: 'noopener' }, 'Open it in a new tab'));
  }, 12000);
  clear(panelEl).append(
    h('div', { class: 'mt5-bar' }, h('b', {}, 'MT5 Web terminal'), h('span', { class: 'grow' }),
      h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener' }, 'Open in new tab')),
    h('div', { class: 'mt5-note' }, 'Log in with any broker that supports the MetaQuotes web terminal. Your password goes to MetaQuotes and your broker, not to KanAIRY.'),
    status, frame);
}

// Load the terminal only once its panel is actually on screen (it is heavy), and again if the address changes.
export function refreshMt5Web() {
  if (!panelEl) return;
  const visible = panelEl.getClientRects().length > 0;
  if (visible && ((!panelEl.querySelector('iframe') && !panelEl.querySelector('.mt5-launch')) || shownUrl !== terminalUrl())) render();
}

export function mountMt5Web(panel) {
  panelEl = panel;
  on('settings', () => setTimeout(refreshMt5Web, 0));
  on('resize', refreshMt5Web);
    }
