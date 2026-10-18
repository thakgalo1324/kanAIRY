// MetaQuotes MT5 Web Terminal panel. It replaces the built-in order ticket and positions list when
// Settings > Trading panel is "MT5 Web". The terminal comes from MetaQuotes' own domain, so this page cannot read
// or control it: the person logs in and trades inside it, while charts, news, alerts and the Strategy lab stay ours.
import { h, clear } from './util.js';
import { S, on } from './state.js';

// MetaQuotes' documented widget address (mql5.com article "Embed MetaTrader 4/5 WebTerminal on your website").
export const DEFAULT_MT5_URL = 'https://trade.mql5.com/trade?version=5&lang=en&save_password=off&trade_server=MetaQuotes-Demo';

export const mt5Mode = () => S.settings.tradeMode !== 'builtin';
export function terminalUrl() {
  const u = String(S.settings.mt5Url || '').trim();
  return /^https:\/\//i.test(u) ? u : DEFAULT_MT5_URL;
}

let panelEl = null, shownUrl = '';

function render() {
  const url = terminalUrl();
  shownUrl = url;
  clear(panelEl).append(
    h('div', { class: 'mt5-bar' }, h('b', {}, 'MT5 Web terminal'), h('span', { class: 'grow' }),
      h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener' }, 'Open in new tab')),
    h('div', { class: 'mt5-note' }, 'Log in with any broker that supports the MetaQuotes web terminal. Your password goes to MetaQuotes and your broker, not to KanAIRY. If this stays blank, tap “Open in new tab”.'),
    h('iframe', { class: 'mt5-frame', src: url, title: 'MetaTrader 5 Web Terminal', allow: 'fullscreen; clipboard-write', referrerpolicy: 'strict-origin-when-cross-origin' }));
}

// Load the terminal only once its panel is actually on screen (it is heavy), and again if the address changes.
export function refreshMt5Web() {
  if (!panelEl || !mt5Mode()) return;
  const visible = panelEl.getClientRects().length > 0;
  if (visible && (!panelEl.querySelector('iframe') || shownUrl !== terminalUrl())) render();
}

export function mountMt5Web(panel) {
  panelEl = panel;
  on('settings', () => setTimeout(refreshMt5Web, 0));
  on('resize', refreshMt5Web);
    }
