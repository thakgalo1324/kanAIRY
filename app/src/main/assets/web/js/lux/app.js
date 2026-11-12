import { h, icon } from './ui.js';
import { B } from './native.js';
import { toast } from './ui.js';
import { mountLive } from './live.js';
import { mountStrategy } from './strategy.js';
import { mountAccount } from './account.js';
import { mountSetup } from './setup.js';

const $ = id => document.getElementById(id);
const TABS = [['live', 'Live'], ['strategy', 'Strategy'], ['account', 'Account'], ['setup', 'Setup']];
let cur = 'live', live, account, setup, strategy;

function theme() { try { return localStorage.getItem('kanairy.lux.theme') || 'dark'; } catch { return 'dark'; } }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#ffffff' : '#000000');
  try { localStorage.setItem('kanairy.lux.theme', t); } catch { /* storage blocked */ }
}
applyTheme(theme());

// Cards float in one after another, and the highlight in the bar glides to the tab.
function stagger(name) {
  requestAnimationFrame(() => $('s-' + name).querySelectorAll('h1, .lead, .hero, .crownwrap, .hint, .card, .trio').forEach((el, i) => el.style.setProperty('--i', Math.min(i, 9))));
}
function placeInd() {
  const nav = $('nav'), ind = nav.querySelector('.ind'), b = nav.querySelector('button[aria-current]');
  if (!ind || !b) return;
  ind.style.width = b.offsetWidth + 'px'; ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
}
addEventListener('resize', () => placeInd());

function go(name) {
  cur = name;
  TABS.forEach(([k]) => $('s-' + k).classList.toggle('on', k === name));
  $('nav').querySelectorAll('button').forEach(b => (b.dataset.k === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  if (name === 'strategy') strategy.render();
  if (name === 'account') account.render();
  if (name === 'setup') setup.render();
  if (name === 'live') live.tick();
  stagger(name); placeInd();
  scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + name); } catch { /* ignore */ }
}

function setPill(kind, text) {
  const p = $('conn');
  p.classList.toggle('live', kind === 'live' || kind === 'ready');
  $('connTxt').textContent = text;
}

$('nav').replaceChildren(h('span', { class: 'ind' }), ...TABS.map(([k, l]) => h('button', { 'data-k': k, onclick: () => go(k) }, icon(k, 22), h('span', {}, l))));
B.onError = toast;
live = mountLive($('s-live'), go, setPill);
strategy = mountStrategy($('s-strategy'), () => live.tick());
account = mountAccount($('s-account'), () => live.tick());
setup = mountSetup($('s-setup'), applyTheme, theme);

window.__go = go;
window.__back = () => { if (cur !== 'live') { go('live'); return true; } return false; };
const start = location.hash.slice(1);
go(TABS.some(t => t[0] === start) ? start : 'live');
setInterval(() => { if (!document.hidden && cur === 'live') live.tick(); }, 1000);
window.__luxOk = true;
