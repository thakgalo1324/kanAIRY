// App bootstrap: routing, navigation, alerts, theme.
import { h, icon, clear, toast } from './util.js';
import { S, on, emit, persist } from './state.js';
import { loadInstruments, startPolling, stopPolling, mid } from './market.js';
import { closeAllSheets } from './ui.js';
import { hooks, mountWatchlist, mountChart, selectSymbol } from './terminal.js';
import { mountMt5Web, refreshMt5Web } from './mt5web.js';
import * as scr from './screens.js';

const $ = id => document.getElementById(id);
const TERMINAL = ['quotes', 'chart', 'trade'];
const NAV_MAIN = [['quotes', 'Markets', 'quotes'], ['chart', 'Chart', 'chart'], ['trade', 'Trade', 'trade'], ['more', 'More', 'menu']];
const MENU = [['news', 'News', 'news'], ['calendar', 'Calendar', 'cal'], ['strategies', 'Strategy lab', 'flask'], ['learn', 'Learn', 'book'], ['assistant', 'AI assistant', 'bot'], ['settings', 'Settings', 'gear'], ['about', 'About', 'info'], ['developer', 'Developer', 'user']];
const SCREENS = [...TERMINAL, ...MENU.map(m => m[0])];

// ---------- theme ----------
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  if (S.settings.colorblind) document.documentElement.dataset.cb = '1'; else delete document.documentElement.dataset.cb;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', S.settings.theme === 'dark' ? '#0b0d11' : '#ffffff');
  emit('theme');
}
on('settings', applyTheme);

// ---------- routing ----------
function showScreen(name) {
  if (!SCREENS.includes(name)) name = 'chart';
  closeAllSheets(); document.body.classList.remove('drawer-open');
  document.body.dataset.screen = name;
  document.body.dataset.group = TERMINAL.includes(name) ? 'terminal' : 'page';
  document.querySelectorAll('#rail button, #bottomNav button').forEach(b => b.dataset.k === name || (b.dataset.k === 'more' && !TERMINAL.includes(name)) ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (TERMINAL.includes(name)) hooks.visible?.();
  refreshMt5Web();
  const fn = { news: 'onNews', calendar: 'onCalendar', strategies: 'onStrategies', settings: 'onSettings', assistant: 'onAssistant' }[name];
  if (fn) hooks[fn]?.();
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
  scrollTo(0, 0);
}
hooks.showScreen = showScreen;
hooks.setSymbol = selectSymbol;

function buildNav() {
  const mk = ([k, l, i]) => h('button', { 'data-k': k, onclick: () => k === 'more' ? openDrawer() : showScreen(k) }, icon(i, 22), h('span', {}, l));
  clear($('bottomNav')).append(...NAV_MAIN.map(mk));
  // Desktop rail: terminal group + pages. Markets/Trade are always visible in the 3-column grid.
  clear($('rail')).append(mk(['chart', 'Terminal', 'chart']), ...MENU.slice(0, 3).map(mk), mk(['settings', 'Settings', 'gear']), mk(['learn', 'Learn', 'book']), mk(['assistant', 'AI', 'bot']));
}
function openDrawer() {
  const d = clear($('drawer'));
  d.append(h('div', { class: 'row', style: { padding: '14px 16px' } }, h('b', { class: 'grow' }, 'KanAIRY'), h('button', { class: 'icon-btn', 'aria-label': 'Close menu', onclick: () => document.body.classList.remove('drawer-open') }, icon('x', 20))),
    ...MENU.map(([k, l, i]) => h('button', { class: 'drawer-item', onclick: () => showScreen(k) }, icon(i, 20), l)));
  document.body.classList.add('drawer-open');
}
$('drawerScrim').addEventListener('click', () => document.body.classList.remove('drawer-open'));
$('btnMenu').append(icon('menu', 22)); $('btnMenu').onclick = openDrawer;
$('btnAlerts').append(icon('bell', 22), h('span', { class: 'dot hide', id: 'alertDot' }));
$('btnAlerts').onclick = () => scr.openAlerts();
$('btnTheme').onclick = () => { S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; persist(); applyTheme(); drawThemeBtn(); };
const drawThemeBtn = () => { clear($('btnTheme')).append(icon(S.settings.theme === 'dark' ? 'sun' : 'moon', 22)); };

// ---------- status chip ----------
// Prices are public and delayed; the chip shows whether the price feed is reachable and opens the MT5 terminal.
function paintStatus() {
  $('acctLbl').textContent = 'Public prices';
  $('acctVal').textContent = S.online ? 'Trade in MT5 Web' : 'Reconnecting…';
  $('statusDot').className = 'status' + (S.online ? ' live' : ' bad');
}
on('online', paintStatus);
$('acctChip').onclick = () => showScreen('trade');

async function init() {
  stopPolling();
  S.quotes = {}; S.instruments = []; S.online = true;
  paintStatus();
  try { await loadInstruments(); } catch (e) {
    toast('Could not reach the price server, so only a built-in symbol list is shown. ' + e.message, 'error');
  }
  if (!S.instruments.find(i => i.symbol === S.symbol) && S.instruments.length) selectSymbol((S.instruments.find(i => /^EURUSD/.test(i.symbol)) || S.instruments[0]).symbol);
  emit('mode'); startPolling(); paintStatus();
}

// ---------- alerts ----------
function checkAlerts() {
  let fired = false;
  for (const a of S.alerts) {
    if (a.fired) continue;
    const p = mid(a.symbol); if (p == null) continue;
    const hit = a.dir === 'above' ? p >= a.price : p <= a.price;
    if (hit) {
      a.fired = true; a.firedAt = Date.now(); fired = true;
      const msg = `${a.symbol} ${a.dir === 'above' ? 'rose to' : 'fell to'} ${a.price}`;
      toast('🔔 ' + msg, 'ok');
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('KanAIRY price alert', { body: msg }); } catch { /* ignore */ }
    }
  }
  if (fired) { persist(); emit('alerts'); }
}
function paintAlertDot() { $('alertDot').classList.toggle('hide', !S.alerts.some(a => !a.fired)); }
on('quotes', checkAlerts); on('alerts', paintAlertDot); 

// ---------- boot ----------
async function boot() {
  applyTheme(); drawThemeBtn(); buildNav();
  mountWatchlist($('panelQuotes')); mountChart($('panelChart')); mountMt5Web($('panelMt5'));
  scr.mountNews(); scr.mountCalendar(); scr.mountStrategies(); scr.mountLearn(); scr.mountAbout(); scr.mountDeveloper(); scr.mountAssistant(); scr.mountSettings();
  paintAlertDot();
  const start = location.hash.slice(1);
  showScreen(SCREENS.includes(start) ? start : 'chart');
  addEventListener('hashchange', () => { const n = location.hash.slice(1); if (SCREENS.includes(n) && n !== document.body.dataset.screen) showScreen(n); });
  addEventListener('resize', () => emit('resize'));
  addEventListener('online', () => { S.online = true; emit('online'); }); addEventListener('offline', () => { S.online = false; emit('online'); });
  await init();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
window.__kanairyBooted = true;   // modules loaded and evaluated; the boot watchdog in index.html stands down
boot().catch(e => { console.error(e); window.__kanairyFail?.('The app hit an error while starting.', e && (e.stack || e.message)); });
