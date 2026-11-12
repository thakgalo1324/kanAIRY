import { h } from '../util.js';
export { h };

const P = {
  live: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/>',
  strategy: '<path d="M4 18l5-6 4 3 7-9"/><path d="M4 21h16"/>',
  account: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4"/>',
  setup: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  up: '<path d="M7 14l5-5 5 5"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  upload: '<path d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14"/>',
};
export function icon(name, size = 22) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || '';
  return s;
}

let tt;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3400);
}

export function sheet({ title, body, actions }) {
  const sh = document.getElementById('sheet'), sc = document.getElementById('scrim');
  sh.replaceChildren(h('div', { class: 'grab' }), h('h2', {}, title), h('div', { class: 'mute', style: { marginBottom: '20px' } }, body), h('div', { class: 'btns', style: { marginTop: 0 } }, actions.map(a =>
    h('button', { class: 'btn ' + (a.solid ? 'solid' : 'ghost') + ' grow', onclick: () => { close(); a.run && a.run(); } }, a.label))));
  const close = () => { sh.classList.remove('on'); sc.classList.remove('on'); };
  sc.onclick = close;
  requestAnimationFrame(() => { sh.classList.add('on'); sc.classList.add('on'); });
  return close;
}

export const fmt = (v, d = 2) => (v == null || Number.isNaN(+v) ? '–' : (+v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
export const px = v => (!v ? '–' : (+v >= 100 ? (+v).toFixed(2) : (+v).toFixed(5)));
export const sgn = v => (v >= 0 ? '+' : '−') + fmt(Math.abs(v));
export const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
}
export function toggle(on, onchange, label) {
  const b = h('button', { class: 'sw' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on), 'aria-label': label });
  b.onclick = () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); onchange(v); };
  return b;
}
