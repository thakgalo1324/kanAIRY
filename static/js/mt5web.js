// MT5 Web Terminal panel. This is where people log in with their broker and trade.
//
// How MetaQuotes' web terminal works today: every broker runs its own web terminal on its own address (MetaQuotes' pages
// say it "operates as an individual web terminal, which only works with a specific broker's platform"). The old shared
// terminals (trade.mql5.com, metatraderweb.app) only serve the MetaQuotes demo server and are no longer a way to log in
// with any broker. So the person pastes their broker's web terminal address once; until then the official MetaQuotes
// demo terminal (web.metatrader.app) is used.
//
// The terminal is a page on another domain, so KanAIRY cannot read or control it. It opens as its own page by default,
// because browsers and brokers often block it inside another page; "Show it here" tries embedding it.
import { h, clear, toast } from './util.js';
import { S, on, emit, persist } from './state.js';

export const DEFAULT_MT5_URL = 'https://web.metatrader.app/terminal?mode=demo&lang=en';
const LEGACY = /^https:\/\/(trade\.mql5\.com|metatraderweb\.app)\//i;

export const hasBrokerUrl = () => /^https:\/\//i.test(String(S.settings.mt5Url || '').trim()) && !LEGACY.test(String(S.settings.mt5Url).trim());
export function terminalUrl() {
  const u = String(S.settings.mt5Url || '').trim();
  return hasBrokerUrl() ? u : DEFAULT_MT5_URL;
}

let panelEl = null, shownKey = '';

function cleanUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); if (x.protocol !== 'https:') return ''; return x.toString(); } catch { return ''; }
}

function addressForm() {
  const input = h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: 'https://webtrader.your-broker.com', value: hasBrokerUrl() ? S.settings.mt5Url : '', 'aria-label': 'Your broker web terminal address' });
  const save = () => {
    const u = cleanUrl(input.value);
    if (input.value.trim() && !u) { toast('Enter a full https:// address.', 'error'); return; }
    S.settings.mt5Url = u; persist(); emit('settings'); toast(u ? 'Broker terminal saved' : 'Using the MetaQuotes demo terminal', 'ok');
  };
  return h('div', { class: 'stack' },
    h('label', { class: 'lbl' }, 'Your broker’s web terminal address'),
    input,
    h('div', { class: 'row', style: { gap: '10px' } }, h('button', { class: 'btn sm primary', onclick: save }, 'Save address'),
      hasBrokerUrl() ? h('button', { class: 'btn sm', onclick: () => { input.value = ''; save(); } }, 'Use demo terminal') : null));
}

function renderLauncher() {
  const url = terminalUrl(), own = hasBrokerUrl();
  clear(panelEl).append(h('div', { class: 'mt5-launch' },
    h('b', {}, own ? 'Trade with your broker' : 'Trade with MT5'),
    h('p', {}, own ? 'Your broker’s MetaTrader 5 web terminal opens as its own page. Log in there, then come back for charts, alerts and news.'
      : 'MetaQuotes now runs the web terminal separately for each broker. Paste your broker’s web terminal address below to log in with your real or demo account. Until then you can try MetaQuotes’ own demo terminal.'),
    h('a', { class: 'btn primary block', href: url, target: '_blank', rel: 'noopener' }, own ? 'Open my broker terminal' : 'Open MetaQuotes demo terminal'),
    h('button', { class: 'btn block', onclick: () => { S.settings.mt5Embed = true; persist(); emit('settings'); } }, 'Show it here instead'),
    addressForm(),
    h('p', { class: 'hint' }, 'Where to find the address: sign in to your broker’s website or client area and look for “Web terminal”, “WebTrader” or “MT5 Web”, then copy that page’s address. Your password goes to your broker, not to KanAIRY.')));
}

function renderEmbedded() {
  const url = terminalUrl();
  const status = h('div', { class: 'mt5-status' }, 'Loading the MT5 terminal…');
  const frame = h('iframe', { class: 'mt5-frame', src: url, title: 'MetaTrader 5 Web Terminal', allow: 'fullscreen; clipboard-write', allowfullscreen: '' });
  let slow = null;
  frame.addEventListener('load', () => { clearTimeout(slow); status.remove(); });
  slow = setTimeout(() => {
    if (!status.isConnected) return;
    clear(status).append(h('span', {}, 'Still loading. Many brokers and browsers block the terminal inside another page. '),
      h('a', { class: 'btn sm primary', href: url, target: '_blank', rel: 'noopener' }, 'Open it as its own page'));
  }, 10000);
  clear(panelEl).append(
    h('div', { class: 'mt5-bar' }, h('b', {}, 'MT5 Web terminal'), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => { S.settings.mt5Embed = false; persist(); emit('settings'); } }, 'Back'),
      h('a', { class: 'btn sm', href: url, target: '_blank', rel: 'noopener' }, 'Open in new tab')),
    status, frame);
}

function render() {
  shownKey = terminalUrl() + '|' + (S.settings.mt5Embed ? 'e' : 'l');
  if (S.settings.mt5Embed) renderEmbedded(); else renderLauncher();
}

// Draw (or redraw after a change) once the panel is actually on screen.
export function refreshMt5Web() {
  if (!panelEl) return;
  const visible = panelEl.getClientRects().length > 0;
  const key = terminalUrl() + '|' + (S.settings.mt5Embed ? 'e' : 'l');
  if (visible && (!panelEl.firstChild || key !== shownKey)) render();
}

export function mountMt5Web(panel) {
  panelEl = panel;
  on('settings', () => setTimeout(refreshMt5Web, 0));
  on('resize', refreshMt5Web);
                            }
