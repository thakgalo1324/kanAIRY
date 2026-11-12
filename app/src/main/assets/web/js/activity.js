// Activity: every signal, order and decision the robot made.
import { h, clear, dt } from './util.js';
import { A } from './bridge.js';
import { hooks } from './hooks.js';

export function mountActivity() {
  const render = () => {
    const ev = A.events();
    clear(document.getElementById('view-activity')).append(h('div', { class: 'inner' },
      h('div', { class: 'h1' }, 'Activity'), h('p', { class: 'lead' }, 'Signals, orders and exits, newest first.'),
      h('div', { class: 'card' }, ev.length ? ev.map(e => h('div', { class: 'setting' },
        h('span', { class: 'pill kind ' + (e.kind === 'BUY' ? 'buy' : e.kind === 'SELL' || e.kind === 'ERROR' ? 'sell' : '') }, e.kind),
        h('div', { class: 'grow' }, h('div', { class: 't' }, e.text), h('div', { class: 'd' }, dt(e.t / 1000))))) : h('div', { class: 'empty' }, h('b', {}, 'Nothing yet'), 'Turn Auto on from Home.'))));
  };
  hooks.onActivity = render;
}
