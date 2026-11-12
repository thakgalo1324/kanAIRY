// App bootstrap: routing, navigation, theme, live status.
import { h, icon, clear } from './util.js';
import { S, on, emit, persist } from './state.js';
import { loadInstruments } from './market.js';
import { closeAllSheets } from './ui.js';
import { hooks } from './hooks.js';
import { A } from './bridge.js';
import { mountHome } from './home.js';
import { mountActivity } from './activity.js';
import * as scr from './screens.js';

const $ = id => document.getElementById(id);
const NAV_MAIN = [['home', 'Home', 'trade'], ['strategies', 'Strategy lab', 'flask'], ['activity', 'Activity', 'list'], ['more', 'More', 'menu']];
const MENU = [['news', 'News', 'news'], ['calendar', 'Calendar', 'cal'], ['strategies', 'Strategy lab', 'flask'], ['learn', 'Learn', 'book'], ['assistant', 'AI assistant', 'bot'], ['settings', 'Settings', 'gear'], ['about', 'About', 'info'], ['developer', 'Developer', 'user']];
const SCREENS = ['home', 'activity', ...MENU.map(m => m[0])];

function applyTheme() {
  document.documentElement.dataset.theme = S.settings.theme;
  if (S.settings.colorblind) document.documentElement.dataset.cb = '1'; else delete document.documentElement.dataset.cb;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', S.settings.theme === 'dark' ? '#0b0d11' : '#ffffff');
  emit('theme');
}
on('settings', applyTheme);

function showScreen(name) {
  if (!SCREENS.includes(name)) name = 'home';
  closeAllSheets(); document.body.classList.remove('drawer-open');
  document.body.dataset.screen = name;
  document.querySelectorAll('#rail button, #bottomNav button').forEach(b => b.dataset.k === name || (b.dataset.k === 'more' && !NAV_MAIN.some(n => n[0] === name)) ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  const fn = { home: 'onHome', activity: 'onActivity', news: 'onNews', calendar: 'onCalendar', strategies: 'onStrategies', settings: 'onSettings', assistant: 'onAssistant' }[name];
  if (fn) hooks[fn]?.();
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
  scrollTo(0, 0);
}
hooks.showScreen = showScreen;

function buildNav() {
  const mk = ([k, l, i]) => h('button', { 'data-k': k, onclick: () => k === 'more' ? openDrawer() : showScreen(k) }, icon(i, 22), h('span', {}, l));
  clear($('bottomNav')).append(...NAV_MAIN.map(mk));
  clear($('rail')).append(mk(['home', 'Home', 'trade']), mk(['strategies', 'Lab', 'flask']), mk(['activity', 'Activity', 'list']), mk(['news', 'News', 'news']), mk(['settings', 'Settings', 'gear']));
}
function openDrawer() {
  const d = clear($('drawer'));
  d.append(h('div', { class: 'row', style: { padding: '14px 16px' } }, h('b', { class: 'grow' }, 'Kanairy'), h('button', { class: 'icon-btn', 'aria-label': 'Close menu', onclick: () => document.body.classList.remove('drawer-open') }, icon('x', 20))),
    ...[['home', 'Home', 'trade'], ['activity', 'Activity', 'list'], ...MENU].map(([k, l, i]) => h('button', { class: 'drawer-item', onclick: () => showScreen(k) }, icon(i, 20), l)));
  document.body.classList.add('drawer-open');
}
$('drawerScrim').addEventListener('click', () => document.body.classList.remove('drawer-open'));
$('btnMenu').append(icon('menu', 22)); $('btnMenu').onclick = openDrawer;
$('btnTheme').onclick = () => { S.settings.theme = S.settings.theme === 'dark' ? 'light' : 'dark'; persist(); applyTheme(); drawThemeBtn(); };
const drawThemeBtn = () => { clear($('btnTheme')).append(icon(S.settings.theme === 'dark' ? 'sun' : 'moon', 22)); };
$('acctChip').onclick = () => showScreen('home');

function paintStatus(s) {
  const live = s.svc && s.auto;
  $('acctLbl').textContent = !s.svc ? 'Service off' : s.auto ? (s.dry ? 'Auto · Paper' : 'Auto · LIVE') : 'Ready';
  $('acctVal').textContent = !s.svc ? 'Finish setup' : (s.action || 'WAIT') + (s.symbol ? ' · ' + s.symbol : '');
  $('statusDot').className = 'status' + (live ? (s.dry ? ' live' : ' bad') : s.svc ? ' live' : '');
}
on('status', paintStatus);
function poll() { const s = A.status(); emit('status', s); }

window.__back = () => {
  if (document.body.classList.contains('drawer-open')) { document.body.classList.remove('drawer-open'); return true; }
  if (document.querySelector('#sheetRoot.open')) { closeAllSheets(); return true; }
  if (document.body.dataset.screen !== 'home') { showScreen('home'); return true; }
  return false;
};

async function boot() {
  applyTheme(); drawThemeBtn(); buildNav();
  mountHome(); mountActivity(); scr.mountNews(); scr.mountCalendar(); scr.mountStrategies(); scr.mountLearn(); scr.mountAbout(); scr.mountDeveloper(); scr.mountAssistant(); scr.mountSettings();
  const start = location.hash.slice(1);
  showScreen(SCREENS.includes(start) ? start : 'home');
  addEventListener('hashchange', () => { const n = location.hash.slice(1); if (SCREENS.includes(n) && n !== document.body.dataset.screen) showScreen(n); });
  poll(); setInterval(() => { if (!document.hidden) poll(); }, 1000);
  try { await loadInstruments(); } catch { /* offline: the lab works once the phone is online */ }
}
window.__kanairyBooted = true;
boot().catch(e => { console.error(e); window.__kanairyFail?.('The app hit an error while starting.', e && (e.stack || e.message)); });
